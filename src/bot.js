import { telegram, boundedBytes } from './api.js';
import { analyze, prepareImage } from './analysis.js';
import { crops, copy, cropKeyboard, menu, renderResult, messageChunks } from './ui.js';

export class Bot {
  constructor(config, store, overrides = {}) {
    this.config = config; this.store = store;
    this.call = overrides.call || ((method, body) => telegram(config.token, method, body));
    this.analyze = overrides.analyze || analyze;
    this.prepare = overrides.prepare || prepareImage;
    this.download = overrides.download || (async file => {
      const info = await this.call('getFile', { file_id: file.file_id });
      if (info.file_size > 8 * 1024 * 1024 || !info.file_path) throw new Error('Invalid image');
      const response = await fetch(`https://api.telegram.org/file/bot${config.token}/${info.file_path}`, { signal: AbortSignal.timeout(20000) });
      return boundedBytes(response, 8 * 1024 * 1024);
    });
    this.active = new Set(); this.sessions = new Map(); this.pending = new Set(); this.tasks = new Set(); this.accepting = true;
  }
  async say(id, text, keyboard) {
    const chunks = messageChunks(text);
    let sent;
    for (const [i, chunk] of chunks.entries()) {
      sent = await this.call('sendMessage', { chat_id: id, text: chunk, parse_mode: 'HTML', ...(keyboard && i === chunks.length - 1 ? { reply_markup: keyboard } : {}), link_preview_options: { is_disabled: true } });
    }
    return sent;
  }
  enqueue(update) {
    if (!Number.isSafeInteger(update?.update_id)) return false;
    if (this.store.seen(update.update_id) || this.pending.has(update.update_id)) return true;
    if (!this.accepting || this.pending.size >= 30) return false;
    this.pending.add(update.update_id);
    const task = this.handle(update).then(() => this.store.mark(update.update_id)).catch(() => {
      // Deliberately do not log HTTP errors, tokens, image bytes or user content.
      console.error('Update handling failed; no private data logged.');
    }).finally(() => { this.pending.delete(update.update_id); this.tasks.delete(task); });
    this.tasks.add(task);
    return true;
  }
  async drain() { this.accepting = false; await Promise.allSettled([...this.tasks]); }
  async handle(update) {
    const expired = Date.now() - 30 * 60 * 1000;
    for (const [chatId, session] of this.sessions) if (session.updated < expired) this.sessions.delete(chatId);
    const cb = update.callback_query;
    const msg = cb?.message || update.message;
    if (!msg?.chat || !msg.from && !cb?.from) return;
    const id = msg.chat.id;
    if (msg.chat.type !== 'private') return; // Do not analyze photos in groups.
    const sender = cb?.from || msg.from;
    const existing = this.store.get(id);
    const u = existing || this.store.save(id, { language: sender.language_code?.startsWith('kk') ? 'kk' : 'ru' });
    const lang = u.language, t = copy[lang];
    const command = cb?.data || msg.text?.split(/\s/)[0]?.split('@')[0]?.replace(/^\//, '') || '';
    if (cb) await this.call('answerCallbackQuery', { callback_query_id: cb.id });
    if (!existing && command !== 'start') return this.say(id, t.welcome + '\n\n' + t.ready, cropKeyboard(lang));
    if (command === 'start') return this.say(id, t.welcome, cropKeyboard(lang));
    if (command === 'language') return this.say(id, 'Тілді таңдаңыз / Выберите язык', { inline_keyboard: [[{ text: 'Қазақша', callback_data: 'lang:kk' }, { text: 'Русский', callback_data: 'lang:ru' }]] });
    if (['lang:ru', 'lang:kk'].includes(command)) {
      const selected = command.slice(5); this.store.save(id, { language: selected });
      return this.say(id, copy[selected].welcome, cropKeyboard(selected));
    }
    if (command === 'crop') return this.say(id, t.choose, cropKeyboard(lang));
    if (command.startsWith('crop:') && crops[command.slice(5)]) {
      this.store.save(id, { crop: command.slice(5) });
      return this.say(id, `${crops[command.slice(5)][lang === 'kk' ? 1 : 0]}\n\n${t.ready}`, menu(lang));
    }
    if (command === 'photo') return this.say(id, t.ready, menu(lang));
    if (command === 'help') return this.say(id, t.help, menu(lang));
    if (command === 'privacy') return this.say(id, t.privacy, menu(lang));
    if (command === 'history') return this.say(id, u.last || t.noHistory, menu(lang));
    if (command === 'delete') {
      if (this.active.has(id)) return this.say(id, t.busy);
      this.sessions.delete(id);
      this.store.delete(id); return this.say(id, t.deleted);
    }
    if (msg.text?.trim() && !msg.text.startsWith('/') && this.sessions.has(id)) {
      if (this.active.has(id)) return this.say(id, t.busy);
      const session = this.sessions.get(id);
      this.active.add(id);
      const started = performance.now();
      try {
        await this.say(id, t.refining);
        const context = `${session.context}\nУточнение пользователя: ${msg.text.trim()}`.slice(-1200);
        const result = await this.analyze(session.image, this.config, session.crop, lang, context);
        const text = renderResult(result, lang, (performance.now() - started) / 1000, session.crop);
        this.sessions.set(id, { ...session, context, updated: Date.now() });
        this.store.save(id, { last: text });
        return await this.say(id, text, menu(lang));
      } catch (error) {
        console.error(JSON.stringify({ event: 'refinement_failed', service: error.service || 'analysis', status: error.status || 'invalid_response' }));
        return await this.say(id, error.status === 429 ? t.quota : error.code === 'INVALID_ASSESSMENT' ? t.refineFailed : t.unavailable, menu(lang));
      } finally { this.active.delete(id); }
    }
    const file = msg.photo?.at(-1) || msg.document;
    if (!file) return this.say(id, t.fallback, menu(lang));
    // Ensure direct photo senders see the data-transfer notice before any upload.
    if (file.file_size > 8 * 1024 * 1024 || (msg.document && !['image/jpeg', 'image/png', 'image/webp'].includes(msg.document.mime_type))) return this.say(id, t.badImage, menu(lang));
    if (this.active.has(id)) return this.say(id, t.busy);
    if (!this.config.key) return this.say(id, t.unavailable, menu(lang));
    this.active.add(id);
    const started = performance.now();
    try {
      await this.say(id, t.processing);
      let image;
      try { image = await this.prepare(await this.download(file)); }
      catch { return await this.say(id, t.badImage, menu(lang)); }
      const result = await this.analyze(image, this.config, u.crop, lang, msg.caption || '');
      const text = renderResult(result, lang, (performance.now() - started) / 1000, u.crop);
      await this.say(id, text, menu(lang));
      this.sessions.set(id, { image, crop: u.crop, context: msg.caption || '', updated: Date.now() });
      this.store.save(id, { last: text });
      console.log(JSON.stringify({ event: 'analysis_complete', seconds: Number(((performance.now() - started) / 1000).toFixed(2)), status: result.status }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'analysis_failed', service: error.service || 'analysis', status: error.status || 'invalid_response' }));
      await this.say(id, error.status === 429 ? t.quota : t.unavailable, menu(lang));
    } finally { this.active.delete(id); }
  }
}
