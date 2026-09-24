import path from 'node:path';
import type { Frame, GroupNode, ImageNode, VDocument, VNode } from '../common/types.js';
import { defaultStyle, newId } from '../common/ids.js';
import { VectorError } from '../common/errors.js';
import { createDocument } from '../model/scene.js';
import { decodeImageBuffer, type DecodedImage } from '../render/png.js';
import { rgbaToDataUri } from '../render/image-ops.js';
import { traceImage, type TraceOptions, type TraceResult } from './trace.js';
import { compareDocument, median3, type CompareMetrics } from './compare.js';
import { importPDF, type PdfImportOptions } from './pdf.js';

// Üst düzey vektörleştirme API'si: Document Server, MCP ve CLI aynı fonksiyonları kullanır.

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
/** JPEG veya kayıplı WebP (VP8) mi? */
export const isLossy = (buf: Buffer) => (buf[0] === 0xff && buf[1] === 0xd8) || (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 16) === 'WEBPVP8 ');
export const isPdf = (file: string, buf?: Buffer) => /\.pdf$/i.test(file) || (!!buf && buf.subarray(0, 5).toString('latin1') === '%PDF-');

export interface VectorizeImageOptions extends TraceOptions {
  /** Kalite hedefi karşılanmazsa parametreleri ayarlayıp yeniden dene (varsayılan true). */
  refine?: boolean;
  /** Kaynak kayıplı sıkıştırılmış (JPEG/kayıplı WebP): ölçüt gürültüsü giderilmiş kaynağa karşı yapılır. */
  lossySource?: boolean;
  /** Kaynak görseli kilitli+gizli "Referans" katmanı olarak ekle (varsayılan true). */
  keepReference?: boolean;
  name?: string;
}

export interface VectorizeReport {
  kind: 'image' | 'pdf-vector' | 'pdf-scanned';
  preset?: string;
  fidelity: CompareMetrics | null;
  palette?: TraceResult['palette'];
  stats?: TraceResult['stats'];
  attempts?: { options: Partial<TraceOptions>; pctOff: number; anchors: number }[];
  cleanup?: unknown;
  warnings: string[];
}

function referenceImage(img: DecodedImage, w: number, h: number): ImageNode {
  return {
    type: 'image', id: newId('image'), name: 'Kaynak görsel', transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    style: defaultStyle({ fill: 'none' }), visible: true, locked: false, x: 0, y: 0, width: w, height: h,
    href: rgbaToDataUri(img.rgba, img.width, img.height),
  };
}

const layer = (name: string, children: VNode[], extra: Partial<GroupNode> = {}): GroupNode => ({
  type: 'group', id: newId('layer'), name, isLayer: true, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  style: defaultStyle({ fill: 'none' }), visible: true, locked: false, children, ...extra,
});

/** İzle + doğrula; gerekirse ayarları sıkılaştırıp tekrar dene ve en iyisini seç. */
export async function traceBest(img: DecodedImage, o: VectorizeImageOptions = {}) {
  const attempts: VectorizeReport['attempts'] = [];
  let ref: { rgba: Uint8ClampedArray; width: number; height: number } | null = null;
  let refKind: 'kaynak' | 'gürültüsü giderilmiş kaynak' = 'kaynak';
  const evaluate = async (opts: TraceOptions) => {
    const r = await traceImage(img, opts);
    // Gürültülü kaynakta (JPEG vb.) ölçüt, gürültüyü değil şekli ölçsün: 3×3 medyanla temizlenmiş kaynağa karşı
    if (!ref) {
      if (r.stats.noise > 0.5 || o.lossySource) { ref = { rgba: median3(img.rgba, img.width, img.height), width: img.width, height: img.height }; refKind = 'gürültüsü giderilmiş kaynak'; }
      else ref = { rgba: img.rgba, width: img.width, height: img.height };
    }
    const doc = createDocument('t', r.width, r.height);
    const f = doc.pages[0].frames[0];
    f.background = r.background ?? 'none';
    f.nodes = [r.group];
    const m = { ...compareDocument(doc, ref).metrics, reference: refKind };
    attempts.push({ options: { colors: opts.colors, detail: opts.detail, maxColors: opts.maxColors, smoothness: opts.smoothness, gradients: opts.gradients }, pctOff: m.pctOff, anchors: r.stats.anchors });
    return { r, m };
  };
  // Palet (düz renk) ve gradyan kiplerini ikisini de dene, ölçüte göre seç (sınıflandırma yanılabilir)
  let best = await evaluate(o);
  if (o.gradients === undefined && !o.palette?.length) {
    const usedGradients = best.r.group.children.some((c) => c.type === 'path' && typeof c.style.fill !== 'string') || /bölge/.test(best.r.group.name ?? '');
    const alt = await evaluate({ ...o, gradients: !usedGradients });
    // Daha basit sonuç (daha az çapa) tercih edilir; karmaşık olan ancak hatayı belirgin VE mutlak olarak azaltıyorsa seçilir
    const [simple, complex] = alt.r.stats.anchors <= best.r.stats.anchors ? [alt, best] : [best, alt];
    const complexWins = complex.m.pctOff < simple.m.pctOff * 0.6 && simple.m.pctOff - complex.m.pctOff > 0.3;
    const better = (complexWins ? complex : simple) === alt;
    if (better) best = alt;
  }
  if (o.refine !== false && !o.palette?.length && best.m.pctOff > 0.5 && best.r.preset !== 'photo') {
    const tries: TraceOptions[] = [
      { ...o, gradients: best.r.group.name?.includes('bölge'), detail: Math.min(1, (o.detail ?? 0.6) + 0.25) },
      { ...o, gradients: best.r.group.name?.includes('bölge'), detail: Math.min(1, (o.detail ?? 0.6) + 0.25), maxColors: Math.round((o.maxColors ?? 16) * 1.75), colors: o.colors ? o.colors + 2 : undefined },
    ];
    for (const t of tries) {
      const c = await evaluate(t);
      // Hata belirgin düşüyorsa (≥%20) daha çok çapayı kabul et
      if (c.m.pctOff < best.m.pctOff * 0.8) best = c;
      if (best.m.pctOff <= 0.5) break;
    }
  }
  return { ...best, attempts };
}

