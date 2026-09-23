import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DocumentEngine } from '../server/engine.js';
import { parseJSON } from '../serialization/json.js';
import { importSVG } from '../serialization/svg-import.js';
import { DOC_FILENAME } from '../common/ids.js';

/** CLI argümanlarından motor kur; --file varsa yükle, yoksa otomatik kayıt dosyasını devam ettir. */
export function engineFromArgs(args: Record<string, string | boolean>, log: (m: string) => void): DocumentEngine {
  const workspace = path.resolve(String(args.workspace ?? process.cwd()));
  const file = typeof args.file === 'string' ? args.file : DOC_FILENAME;
  const autosave = args.autosave === false ? null : file.toLowerCase().endsWith('.json') ? file : DOC_FILENAME;
  const engine = new DocumentEngine({ workspace, autosave, allowAnyPath: args['allow-any-path'] === true });
  const abs = path.resolve(workspace, file);
  if (existsSync(abs)) {
    const text = readFileSync(abs, 'utf8');
    engine.doc = abs.toLowerCase().endsWith('.svg') ? importSVG(text).doc : parseJSON(text);
    log(`Belge yüklendi: ${abs} (v${engine.doc.version})`);
  } else log(`Yeni belge (kayıt: ${autosave ? path.resolve(workspace, autosave) : 'kapalı'})`);
  return engine;
}

export function onShutdown(fn: () => Promise<void>) {
  let done = false;
  const go = async () => { if (done) return; done = true; try { await fn(); } finally { process.exit(0); } };
  process.on('SIGINT', go);
  process.on('SIGTERM', go);
}
