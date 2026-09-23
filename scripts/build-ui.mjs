// Renderer'ı tarayıcı/Electron için paketle: dist/ui/{index.html,styles.css,renderer.js}
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'ui');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/ui/renderer/app.ts')],
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  outfile: path.join(out, 'renderer.js'), sourcemap: true, minify: process.argv.includes('--minify'),
  logLevel: 'warning',
});
for (const f of ['index.html', 'styles.css']) copyFileSync(path.join(root, 'src/ui/renderer', f), path.join(out, f));
console.log(`UI → ${path.relative(root, out)}`);
