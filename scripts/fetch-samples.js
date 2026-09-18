import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { boundedBytes } from '../src/api.js';

// Fixed deterministic selection before model evaluation, never prompt-tuning examples.
const repo = 'spMohanty/PlantVillage-Dataset';
const classes = { Potato___healthy: 'potato_healthy', Potato___Early_blight: 'potato_early_blight', Potato___Late_blight: 'potato_late_blight' };
const get = async url => {
  const r = await fetch(url, { headers: { 'user-agent': 'AgroKomek-hackathon-evaluation' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Dataset download failed: ${r.status}`);
  return r;
};
const commit = '7f7ecc7e1eaca78107e3affe7cb5abd9427e139a';
mkdirSync('eval/private', { recursive: true });
const manifest = [];
for (const [folder, label] of Object.entries(classes)) {
  const entries = await (await get(`https://api.github.com/repos/${repo}/contents/raw/color/${folder}?ref=${commit}`)).json();
  const hash = e => createHash('sha256').update('agrokomek-eval-v1:' + e.name).digest('hex');
  const chosen = entries.filter(e => /\.jpe?g$/i.test(e.name)).sort((a,b) => hash(a).localeCompare(hash(b))).slice(0,3);
  if (chosen.length !== 3) throw new Error('Not enough examples');
  for (const [i, entry] of chosen.entries()) {
    const source = `https://raw.githubusercontent.com/${repo}/${commit}/raw/color/${folder}/${entry.name}`;
    const bytes = await boundedBytes(await get(source), 8 * 1024 * 1024);
    const file = `${label}-${i+1}.jpg`;
    writeFileSync(`eval/private/${file}`, bytes);
    manifest.push({ file, label, source, license: 'CC-BY-SA-3.0 (mohanty/PlantVillage dataset card)', split: 'test' });
  }
}
writeFileSync('eval/private/manifest.json', JSON.stringify(manifest, null, 2));
console.log(`Downloaded ${manifest.length} real photographs; source commit ${commit}. This is a small smoke benchmark, not field validation.`);
