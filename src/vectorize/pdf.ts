import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Frame, VDocument } from '../common/types.js';
import { VectorError } from '../common/errors.js';
import { importSVG } from '../serialization/svg-import.js';
import { combineMaskImages } from '../render/image-ops.js';
import { cleanupFrame, type CleanupStats } from '../serialization/cleanup.js';
import { decodeImageBuffer } from '../render/png.js';
import { compareDocument, type CompareMetrics } from './compare.js';
import { walk } from '../model/scene.js';

const execP = promisify(execFile);

// Poppler araçları: Windows paketinde uygulamayla birlikte gelir (vendor/poppler-win), Linux/macOS'ta sistemden.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
function popplerDir(): string | null {
  const cands = [
    process.env.MASVECTOR_POPPLER,
    path.join(ROOT, 'vendor', 'poppler-win', 'bin'),   // geliştirme / asar'sız paket
    path.join(ROOT, '..', 'poppler-win', 'bin'),       // electron-builder extraResources
  ];
  for (const d of cands) if (d && existsSync(path.join(d, `pdftocairo${EXE}`))) return d;
  return null;
}
const PDIR = process.platform === 'win32' ? popplerDir() : process.env.MASVECTOR_POPPLER ?? null;
const POPPLER_ENV = PDIR && existsSync(path.join(PDIR, '..', 'etc', 'fonts', 'fonts.conf'))
  ? { ...process.env, FONTCONFIG_FILE: path.join(PDIR, '..', 'etc', 'fonts', 'fonts.conf') }
  : process.env;
const run = (bin: string, args: string[], o: { maxBuffer?: number; timeout?: number; cwd?: string } = {}) =>
  execP(PDIR ? path.join(PDIR, bin + EXE) : bin, args, { ...o, env: POPPLER_ENV, windowsHide: true });

// PDF → vektör: poppler (pdftocairo) sayfayı yüksek sadakatli SVG'ye çevirir (metin = glif eğrileri,
// kırpma yolları, gradyanlar, gömülü görseller). Sonra içe aktarılır, sadeleştirilir ve poppler'ın
// kendi raster render'ıyla piksel piksel doğrulanır. Taranmış (yalnız görsel içeren) sayfalar tespit edilip
// raster izleme hattına yönlendirilir.

async function need(bin: string) {
  try { await run(bin, ['-v']); }
  catch (e: any) {
    if (e?.code === 'ENOENT') throw new VectorError('UNSUPPORTED', process.platform === 'win32' ? `${bin}.exe bulunamadı (uygulamayla gelen poppler-win eksik; MASVECTOR_POPPLER ile dizin verilebilir)` : `${bin} bulunamadı. Kurulum: sudo apt install poppler-utils`);
  }
}

export async function pdfInfo(file: string, cwd?: string): Promise<{ pages: number; pageSizes: { w: number; h: number }[]; title?: string; encrypted: boolean }> {
  await need('pdfinfo');
  let out: string;
  try { out = (await run('pdfinfo', ['-l', '9999', file], { maxBuffer: 8 << 20, cwd })).stdout; }
  catch (e: any) { throw new VectorError('INVALID_ARGUMENT', `PDF okunamadı: ${(e.stderr || e.message || '').toString().trim().slice(0, 300)}`); }
  const pages = Number(/^Pages:\s+(\d+)/m.exec(out)?.[1] ?? 0);
  const sizes = [...out.matchAll(/^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/gm)].map((m) => ({ w: +m[1], h: +m[2] }));
  if (!sizes.length) { const m = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)/m.exec(out); if (m) sizes.push({ w: +m[1], h: +m[2] }); }
  return { pages, pageSizes: sizes, title: /^Title:\s+(.+)$/m.exec(out)?.[1]?.trim(), encrypted: /^Encrypted:\s+yes/m.test(out) };
}

export async function pdfPageToSVG(file: string, page: number, tmp: string, password?: string): Promise<string> {
  // Göreli adlar + cwd: Windows'ta poppler ASCII dışı yolları (ör. kullanıcı adındaki ı/ş) açamayabilir
  const out = `p${page}.svg`;
  const pw = password ? ['-upw', password] : [];
  try { await run('pdftocairo', [...pw, '-svg', '-f', String(page), '-l', String(page), file, out], { maxBuffer: 64 << 20, timeout: 120_000, cwd: tmp }); }
  catch (e: any) { throw new VectorError('INVALID_ARGUMENT', `pdftocairo sayfa ${page}: ${(e.stderr || e.message || '').toString().trim().slice(0, 300)}`); }
  return readFile(path.join(tmp, out), 'utf8');
}

