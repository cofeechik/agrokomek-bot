export function configFrom(env = process.env) {
  const integer = (name, fallback) => {
    const n = Number(env[name] || fallback);
    if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid setting: ${name}`);
    return n;
  };
  const mode = env.BOT_MODE || 'polling';
  if (!['polling', 'webhook'].includes(mode)) throw new Error('Invalid BOT_MODE');
  const baseUrl = (env.WEBHOOK_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (mode === 'webhook' && (!baseUrl.startsWith('https://') || !/^[\w-]{16,256}$/.test(env.WEBHOOK_SECRET || ''))) {
    throw new Error('Webhook requires HTTPS URL and WEBHOOK_SECRET (16-256 letters, digits, _ or -)');
  }
  return {
    token: env.TELEGRAM_BOT_TOKEN || '', key: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3.5-flash',
    fallbackModel: env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite', mode, baseUrl,
    secret: env.WEBHOOK_SECRET || '', port: integer('PORT', 3000),
    dataPath: env.DATA_PATH || 'data/state.sqlite',
  };
}
