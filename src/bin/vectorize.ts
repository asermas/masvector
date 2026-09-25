#!/usr/bin/env node
// Sunucusuz vektörleştirme: PDF / görsel → SVG (+ PDF, JSON, PNG önizleme, fark haritası, rapor).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from './args.js';
import { isPdf, pdfToDoc, vectorizeImageToDoc, type VectorizeImageOptions } from '../vectorize/index.js';
import { frameToSVG } from '../serialization/svg-export.js';
import { documentToPDF } from '../serialization/pdf-export.js';
import { serializeJSON } from '../serialization/json.js';
import { renderPNG, nodeImage } from '../render/png.js';
import { compareDocument } from '../vectorize/compare.js';
import { walk } from '../model/scene.js';
import type { VDocument } from '../common/types.js';

const args = parseArgs();
// İlk konumsal argüman = girdi (değer alan --seçeneklerin değerleri atlanır)
const FLAGS = new Set(['help', 'diff', 'no-reference', 'overwrite']);
let input: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { if (!FLAGS.has(a.slice(2)) && !a.includes('=')) i++; continue; }
  input = a; break;
}
if (args.help || !input) {
  console.error(`masvector-vectorize — PDF/görsel → profesyonel vektör

Kullanım: masvector-vectorize <girdi.pdf|png|jpg|webp|...> [seçenekler]

  --out YOL           Çıktı tabanı (varsayılan: girdi adı + .svg). Çok sayfalıda -s1, -s2 eklenir.
                      Çıktı girdiyle aynı dosyaya düşerse varsayılan tabana -vektor eklenir
  --overwrite         Çıktı girdi dosyasının üzerine yazabilir (açıkça istenmedikçe asla)
  --formats LISTE     svg,pdf,json,png (varsayılan: svg,json)
  --pages 1,3         PDF sayfaları (varsayılan: tümü)
  --preset P          auto|logo|illustration|lineart|photo
  --colors N          Tam renk sayısı      --max-colors N
  --palette LISTE     Sabit palet: #d91933,#193373,...
  --detail 0..1       Ayrıntı (varsayılan 0.6)   --smoothness 0..1 (varsayılan 0.5)
  --background B      auto|keep|remove
  --method M          overlap|stacked|abutting
  --no-reference      Referans (kaynak) katmanı ekleme
  --diff              Fark haritası PNG'si yaz (…-fark.png)
  --password P        Şifreli PDF parolası
Rapor (sadakat metrikleri) stdout'a JSON olarak yazılır.`);
  process.exit(input ? 0 : 1);
}

const num = (k: string) => (typeof args[k] === 'string' ? Number(args[k]) : undefined);
const trace: VectorizeImageOptions = {
  preset: args.preset as VectorizeImageOptions['preset'],
  colors: num('colors'), maxColors: num('max-colors'),
  palette: typeof args.palette === 'string' ? args.palette.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  detail: num('detail'), smoothness: num('smoothness'),
  background: args.background as VectorizeImageOptions['background'],
  method: args.method as VectorizeImageOptions['method'],
  keepReference: args.reference !== false,
};
const formats = new Set(String(args.formats ?? 'svg,json').split(',').map((s) => s.trim()));
const abs = path.resolve(input);
let base = typeof args.out === 'string' ? path.resolve(args.out).replace(/\.(svg|pdf|json|png)$/i, '') : abs.replace(/\.[^.]+$/, '');
// Kaynağı koru: bir çıktı yolu girdiyle aynıysa (x.pdf + --formats pdf) asla sessizce ezme.
const EXT: Record<string, string> = { svg: '.svg', pdf: '.pdf', png: '.png', json: '.masvector.json' };
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const collides = (b: string) => [...formats].some((f) => EXT[f] && norm(b + EXT[f]) === norm(abs));
if (!args.overwrite && collides(base)) {
  if (typeof args.out === 'string') {
    console.error(`Hata: çıktı girdi dosyasının üzerine yazar (${abs}). Başka bir --out verin ya da --overwrite ekleyin.`);
    process.exit(2);
  }
  base += '-vektor';
}
await mkdir(path.dirname(base), { recursive: true });

const t0 = Date.now();
const buf = await readFile(abs);
let doc: VDocument;
let reports: unknown[];
if (isPdf(abs, buf)) {
  const pages = typeof args.pages === 'string' ? args.pages.split(',').map(Number).filter(Boolean) : undefined;
  const r = await pdfToDoc(abs, { pages, password: typeof args.password === 'string' ? args.password : undefined, trace });
  doc = r.doc; reports = r.reports;
} else {
  const r = await vectorizeImageToDoc(buf, { ...trace, title: path.basename(abs) });
  doc = r.doc; reports = [{ page: 1, frameId: doc.pages[0].frames[0].id, ...r.report }];
}

const frames = doc.pages[0].frames;
const written: string[] = [];
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const stem = frames.length > 1 ? `${base}-s${i + 1}` : base;
  const single: VDocument = { ...doc, pages: [{ ...doc.pages[0], frames: [f] }] };
  if (formats.has('svg')) { await writeFile(`${stem}.svg`, frameToSVG(f, { skipHidden: true })); written.push(`${stem}.svg`); }
  if (formats.has('pdf')) { await writeFile(`${stem}.pdf`, documentToPDF(single).pdf); written.push(`${stem}.pdf`); }
  if (formats.has('png')) { await writeFile(`${stem}.png`, renderPNG(single, { scale: 2 }).png); written.push(`${stem}.png`); }
  if (args.diff) {
    // Referans katmanındaki kaynakla karşılaştır
    let ref = null as null | { rgba: Uint8ClampedArray; width: number; height: number };
    for (const w of walk(f.nodes)) if (w.node.type === 'image' && w.ancestors.some((a) => a.locked)) { const d = nodeImage(w.node.href); if (d) ref = d; break; }
    if (ref) { await writeFile(`${stem}-fark.png`, compareDocument(single, ref).heatmap()); written.push(`${stem}-fark.png`); }
  }
}
if (formats.has('json')) { await writeFile(`${base}.masvector.json`, serializeJSON(doc)); written.push(`${base}.masvector.json`); }
console.log(JSON.stringify({ input: abs, ms: Date.now() - t0, written, pages: reports }, null, 2));