/** Referans raster (doğrulama ve taranmış sayfa izleme için). */
export async function pdfPageToPNG(file: string, page: number, dpi: number, tmp: string, password?: string): Promise<Buffer> {
  const base = `r${page}_${dpi}`;
  const pw = password ? ['-upw', password] : [];
  await run('pdftoppm', [...pw, '-r', String(dpi), '-f', String(page), '-l', String(page), '-png', '-singlefile', '-aa', 'yes', '-aaVector', 'yes', file, base], { maxBuffer: 16 << 20, timeout: 120_000, cwd: tmp });
  return readFile(path.join(tmp, `${base}.png`));
}

export interface PdfPageResult {
  page: number;
  frame: Frame;
  kind: 'vector' | 'scanned';
  cleanup?: CleanupStats;
  fidelity?: CompareMetrics;
  warnings: string[];
  /** Taranmış sayfada izleme için hazır referans raster. */
  raster?: Buffer;
}

/** Sayfanın esasen tek bir büyük raster görsel olup olmadığını (taranmış belge) tespit et. */
function isScanned(frame: Frame): boolean {
  let imgArea = 0, vectorLeaves = 0;
  for (const w of walk(frame.nodes)) {
    const n = w.node;
    if (n.type === 'image') imgArea = Math.max(imgArea, n.width * n.height * Math.abs(n.transform.a * n.transform.d - n.transform.b * n.transform.c));
    else if (n.type !== 'group') vectorLeaves++;
  }
  return imgArea >= 0.6 * frame.w * frame.h && vectorLeaves <= 3;
}

export interface PdfImportOptions {
  pages?: number[];
  /** Doğrulama çözünürlüğü (dpi). 0 = doğrulama yok. */
  verifyDpi?: number;
  cleanup?: boolean;
  password?: string;
}

export async function importPDF(file: string, o: PdfImportOptions = {}): Promise<{ info: Awaited<ReturnType<typeof pdfInfo>>; pages: PdfPageResult[] }> {
  await need('pdftocairo');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'masvector-pdf-'));
  const results: PdfPageResult[] = [];
  let info: Awaited<ReturnType<typeof pdfInfo>>;
  try {
    // Poppler'a hep geçici dizindeki ASCII adlı kopya verilir (Windows'ta ASCII dışı yollar güvenilmez)
    const src = 'in.pdf';
    await copyFile(file, path.join(tmp, src));
    info = await pdfInfo(src, tmp);
    if (!info.pages) throw new VectorError('INVALID_ARGUMENT', 'PDF sayfa içermiyor');
    const pages = (o.pages?.length ? o.pages : Array.from({ length: info.pages }, (_, i) => i + 1)).filter((p) => p >= 1 && p <= info.pages);
    if (!pages.length) throw new VectorError('INVALID_ARGUMENT', `Geçersiz sayfa seçimi (PDF ${info.pages} sayfa)`);
    for (const page of pages) {
      const svg = await pdfPageToSVG(src, page, tmp, o.password);
      const imp = importSVG(svg, { combineMask: combineMaskImages, title: info.title });
      const frame = imp.frame;
      frame.name = `Sayfa ${page}`;
      const res: PdfPageResult = { page, frame, kind: 'vector', warnings: imp.warnings };
      if (isScanned(frame)) {
        res.kind = 'scanned';
        res.raster = await pdfPageToPNG(src, page, 300, tmp, o.password);
      } else {
        if (o.cleanup !== false) res.cleanup = cleanupFrame(frame);
        const dpi = o.verifyDpi ?? 144;
        if (dpi > 0) {
          const ref = decodeImageBuffer(await pdfPageToPNG(src, page, dpi, tmp, o.password));
          if (ref) {
            const doc: VDocument = { ...imp.doc, pages: [{ ...imp.doc.pages[0], frames: [frame] }] };
            res.fidelity = compareDocument(doc, ref).metrics;
          }
        }
      }
      results.push(res);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { info, pages: results };
}
