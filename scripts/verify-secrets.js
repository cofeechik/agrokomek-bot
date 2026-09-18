import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const secrets = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY'].map(key => process.env[key]).filter(Boolean);
if (secrets.length !== 2) throw new Error('Load both local secrets before the pre-publication check');
for (const file of files) {
  if (file === '.env' || file.startsWith('data/') || file.startsWith('eval/private/') || file.endsWith('.log')) throw new Error(`Private file staged: ${file}`);
  const contents = execFileSync('git', ['show', `:${file}`], { maxBuffer: 10 * 1024 * 1024 }).toString();
  if (secrets.some(secret => contents.includes(secret))) throw new Error(`Secret detected in staged file: ${file}`);
}
console.log(`Checked ${files.length} staged files: local keys and private files are absent.`);
