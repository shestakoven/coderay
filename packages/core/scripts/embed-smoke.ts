import { join } from 'node:path';
import { defaultIdeHome } from '../src/home';
import { LocalEmbedModel } from '../src/models/local-embed';

const cacheDir = process.argv[2] ?? join(defaultIdeHome(), 'models');
const model = new LocalEmbedModel({ cacheDir });
console.log('status at start:', model.status());
const started = Date.now();
const [code, similar, css] = (await model.embed([
  'export function parseImports(source: string): string[] {}',
  'export function readImports(text: string): string[] {}',
  'body { color: red; margin: 0; }',
])) as [Float32Array, Float32Array, Float32Array];
const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
console.log(`dims ${code.length} · ${Date.now() - started} ms · related ${dot(code, similar).toFixed(3)} · unrelated ${dot(code, css).toFixed(3)}`);
await model.close();