/** Görsel → yeni belge (Referans + Vektör katmanları). */
export async function vectorizeImageToDoc(buf: Buffer, o: VectorizeImageOptions & { title?: string } = {}): Promise<{ doc: VDocument; report: VectorizeReport; vectorGroupId: string; referenceId: string | null }> {
  const img = decodeImageBuffer(buf);
  if (!img) throw new VectorError('INVALID_ARGUMENT', 'Görsel çözülemedi (PNG, JPEG, WebP, GIF, BMP, TIFF desteklenir)');
  const { r, m, attempts } = await traceBest(img, { lossySource: isLossy(buf), ...o });
  const doc = createDocument(o.title ?? 'Vektörleştirilmiş görsel', r.width, r.height);
  const frame = doc.pages[0].frames[0];
  frame.background = r.background ?? 'none';
  r.group.name = o.name ?? r.group.name;
  const ref = o.keepReference !== false ? referenceImage(img, r.width, r.height) : null;
  frame.nodes = [
    ...(ref ? [layer('Referans (kaynak)', [ref], { visible: false, locked: true })] : []),
    layer('Vektör', [r.group]),
  ];
  return {
    doc, vectorGroupId: r.group.id, referenceId: ref?.id ?? null,
    report: { kind: 'image', preset: r.preset, fidelity: m, palette: r.palette, stats: r.stats, attempts, warnings: r.warnings },
  };
}

/** Mevcut belgeye yerleştirmek için: izleme grubunu hedef boyuta ölçeklenmiş olarak döndür. */
export async function vectorizeImageAsGroup(buf: Buffer, o: VectorizeImageOptions & { placement?: { x: number; y: number; width?: number; height?: number } } = {}) {
  const img = decodeImageBuffer(buf);
  if (!img) throw new VectorError('INVALID_ARGUMENT', 'Görsel çözülemedi');
  const { r, m, attempts } = await traceBest(img, { lossySource: isLossy(buf), ...o });
  const p = o.placement ?? { x: 0, y: 0 };
  const sx = p.width ? p.width / r.width : p.height ? p.height / r.height : 1;
  const sy = p.height && p.width ? p.height / r.height : sx;
  const g: GroupNode = {
    type: 'group', id: newId('group'), name: o.name ?? r.group.name, transform: { a: sx, b: 0, c: 0, d: sy, e: p.x, f: p.y },
    style: defaultStyle({ fill: 'none' }), visible: true, locked: false, children: [],
  };
  if (r.background && o.background !== 'remove') {
    g.children.push({ type: 'rect', id: newId('rect'), name: 'Arka plan', transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, style: defaultStyle({ fill: r.background }), visible: true, locked: false, x: 0, y: 0, width: r.width, height: r.height });
  }
  g.children.push(r.group);
  if (o.keepReference) {
    const ref = referenceImage(img, r.width, r.height);
    ref.visible = false; ref.locked = true; ref.name = 'Referans (kaynak)';
    g.children.unshift(ref);
  }
  return { group: g, report: { kind: 'image', preset: r.preset, fidelity: m, palette: r.palette, stats: r.stats, attempts, warnings: r.warnings } as VectorizeReport };
}

/** PDF → yeni belge: her sayfa ayrı frame (yan yana). Taranmış sayfalar izlenir. */
export async function pdfToDoc(file: string, o: PdfImportOptions & { trace?: VectorizeImageOptions; traceScanned?: boolean } = {}) {
  const res = await importPDF(file, o);
  const doc = createDocument(res.info.title ?? path.basename(file, path.extname(file)), 100, 100);
  const page = doc.pages[0];
  page.frames = [];
  const reports: (VectorizeReport & { page: number; frameId: string })[] = [];
  let x = 0;
  for (const p of res.pages) {
    const frame: Frame = p.frame;
    frame.x = x; frame.y = 0;
    x += frame.w + 40;
    if (p.kind === 'scanned' && o.traceScanned !== false && p.raster) {
      const img = decodeImageBuffer(p.raster)!;
      const { r, m, attempts } = await traceBest(img, o.trace ?? {});
      const s = frame.w / r.width;
      r.group.transform = { a: s, b: 0, c: 0, d: frame.h / r.height, e: 0, f: 0 };
      const ref = referenceImage(img, frame.w, frame.h);
      frame.background = r.background ?? 'none';
      frame.nodes = [layer('Referans (taranmış sayfa)', [ref], { visible: false, locked: true }), layer('Vektör', [r.group])];
      reports.push({ page: p.page, frameId: frame.id, kind: 'pdf-scanned', preset: r.preset, fidelity: m, palette: r.palette, stats: r.stats, attempts, warnings: [...p.warnings, ...r.warnings, 'Sayfa taranmış (raster) görünüyor; 300 dpi üzerinden vektör izleme yapıldı'] });
    } else {
      reports.push({ page: p.page, frameId: frame.id, kind: 'pdf-vector', fidelity: p.fidelity ?? null, cleanup: p.cleanup, warnings: p.warnings });
    }
    page.frames.push(frame);
  }
  return { doc, info: res.info, reports };
}
