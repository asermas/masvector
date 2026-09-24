// Linux'ta Windows paketi çıkarırken: yerel (N-API) modüllerin win32-x64 derlemelerini node_modules'e koy.
// npm platform uyuşmazlığında bunları kurmaz; paketi npm pack ile indirip elle açıyoruz.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arch = process.argv[2] ?? 'x64';
const bases = ['@napi-rs/canvas', '@neplex/vectorizer'];
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mv-natives-'));
try {
  for (const base of bases) {
    const version = JSON.parse(readFileSync(path.join(root, 'node_modules', base, 'package.json'), 'utf8')).version;
    const name = `${base}-win32-${arch}-msvc`;
    const tgz = execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp, '--silent'], { cwd: tmp, encoding: 'utf8' }).trim().split('\n').pop();
    const dest = path.join(root, 'node_modules', name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', dest, '--strip-components=1']);
    console.log(`✓ ${name}@${version}`);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
