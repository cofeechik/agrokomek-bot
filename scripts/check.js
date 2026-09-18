import { configFrom } from '../src/config.js';
import { telegram, geminiRequest } from '../src/api.js';
const c = configFrom();
let failed = false;
try {
  const me = await telegram(c.token, 'getMe');
  const hook = await telegram(c.token, 'getWebhookInfo');
  console.log(`Telegram: OK @${me.username}; webhook configured: ${Boolean(hook.url)}`);
} catch (error) { console.log(`Telegram: ${error.message}`); failed = true; }
try {
  const data = await geminiRequest(c.key, 'models?pageSize=1000');
  const models = data.models?.filter(m => m.supportedGenerationMethods?.includes('generateContent') && m.name.includes('flash')).map(m => m.name.replace('models/', '')) || [];
  console.log('Gemini: OK. Available Flash models:', models.join(', '));
  if (!models.includes(c.model)) { console.log(`Configured model is not available: ${c.model}`); failed = true; }
} catch (error) { console.log(`Gemini: ${error.message}`); failed = true; }
process.exitCode = failed ? 1 : 0;
