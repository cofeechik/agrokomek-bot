import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function makeServer(config, bot, state) {
  return createServer(async (req, res) => {
    const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && ['/', '/healthz'].includes(req.url)) return reply(state.ready ? 200 : 503, { service: 'AgroKomek', ready: state.ready });
    if (config.mode !== 'webhook' || req.method !== 'POST' || req.url !== '/telegram') return reply(404, { error: 'not_found' });
    const actual = Buffer.from(req.headers['x-telegram-bot-api-secret-token'] || '');
    const expected = Buffer.from(config.secret);
    if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(403, { error: 'forbidden' });
    if (!state.ready) return reply(503, { error: 'not_ready' });
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 128 * 1024) return reply(413, { error: 'too_large' });
        chunks.push(chunk);
      }
      const update = JSON.parse(Buffer.concat(chunks).toString());
      if (!Number.isSafeInteger(update.update_id)) return reply(400, { error: 'invalid_update' });
      if (!bot.enqueue(update)) return reply(503, { error: 'busy' });
      return reply(200, { ok: true });
    } catch { return reply(400, { error: 'invalid_request' }); }
  });
}
