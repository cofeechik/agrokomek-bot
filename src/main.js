import { setTimeout as sleep } from 'node:timers/promises';
import { configFrom } from './config.js';
import { Store } from './store.js';
import { Bot } from './bot.js';
import { makeServer } from './server.js';
import { Journal } from './journal.js';

const config = configFrom();
if (!config.token) { console.error('Set TELEGRAM_BOT_TOKEN in .env or host settings.'); process.exit(1); }
const store = new Store(config.dataPath);
if (Boolean(config.journalUrl) !== Boolean(config.journalSecret)) throw new Error('Set both SUPABASE_URL and SUPABASE_SECRET_KEY');
const journal = config.journalUrl ? new Journal(config.journalUrl, config.journalSecret) : null;
const bot = new Bot(config, store, { journal });
const state = { ready: false };
const server = makeServer(config, bot, state);
server.requestTimeout = 15000;
server.listen(config.port, '0.0.0.0');
let stopping = false;
const cleanup = setInterval(() => store.cleanup(), 3600000).unref();
async function shutdown() {
  if (stopping) return;
  stopping = true; state.ready = false; clearInterval(cleanup);
  server.close();
  await bot.drain(); store.close(); process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
try {
  const me = await bot.call('getMe');
  const commands = [
    { command: 'start', description: '🌿 Начать / Бастау' },
    { command: 'crop', description: '🌱 Выбрать культуру / Дақыл' },
    { command: 'help', description: '📷 Как снимать / Нұсқаулық' },
    { command: 'language', description: '🇰🇿 Қазақша / Русский' },
    { command: 'history', description: '🗂 Последний результат / Соңғы нәтиже' },
    { command: 'observe', description: '📈 Наблюдения / Бақылаулар' },
    { command: 'analytics', description: '📊 Сводка осмотров / Тексеру жиынтығы' },
    { command: 'privacy', description: 'Данные / Деректер' },
    { command: 'delete', description: 'Удалить мои данные / Деректерді өшіру' },
  ];
  await bot.call('setMyCommands', { commands });
  await bot.call('setMyDescription', { description: '🌿 AgroKomek — помощник для первичного осмотра растений. Не нужно знать названия болезней: отправьте фото и описание, чтобы понять, что проверить и когда обратиться к агроному. Қазақша / Русский. Прототип AgriTech AI Hackathon.' });
  if (config.mode === 'webhook') {
    await bot.call('setWebhook', { url: `${config.baseUrl}/telegram`, secret_token: config.secret, allowed_updates: ['message', 'callback_query'], max_connections: 4, drop_pending_updates: false });
    state.ready = true;
    console.log(`AgroKomek ready: @${me.username} (webhook)`);
  } else {
    const hook = await bot.call('getWebhookInfo');
    if (hook.url) throw new Error('An existing webhook is active. Stop it explicitly before running polling.');
    state.ready = true;
    console.log(`AgroKomek ready: @${me.username} (local polling)`);
    let offset = 0;
    while (!stopping) {
      try {
        const updates = await bot.call('getUpdates', { offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates) {
          if (!bot.enqueue(update)) { await Promise.allSettled([...bot.tasks]); break; }
          offset = update.update_id + 1;
        }
        // Complete accepted work before advancing Telegram's durable offset.
        await Promise.allSettled([...bot.tasks]);
      } catch (error) {
        console.error(JSON.stringify({ event: 'poll_failed', status: error.status || 'network' }));
        if (error.status === 401 || error.status === 409) throw new Error('Telegram authorization or competing bot process; polling stopped.');
        if (!stopping) await sleep(5000);
      }
    }
  }
} catch (error) {
  console.error(error.service ? `${error.service}: ${error.status}` : error.message);
  await shutdown();
}
