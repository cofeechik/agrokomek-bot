import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Store } from '../src/store.js';
import { Bot } from '../src/bot.js';
import { prepareImage, validateResult, analyze } from '../src/analysis.js';
import { renderResult, messageChunks } from '../src/ui.js';
import { makeServer } from '../src/server.js';
import { configFrom } from '../src/config.js';

const result = { status: 'assessment', crop: 'Картофель', title: '<script>test</script>', category: 'disease', label: 'potato_early_blight', urgency: 'soon', meaning: 'Возможна проблема листьев', signs: ['Пятна'], alternatives: [], actions: ['Осмотрите соседние растения'], checks: ['Снимите нижнюю сторону листа'], escalate: 'Обратитесь к агроному при быстром распространении', questions: ['Когда появились пятна?', 'Сколько растений затронуто?'] };
const cfg = { key: 'fake', token: 'fake', model: 'fake' };

test('image processing rejects non-images, tiny and oversized files, resizes real images', async () => {
  await assert.rejects(prepareImage(Buffer.from('<html>not a photograph</html>')));
  await assert.rejects(prepareImage(Buffer.alloc(8 * 1024 * 1024 + 1)));
  const tiny = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'green' } }).png().toBuffer();
  await assert.rejects(prepareImage(tiny));
  const original = await sharp({ create: { width: 2000, height: 1600, channels: 3, background: 'green' } }).png().toBuffer();
  const meta = await sharp(await prepareImage(original)).metadata();
  assert.equal(meta.width, 1280); assert.equal(meta.format, 'jpeg'); assert.equal(meta.exif, undefined);
});
test('uncertain assessments cannot carry a definite disease label or urgency', () => {
  const r = validateResult({ ...result, status: 'uncertain' });
  assert.equal(r.label, 'unknown'); assert.equal(r.urgency, 'unknown');
  assert.throws(() => validateResult({ ...result, actions: [] }));
});
test('formatted model content is escaped and contains no fake confidence percentages', () => {
  const text = renderResult(result, 'ru', 3.4);
  assert.ok(!text.includes('<script>')); assert.ok(text.includes('&lt;script&gt;')); assert.ok(!text.includes('%'));
  assert.ok(renderResult(result, 'kk', 3).includes('Алдын ала'));
});
test('long escaped output is split on balanced lines under Telegram message limit', () => {
  const text = Array.from({ length: 8 }, () => `<b>${'&amp;'.repeat(150)}</b>`).join('\n');
  const chunks = messageChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.length <= 3800));
  assert.equal(chunks.join('\n'), text);
});
test('Gemini sends photo with schema and rejects truncated output', async () => {
  let body;
  const request = async (_key, _path, payload) => { body = payload; return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }] }; };
  assert.equal((await analyze(Buffer.from('image'), cfg, 'potato', 'ru', 'spots', request)).label, result.label);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  assert.ok(body.generationConfig.responseJsonSchema.required.includes('status'));
  let attempts = 0;
  await assert.rejects(analyze(Buffer.from('x'), cfg, 'potato', 'ru', '', async () => { attempts++; return { candidates: [{ finishReason: 'MAX_TOKENS' }] }; }), error => error.code === 'INVALID_ASSESSMENT');
  assert.equal(attempts, 2);
});
test('store saves and deletes personal state while retaining update deduplication', () => {
  const store = new Store(':memory:');
  try {
    store.save(1, { last: 'private' }); assert.equal(store.get(1).last, 'private');
    store.delete(1); assert.equal(store.get(1), undefined);
    store.mark(42); assert.equal(store.seen(42), true);
  } finally { store.close(); }
});
const message = (id, extra = {}) => ({ update_id: id, message: { message_id: id, chat: { id: 7, type: 'private' }, from: { id: 7, language_code: 'ru' }, ...extra } });
test('a new user photo is analyzed immediately, its caption is used and a duplicate is ignored', async () => {
  const store = new Store(':memory:'); const sent = []; let calls = 0;
  const bot = new Bot(cfg, store, { call: async (method, body) => { sent.push({ method, body }); return {}; }, download: async () => Buffer.from('photo'), prepare: async b => b, analyze: async (_img, _cfg, crop, lang, note) => { calls++; assert.equal(crop, 'potato'); assert.equal(lang, 'ru'); assert.equal(note, 'три дня'); return result; } });
  try {
    const update = message(1, { photo: [{ file_id: 'photo', file_size: 300 }], caption: '  три дня  ' });
    bot.enqueue(update); bot.enqueue(update); await Promise.allSettled([...bot.tasks]);
    assert.equal(calls, 1); assert.ok(store.get(7).last.includes('Пятна'));
    assert.ok(sent.some(x => x.body.text?.includes('Google Gemini')));
    assert.ok(sent.at(-1).body.text.includes('Пятна'));
    bot.enqueue(update); assert.equal(bot.tasks.size, 0);
  } finally { store.close(); }
});
test('a text reply reuses the temporary image and adds context for a refined assessment', async () => {
  const store = new Store(':memory:'); const sent = []; const notes = [];
  const bot = new Bot(cfg, store, { call: async (_method, body) => { sent.push(body); return {}; }, download: async () => Buffer.from('photo'), prepare: async b => b, analyze: async (_img, _cfg, _crop, _lang, note) => { notes.push(note); return result; } });
  try {
    store.save(7, { language: 'ru', crop: 'potato' });
    await bot.handle(message(1, { photo: [{ file_id: 'photo', file_size: 300 }], caption: 'Появилось вчера' }));
    await bot.handle(message(2, { text: 'Поражено около 20 растений, после дождя' }));
    assert.equal(notes.length, 2);
    assert.ok(notes[1].includes('Появилось вчера'));
    assert.ok(notes[1].includes('20 растений'));
    assert.ok(sent.some(x => x.text?.includes('Учитываю ваш ответ')));
  } finally { store.close(); }
});
test('Gemini quota failures give a clear error and release the user lock', async () => {
  const store = new Store(':memory:'); store.save(7, {}); const texts = [];
  const bot = new Bot(cfg, store, { call: async (_m, b) => { if (b.text) texts.push(b.text); return {}; }, download: async () => Buffer.from('x'), prepare: async b => b, analyze: async () => { throw Object.assign(new Error('hidden'), { status: 429, service: 'Gemini' }); } });
  try {
    await bot.handle(message(1, { photo: [{ file_id: 'x' }] }));
    assert.ok(texts.at(-1).includes('квота')); assert.equal(bot.active.size, 0); assert.equal(store.get(7).last, null);
  } finally { store.close(); }
});
test('a Gemini 429 switches to the fallback model and discloses it in the result', async () => {
  const store = new Store(':memory:'); store.save(7, {}); const texts = []; const models = [];
  const fallbackCfg = { ...cfg, fallbackModel: 'gemini-3.5-flash-lite' };
  const bot = new Bot(fallbackCfg, store, { call: async (_m, b) => { if (b.text) texts.push(b.text); return {}; }, download: async () => Buffer.from('x'), prepare: async b => b, analyze: async (_image, config) => {
    models.push(config.model);
    if (config.model === cfg.model) throw Object.assign(new Error('hidden'), { status: 429, service: 'Gemini' });
    return result;
  } });
  try {
    await bot.handle(message(1, { photo: [{ file_id: 'x' }] }));
    assert.deepEqual(models, ['fake', 'gemini-3.5-flash-lite']);
    assert.ok(texts.some(text => text.includes('резервную модель')));
    assert.ok(texts.at(-1).includes('Flash-Lite'));
    assert.ok(store.get(7).last.includes('Пятна'));
  } finally { store.close(); }
});
test('webhook rejects forged calls and accepts valid Telegram updates', async () => {
  const c = configFrom({ BOT_MODE: 'webhook', WEBHOOK_URL: 'https://example.com', WEBHOOK_SECRET: 'test-secret-12345678' });
  const received = []; const server = makeServer(c, { enqueue: u => { received.push(u); return true; } }, { ready: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + '/healthz')).status, 200);
    assert.equal((await fetch(url + '/telegram', { method: 'POST', body: '{}' })).status, 403);
    const headers = { 'x-telegram-bot-api-secret-token': c.secret };
    assert.equal((await fetch(url + '/telegram', { method: 'POST', headers, body: JSON.stringify({ update_id: 4 }) })).status, 200);
    assert.equal(received[0].update_id, 4);
    assert.equal((await fetch(url + '/telegram', { method: 'POST', headers, body: 'invalid' })).status, 400);
    assert.equal((await fetch(url + '/telegram', { method: 'POST', headers, body: JSON.stringify({ update_id: 5, data: 'a'.repeat(130000) }) })).status, 200);
    assert.equal((await fetch(url + '/telegram', { method: 'POST', headers, body: JSON.stringify({ update_id: 6, data: 'a'.repeat(140000) }) })).status, 413);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
