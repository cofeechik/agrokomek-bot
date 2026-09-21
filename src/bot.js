import { telegram, boundedBytes } from './api.js';
import { analyze, answerFollowUp, compareImages, prepareImage } from './analysis.js';
import { crops, copy, cropKeyboard, menu, resultMenu, renderResult, renderComparison, renderFollowUp, messageChunks, escapeHtml } from './ui.js';
import { journalCopy, observationDate, observationKeyboard, renderAnalytics } from './journal-ui.js';

export class Bot {
  constructor(config, store, overrides = {}) {
    this.config = config; this.store = store;
    this.journal = overrides.journal || null;
    this.journalNotified = new Set();
    this.call = overrides.call || ((method, body) => telegram(config.token, method, body));
    this.analyze = overrides.analyze || analyze;
    this.followUp = overrides.followUp || answerFollowUp;
    this.compare = overrides.compare || compareImages;
    this.delay = overrides.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.prepare = overrides.prepare || prepareImage;
    this.download = overrides.download || (async file => {
      const info = await this.call('getFile', { file_id: file.file_id });
      if (info.file_size > 8 * 1024 * 1024 || !info.file_path) throw new Error('Invalid image');
      const response = await fetch(`https://api.telegram.org/file/bot${config.token}/${info.file_path}`, { signal: AbortSignal.timeout(20000) });
      return boundedBytes(response, 8 * 1024 * 1024);
    });
    this.active = new Set(); this.sessions = new Map(); this.observations = new Map(); this.pending = new Set(); this.tasks = new Set(); this.accepting = true;
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
  isTransient(error) {
    return error?.service === 'Gemini' && (error.status === 'network' || error.status === 408 || error.status === 429 || (Number(error.status) >= 500 && Number(error.status) < 600));
  }
  failureText(error, t, refining = false) {
    if (error.status === 429) return t.quota;
    return refining && error.code === 'INVALID_ASSESSMENT' ? t.refineFailed : t.unavailable;
  }
  async requestAvailable(execute) {
    try {
      return { result: await execute(this.config), fallback: false };
    } catch (error) {
      const fallbackModel = this.config.fallbackModel;
      if ((!this.isTransient(error) && error.code !== 'INVALID_ASSESSMENT') || !fallbackModel || fallbackModel === this.config.model) throw error;
      const fallbackConfig = { ...this.config, model: fallbackModel };
      try {
        return { result: await execute(fallbackConfig), fallback: true };
      } catch (fallbackError) {
        if (!this.isTransient(fallbackError)) throw fallbackError;
        const seconds = Math.min(Math.max(Math.ceil(fallbackError.retryAfter || 2), 1), 20);
        await this.delay(seconds * 1000);
        return { result: await execute(fallbackConfig), fallback: true };
      }
    }
  }
  analyzeAvailable(image, crop, lang, note) {
    return this.requestAvailable(config => this.analyze(image, config, crop, lang, note));
  }
  followUpAvailable(image, crop, lang, previous, context, userText) {
    return this.requestAvailable(config => this.followUp(image, config, crop, lang, previous, context, userText));
  }
  compareAvailable(baseline, current, crop, lang, notes) {
    return this.requestAvailable(config => this.compare(baseline, current, config, crop, lang, notes));
  }
  async saveObservation(id, msg, crop, result, parentId, lang) {
    if (!this.journal) return;
    try {
      await this.journal.add(id, { message_id: msg.message_id, crop, file_id: (msg.photo?.at(-1) || msg.document).file_id,
        media_type: msg.document ? 'document' : 'photo', caption: (msg.caption || '').slice(0, 1024), assessment: result, parent_id: parentId || null });
    } catch {
      console.error('Observation save failed; no private data logged.');
      await this.say(id, journalCopy[lang].saveFailed);
    }
  }
  async showObservations(id, lang, page = 0) {
    const t = journalCopy[lang];
    try {
      const rows = await this.journal.list(id, page * 5, 6);
      return await this.say(id, `${t.title}\n\n${rows.length ? t.choose : t.empty}`, observationKeyboard(rows, page, lang));
    } catch { return this.say(id, t.unavailable, menu(lang)); }
  }
  reportText(session, lang) {
    const t = copy[lang], r = session?.assessment;
    if (!r) return null;
    const e = escapeHtml;
    const items = values => (values || []).slice(0, 3).map(value => `• ${e(value)}`).join('\n');
    const observations = r.signs?.length ? r.signs : r.changes;
    const note = session.context?.trim() ? `\n\n<b>${t.reportWorker}</b>\n${e(session.context.trim().slice(0, 500))}` : '';
    return `<b>📋 ${t.report}</b>\n\n<b>${t.reportCrop}:</b> ${e(r.crop)}\n<b>${t.reportPriority}:</b> ${e(t.urgency[r.urgency] || t.urgency.unknown)}\n<b>${t.reportAssessment}:</b> ${e(r.title)}\n\n<b>${r.changes?.length ? t.changes : t.signs}</b>\n${items(observations) || '• ' + e(t.uncertain)}\n\n<b>${t.actions}</b>\n${items(r.actions)}\n\n<b>${t.checks}</b>\n${items(r.checks)}${note}\n\n<i>${e(t.caveat)} ${e(t.reportHandoff)}</i>`;
  }
  async handle(update) {
    const expired = Date.now() - 30 * 60 * 1000;
    for (const [chatId, session] of this.sessions) if (session.updated < expired) this.sessions.delete(chatId);
    for (const [chatId, observation] of this.observations) if (observation.updated < expired) this.observations.delete(chatId);
    const cb = update.callback_query;
    const msg = cb?.message || update.message;
    if (!msg?.chat || !msg.from && !cb?.from) return;
    const id = msg.chat.id;
    if (msg.chat.type !== 'private') return; // Do not analyze photos in groups.
    const sender = cb?.from || msg.from;
    const existing = this.store.get(id);
    const u = existing || this.store.save(id, { language: sender.language_code?.startsWith('kk') ? 'kk' : 'ru' });
    if (!crops[u.crop]) { u.crop = 'wheat'; this.store.save(id, { crop: u.crop }); }
    const lang = u.language, t = copy[lang];
    const command = cb?.data || msg.text?.split(/\s/)[0]?.split('@')[0]?.replace(/^\//, '') || '';
    const file = msg.photo?.at(-1) || msg.document;
    if (cb) await this.call('answerCallbackQuery', { callback_query_id: cb.id });
    const journalCommand = this.journal && (command === 'observe' || command === 'analytics' || command.startsWith('saved:') || command.startsWith('observe:page:') || command === 'delete');
    if (!existing && command !== 'start' && !file && !journalCommand) return this.say(id, t.welcome + '\n\n' + t.ready, cropKeyboard(lang));
    if (command === 'start') return this.say(id, t.welcome + '\n\n' + journalCopy[lang].intro + (this.journal ? '\n\n' + journalCopy[lang].privacy : ''), cropKeyboard(lang));
    if (command === 'language') return this.say(id, 'Тілді таңдаңыз / Выберите язык', { inline_keyboard: [[{ text: 'Қазақша', callback_data: 'lang:kk' }, { text: 'Русский', callback_data: 'lang:ru' }]] });
    if (['lang:ru', 'lang:kk'].includes(command)) {
      const selected = command.slice(5); this.store.save(id, { language: selected });
      return this.say(id, copy[selected].welcome, cropKeyboard(selected));
    }
    if (command === 'crop') return this.say(id, t.choose, cropKeyboard(lang));
    if (command.startsWith('crop:') && crops[command.slice(5)]) {
      this.observations.delete(id);
      this.store.save(id, { crop: command.slice(5) });
      return this.say(id, `${crops[command.slice(5)][lang === 'kk' ? 1 : 0]}\n\n${t.ready}`, menu(lang));
    }
    if (command === 'photo') { this.observations.delete(id); return this.say(id, t.ready, menu(lang)); }
    if (command === 'observe' && this.journal) return this.showObservations(id, lang);
    if (/^observe:page:\d{1,5}$/.test(command) && this.journal) return this.showObservations(id, lang, Number(command.split(':')[2]));
    if (command.startsWith('saved:') && this.journal) {
      if (this.active.has(id)) return this.say(id, t.busy);
      try {
        const saved = await this.journal.get(id, command.slice(6));
        if (!saved) return this.say(id, journalCopy[lang].missing, menu(lang));
        const method = saved.media_type === 'document' ? 'sendDocument' : 'sendPhoto';
        await this.call(method, { chat_id: id, [saved.media_type === 'document' ? 'document' : 'photo']: saved.file_id,
          caption: `${observationDate(saved.created_at)} · ${saved.assessment.crop}\n${saved.caption}`.slice(0, 1000) });
        this.observations.set(id, { stage: 'current', crop: saved.crop, baselineId: saved.id, updated: Date.now() });
        return this.say(id, journalCopy[lang].selected, menu(lang));
      } catch { return this.say(id, journalCopy[lang].unavailable, menu(lang)); }
    }
    if (command === 'analytics') {
      if (!this.journal) return this.say(id, journalCopy[lang].disabled, menu(lang));
      try {
        const rows = await this.journal.list(id, 0, 101);
        return await this.say(id, renderAnalytics(rows.slice(0, 100), lang, rows.length > 100), menu(lang));
      } catch { return this.say(id, journalCopy[lang].unavailable, menu(lang)); }
    }
    if (command === 'observe' || command === 'observe:manual') {
      this.observations.set(id, { stage: 'baseline', crop: u.crop, updated: Date.now() });
      return this.say(id, t.observationStart, menu(lang));
    }
    if (command === 'help') return this.say(id, t.help, menu(lang));
    if (command === 'privacy') return this.say(id, t.privacy + (this.journal ? '\n\n' + journalCopy[lang].privacy : ''), menu(lang));
    if (command === 'history') return this.say(id, u.last || t.noHistory, menu(lang));
    if (command === 'report') {
      const report = this.reportText(this.sessions.get(id), lang);
      return this.say(id, report || t.reportUnavailable, menu(lang));
    }
    if (command === 'delete') {
      if (this.active.has(id)) return this.say(id, t.busy);
      if (this.journal) {
        try { await this.journal.delete(id); }
        catch { return this.say(id, journalCopy[lang].unavailable, menu(lang)); }
      }
      this.sessions.delete(id); this.observations.delete(id);
      this.store.delete(id); return this.say(id, t.deleted);
    }
    if (msg.text?.trim() && !msg.text.startsWith('/') && this.observations.has(id)) {
      return this.say(id, this.observations.get(id).stage === 'baseline' ? t.observationStart : t.baselineReady, menu(lang));
    }
    if (msg.text?.trim() && !msg.text.startsWith('/') && this.sessions.has(id)) {
      if (this.active.has(id)) return this.say(id, t.busy);
      const session = this.sessions.get(id);
      this.active.add(id);
      const started = performance.now();
      try {
        await this.say(id, t.refining);
        const userText = msg.text.trim().slice(0, 700);
        const context = `${session.context}\n${userText}`.slice(-1200);
        const analyzed = session.assessment
          ? await this.followUpAvailable(session.image, session.crop, lang, session.assessment, session.context, userText)
          : await this.analyzeAvailable(session.image, session.crop, lang, context);
        const text = session.assessment ? renderFollowUp(analyzed.result, lang) : renderResult(analyzed.result, lang, (performance.now() - started) / 1000);
        this.sessions.set(id, { ...session, context, assessment: session.assessment || analyzed.result, updated: Date.now() });
        this.store.save(id, { last: text });
        return await this.say(id, text, resultMenu(lang));
      } catch (error) {
        console.error(JSON.stringify({ event: 'refinement_failed', service: error.service || 'analysis', status: error.status || 'invalid_response' }));
        return await this.say(id, this.failureText(error, t, true), menu(lang));
      } finally { this.active.delete(id); }
    }
    if (!file) return this.say(id, t.fallback, menu(lang));
    // Ensure direct photo senders see the data-transfer notice before any upload.
    if (file.file_size > 8 * 1024 * 1024 || (msg.document && !['image/jpeg', 'image/png', 'image/webp'].includes(msg.document.mime_type))) return this.say(id, t.badImage, menu(lang));
    if (this.active.has(id)) return this.say(id, t.busy);
    if (!this.config.key) return this.say(id, t.unavailable, menu(lang));
    this.active.add(id);
    const started = performance.now();
    try {
      if (!existing) await this.say(id, t.firstPhoto);
      if (this.journal && !this.journalNotified.has(id)) {
        await this.say(id, journalCopy[lang].saveNotice);
        this.journalNotified.add(id);
      }
      let image;
      try { image = await this.prepare(await this.download(file)); }
      catch { return await this.say(id, t.badImage, menu(lang)); }
      const context = msg.caption?.trim() || '';
      const observation = this.observations.get(id);
      if (observation?.stage === 'baseline') {
        this.observations.set(id, { ...observation, stage: 'current', baseline: image, baselineNote: context, updated: Date.now() });
        return await this.say(id, t.baselineReady, menu(lang));
      }
      if (observation?.stage === 'current') {
        await this.say(id, t.comparing);
        let baseline = observation.baseline, baselineNote = observation.baselineNote || '';
        if (observation.baselineId) {
          const saved = await this.journal.get(id, observation.baselineId);
          if (!saved) { this.observations.delete(id); return await this.say(id, journalCopy[lang].missing, menu(lang)); }
          baseline = await this.prepare(await this.download({ file_id: saved.file_id }));
          baselineNote = `Uploaded: ${saved.created_at}. User caption: ${saved.caption}`;
        }
        const compared = await this.compareAvailable(baseline, image, observation.crop, lang, { baseline: baselineNote, current: context });
        const text = renderComparison(compared.result, lang, (performance.now() - started) / 1000);
        this.observations.delete(id);
        this.sessions.set(id, { image, crop: observation.crop, context, assessment: compared.result, updated: Date.now() });
        this.store.save(id, { last: text });
        await this.say(id, text, resultMenu(lang));
        await this.saveObservation(id, msg, observation.crop, compared.result, observation.baselineId, lang);
        console.log(JSON.stringify({ event: 'comparison_complete', seconds: Number(((performance.now() - started) / 1000).toFixed(2)), status: compared.result.status, fallback: compared.fallback }));
        return;
      }
      await this.say(id, t.processing);
      this.sessions.set(id, { image, crop: u.crop, context, updated: Date.now() });
      const analyzed = await this.analyzeAvailable(image, u.crop, lang, context);
      const text = renderResult(analyzed.result, lang, (performance.now() - started) / 1000);
      await this.say(id, text, resultMenu(lang));
      this.sessions.set(id, { image, crop: u.crop, context, assessment: analyzed.result, updated: Date.now() });
      this.store.save(id, { last: text });
      await this.saveObservation(id, msg, u.crop, analyzed.result, null, lang);
      console.log(JSON.stringify({ event: 'analysis_complete', seconds: Number(((performance.now() - started) / 1000).toFixed(2)), status: analyzed.result.status, fallback: analyzed.fallback }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'analysis_failed', service: error.service || 'analysis', status: error.status || 'invalid_response' }));
      await this.say(id, this.failureText(error, t), menu(lang));
    } finally { this.active.delete(id); }
  }
}
