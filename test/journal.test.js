import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, summarizeObservations } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { renderAnalytics } from '../src/journal-ui.js';

const result = { status: 'assessment', crop: 'Пшеница', title: 'Нужен осмотр', category: 'unknown', label: 'other', urgency: 'today', meaning: 'Причина требует проверки', signs: ['Пятна'], alternatives: [], actions: ['Осмотрите растение'], checks: ['Снимите обратную сторону'], escalate: 'Обратитесь к агроному', questions: ['Когда появились пятна?'] };
const comparison = { status: 'comparison', crop: 'Пшеница', title: 'Изменения', trend: 'worse', summary: 'Повреждение заметнее', changes: ['Больше пятен'], actions: ['Осмотрите соседние растения'], checks: ['Нужен крупный план'], questions: [] };
const cfg = { key: 'fake', token: 'fake', model: 'fake' };
const msg = (id, extra = {}, chat = 7) => ({ update_id: id, message: { message_id: id, chat: { id: chat, type: 'private' }, from: { id: chat, language_code: 'ru' }, ...extra } });
const cb = (data, chat = 7) => ({ update_id: 55, callback_query: { id: 'cb', from: { id: chat }, data, message: { message_id: 55, chat: { id: chat, type: 'private' } } } });

test('journal REST operations are owner-scoped and never put credentials in URLs', async () => {
  const calls = [];
  const journal = new Journal('https://example.supabase.co', 'sb_secret_test', async (url, options) => {
    calls.push({ url: new URL(url), ...options }); return new Response('[]', { status: 200 });
  });
  await journal.list(7);
  await journal.get(7, '12345678-1234-1234-1234-123456789abc');
  await journal.delete(7);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('chat_id'), 'eq.7');
    assert.equal(call.headers.apikey, 'sb_secret_test');
    assert.equal(call.headers.Authorization, undefined);
    assert.ok(!call.url.toString().includes('sb_secret'));
  }
  assert.equal(await journal.get(7, 'anything&chat_id=eq.8'), null);
  assert.equal(calls.length, 3);
});

test('saved photo can be selected after bot restart, compared to one new photo, and deleted by its owner', async () => {
  const rows = [];
  const journal = {
    async add(chatId, entry) { rows.push({ id: String(rows.length + 1), chat_id: chatId, created_at: '2026-09-12T10:00:00Z', ...entry }); },
    async list(chatId, offset, limit) { return rows.filter(row => row.chat_id === chatId).slice(offset, offset + limit); },
    async get(chatId, id) { return rows.find(row => row.chat_id === chatId && row.id === id); },
    async delete(chatId) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].chat_id === chatId) rows.splice(i, 1); },
  };
  const calls = [], downloads = [], comparisons = [];
  const overrides = { journal, call: async (method, body) => { calls.push({ method, body }); return {}; },
    prepare: async bytes => bytes, download: async file => { downloads.push(file.file_id); return Buffer.from(file.file_id); },
    analyze: async () => result,
    compare: async (old, current, _c, crop, _lang, notes) => { comparisons.push({ old: old.toString(), current: current.toString(), crop, notes }); return comparison; },
  };
  const firstStore = new Store(':memory:');
  await new Bot(cfg, firstStore, overrides).handle(msg(1, { photo: [{ file_id: 'old' }], caption: 'Поле 1, пятна' }));
  firstStore.close();
  assert.equal(rows.length, 1);
  const store = new Store(':memory:');
  const bot = new Bot(cfg, store, overrides);
  try {
    await bot.handle(cb('observe'));
    assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data, 'saved:1');
    await bot.handle(cb('saved:1', 8));
    assert.equal(calls.filter(call => call.method === 'sendPhoto').length, 0);
    await bot.handle(cb('saved:1'));
    assert.equal(calls.at(-2).method, 'sendPhoto');
    assert.equal(calls.at(-2).body.photo, 'old');
    await bot.handle(msg(2, { photo: [{ file_id: 'new' }], caption: 'Через неделю' }));
    assert.equal(comparisons.length, 1);
    assert.equal(comparisons[0].old, 'old');
    assert.equal(comparisons[0].current, 'new');
    assert.ok(comparisons[0].notes.baseline.includes('Поле 1'));
    assert.equal(rows[1].parent_id, '1');
    assert.deepEqual(downloads, ['old', 'new', 'old']);
    await bot.handle(cb('analytics'));
    assert.ok(calls.at(-1).body.text.includes('Ухудшение: 1'));
    await bot.handle(msg(3, { text: '/delete' }));
    assert.equal(rows.length, 0);
  } finally { store.close(); }
});

test('analytics counts uncertainty separately and does not turn a poor image into a worsening trend', () => {
  const rows = [
    { crop: 'wheat', created_at: '2026-09-12T10:00:00Z', assessment: result },
    { crop: 'wheat', created_at: '2026-09-19T10:00:00Z', assessment: { ...comparison, status: 'poor_image', trend: 'worse' } },
  ];
  const stats = summarizeObservations(rows);
  assert.equal(stats.count, 2); assert.equal(stats.urgent, 1);
  assert.equal(stats.trends.worse, 0); assert.equal(stats.trends.uncertain, 1);
  assert.ok(renderAnalytics(rows, 'ru').includes('Недостаточно данных: 1'));
});
