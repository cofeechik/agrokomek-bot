import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { configFrom } from '../src/config.js';
import { prepareImage, analyze } from '../src/analysis.js';

// Manifest entries: {file, label, source, license, split}. Use only images you can lawfully process.
const manifestPath = process.argv[2];
if (!manifestPath) { console.log('Usage: npm run eval -- eval/private/manifest.json'); process.exit(1); }
const rows = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('Provide 1-100 labelled examples');
const labels = ['potato_healthy', 'potato_early_blight', 'potato_late_blight'];
const hashes = new Set();
const inputs = rows.map(row => {
  if (!row.file || !row.source || !row.license || row.split !== 'test' || !labels.includes(row.label)) throw new Error('Each example needs source, license, test split and supported label');
  const bytes = readFileSync(resolve(dirname(manifestPath), row.file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (hashes.has(sha256)) throw new Error('Duplicate image');
  hashes.add(sha256); return { row, bytes, sha256 };
});
const config = configFrom(), results = [];
for (const { row, bytes, sha256 } of inputs) {
  const started = performance.now();
  try {
    const result = await analyze(await prepareImage(bytes), config, 'potato', 'ru', '');
    results.push({ source: row.source, license: row.license, sha256, expected: row.label, predicted: result.label, seconds: (performance.now() - started) / 1000 });
  } catch (error) {
    results.push({ source: row.source, sha256, expected: row.label, predicted: 'error', seconds: (performance.now() - started) / 1000, error: error.status || 'invalid_response' });
    if ([400, 401, 403, 429].includes(error.status)) { console.log('Stopping on API authorization/quota failure; results are partial.'); break; }
  }
  console.log(`Evaluated ${results.length}/${inputs.length}`);
}
const f1 = labels.map(label => {
  const tp = results.filter(r => r.expected === label && r.predicted === label).length;
  const fp = results.filter(r => r.expected !== label && r.predicted === label).length;
  const fn = results.filter(r => r.expected === label && r.predicted !== label).length;
  return { label, support: results.filter(r => r.expected === label).length, f1: 2 * tp / (2 * tp + fp + fn || 1) };
});
const timings = results.map(r => r.seconds).sort((a,b) => a-b);
const report = {
  model: config.model, date: new Date().toISOString(), planned: rows.length, evaluated: results.length,
  complete: rows.length === results.length, accuracy: results.filter(r => r.expected === r.predicted).length / results.length,
  macroF1: f1.every(r => r.support > 0) ? f1.reduce((n,r) => n+r.f1,0)/f1.length : null,
  medianSeconds: timings[Math.floor(timings.length/2)], p95Seconds: timings[Math.min(timings.length-1, Math.ceil(timings.length*0.95)-1)],
  under5Seconds: results.filter(r => r.seconds <= 5).length / results.length,
  caveat: 'No model training performed by this team. Gemini pretraining data are unknown, so absence of training overlap cannot be guaranteed. Laboratory-leaf results do not establish field performance. API errors and abstentions count as incorrect. Timing excludes Telegram transfer and Render cold start.',
  perClass: f1, results,
};
writeFileSync('eval/results.local.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ evaluated: report.evaluated, accuracy: report.accuracy, macroF1: report.macroF1, complete: report.complete }));
