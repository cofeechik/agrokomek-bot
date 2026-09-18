// A generated plain image is only an API/non-plant smoke test, never evaluation data.
import sharp from 'sharp';
import { configFrom } from '../src/config.js';
import { analyze } from '../src/analysis.js';
const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#eeeeee' } }).jpeg().toBuffer();
const started = performance.now();
try {
  const r = await analyze(image, configFrom(), 'potato', 'ru', '');
  console.log(JSON.stringify({ test: 'synthetic_blank_image_not_quality_benchmark', seconds: (performance.now() - started) / 1000, result: r }, null, 2));
  if (r.status === 'assessment') process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ service: error.service || 'schema', status: error.status || 'invalid_response' })); process.exitCode = 1; }
