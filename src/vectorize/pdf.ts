import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Frame, VDocument } from '../common/types.js';
import { VectorError } from '../common/errors.js';
import { importSVG } from '../serialization/svg-import.js';
import { combineMaskImages } from '../render/image-ops.js';
import { cleanupFrame, type CleanupStats } from '../serialization/cleanup.js';
import { decodeImageBuffer } from '../render/png.js';
import { compareDocument, type CompareMetrics } from './compare.js';
import { walk } from '../model/scene.js';

const run = promisify(execFile);

// PDF → vektör: poppler (pdftocairo) sayfayı yüksek sadakatli SVG'ye çevirir (metin = glif eğrileri,
// kırpma yolları, gradyanlar, gömülü görseller). Sonra içe aktarılır, sadeleştirilir ve poppler'ın
// kendi raster render'ıyla piksel piksel doğrulanır. Taranmış (yalnız görsel içeren) sayfalar tespit edilip
// raster izleme hattına yönlendirilir.

async function need(bin: string) {
  try { await run(bin, ['-v']); }
  catch (e: any) {
    if (e?.code === 'ENOENT') throw new VectorError('UNSUPPORTED', `${bin} bulunamadı. Kurulum: sudo apt install poppler-utils`);
  }
}

export async function pdfInfo(file: string): Promise<{ pages: number; pageSizes: { w: number; h: number }[]; title?: string; encrypted: boolean }> {
  await need('pdfinfo');
  let out: string;
  try { out = (await run('pdfinfo', ['-l', '9999', file], { maxBuffer: 8 << 20 })).stdout; }
  catch (e: any) { throw new VectorError('INVALID_ARGUMENT', `PDF okunamadı: ${(e.stderr || e.message || '').toString().trim().slice(0, 300)}`); }
  const pages = Number(/^Pages:\s+(\d+)/m.exec(out)?.[1] ?? 0);
  const sizes = [...out.matchAll(/^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/gm)].map((m) => ({ w: +m[1], h: +m[2] }));
  if (!sizes.length) { const m = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)/m.exec(out); if (m) sizes.push({ w: +m[1], h: +m[2] }); }
  return { pages, pageSizes: sizes, title: /^Title:\s+(.+)$/m.exec(out)?.[1]?.trim(), encrypted: /^Encrypted:\s+yes/m.test(out) };
}

export async function pdfPageToSVG(file: string, page: number, tmp: string, password?: string): Promise<string> {
  const out = path.join(tmp, `p${page}.svg`);
  const pw = password ? ['-upw', password] : [];
  try { await run('pdftocairo', [...pw, '-svg', '-f', String(page), '-l', String(page), file, out], { maxBuffer: 64 << 20, timeout: 120_000 }); }
  catch (e: any) { throw new VectorError('INVALID_ARGUMENT', `pdftocairo sayfa ${page}: ${(e.stderr || e.message || '').toString().trim().slice(0, 300)}`); }
  return readFile(out, 'utf8');
}

/** Referans raster (doğrulama ve taranmış sayfa izleme için). */
export async function pdfPageToPNG(file: string, page: number, dpi: number, tmp: string, password?: string): Promise<Buffer> {
  const base = path.join(tmp, `r${page}_${dpi}`);
  const pw = password ? ['-upw', password] : [];
  await run('pdftoppm', [...pw, '-r', String(dpi), '-f', String(page), '-l', String(page), '-png', '-singlefile', '-aa', 'yes', '-aaVector', 'yes', file, base], { maxBuffer: 16 << 20, timeout: 120_000 });
  return readFile(`${base}.png`);
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
  const info = await pdfInfo(file);
  if (!info.pages) throw new VectorError('INVALID_ARGUMENT', 'PDF sayfa içermiyor');
  const pages = (o.pages?.length ? o.pages : Array.from({ length: info.pages }, (_, i) => i + 1)).filter((p) => p >= 1 && p <= info.pages);
  if (!pages.length) throw new VectorError('INVALID_ARGUMENT', `Geçersiz sayfa seçimi (PDF ${info.pages} sayfa)`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'masvector-pdf-'));
  const results: PdfPageResult[] = [];
  try {
    for (const page of pages) {
      const svg = await pdfPageToSVG(file, page, tmp, o.password);
      const imp = importSVG(svg, { combineMask: combineMaskImages, title: info.title });
      const frame = imp.frame;
      frame.name = `Sayfa ${page}`;
      const res: PdfPageResult = { page, frame, kind: 'vector', warnings: imp.warnings };
      if (isScanned(frame)) {
        res.kind = 'scanned';
        res.raster = await pdfPageToPNG(file, page, 300, tmp, o.password);
      } else {
        if (o.cleanup !== false) res.cleanup = cleanupFrame(frame);
        const dpi = o.verifyDpi ?? 144;
        if (dpi > 0) {
          const ref = decodeImageBuffer(await pdfPageToPNG(file, page, dpi, tmp, o.password));
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
