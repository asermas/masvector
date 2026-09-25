import { vectorizeRaw, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';
import { createCanvas } from '@napi-rs/canvas';
import type { GroupNode, Paint, PathNode, SubPath, VNode } from '../common/types.js';
import { detectSoftGroups, evalPaint, segmentRegions, type Region, type SoftGroup } from './regions.js';
import { defaultStyle, newId } from '../common/ids.js';
import { VectorError } from '../common/errors.js';
import { parsePathData } from '../serialization/path-data.js';
import { transformSubPath, flattenSubPaths, segments, subpathsBBox } from '../math/bezier.js';
import { fitClosedPolygon } from '../math/fit.js';
import { decodeImageBuffer, type DecodedImage } from '../render/png.js';
import { extractPalette, labelize, modeFilter, removeSpeckles, rgbToOklab, type Palette, type Raster } from './quantize.js';

// Raster → vektör izleme hattı:
//  1) çöz + gerekirse büyüt (küçük görsellerde pürüzsüz kenar için)
//  2) OKLab palet (düz bölgelerden) → etiket haritası → çoğunluk filtresi → leke temizliği
//  3) her renk için "bu ve üstündeki renkler" maskesi (stacked: katmanlar arası boşluk olmaz) → vtracer binary spline
//  4) eğri düzeltme: eşdoğrusal kübikleri doğruya indir, çapa sayısını uydurmayla azalt
//  5) katman başına bir bileşik path, ölçek geri alınır

export type TracePreset = 'auto' | 'logo' | 'illustration' | 'lineart' | 'photo';

export interface TraceOptions {
  preset?: TracePreset;
  /** Renk sayısı (verilmezse otomatik). */
  colors?: number;
  maxColors?: number;
  /** Sabit palet (#rrggbb listesi) — kurumsal renklerle birebir eşleşme için. */
  palette?: string[];
  /** 0..1: yüksek = daha çok ayrıntı (küçük lekeler korunur, daha az yumuşatma). */
  detail?: number;
  /** 0..1: yüksek = daha pürüzsüz eğriler, daha az çapa. */
  smoothness?: number;
  /** 'auto': kenar rengi arka plan ise ayrı katman yerine frame arka planı yapılır. */
  background?: 'auto' | 'keep' | 'remove';
  /**
   * overlap (varsayılan): her renk kendi şekli; yalnız komşu olduğu üst renklerin altına ~1 px taşar → boşluk yok, şekiller bağımsız.
   * stacked: alt katman üstteki tüm renkleri de kapsar (en basit alt şekiller, ama gizli geometri).
   * abutting: şekiller birebir bitişik, üst üste binme yok (kıl payı boşluk riski).
   */
  method?: 'overlap' | 'stacked' | 'abutting';
  /** Yumuşak geçişleri gerçek doğrusal/radyal gradyan olarak geri kazan (varsayılan: illustration/photo'da açık). */
  gradients?: boolean;
  /** (Gelişmiş) Küçük görsellerde gradyan segmentasyonunun büyütme ölçeği (varsayılan 1 = kaynak çözünürlüğü). */
  segScale?: number;
}

export interface TraceResult {
  width: number; height: number;
  group: GroupNode;
  background: string | null;
  palette: { color: string; coverage: number; paths: number; anchors: number; gradient?: 'linear' | 'radial' }[];
  preset: TracePreset;
  scale: number;
  stats: { anchors: number; subpaths: number; speckles: number; noise: number; blur: number; ms: number };
  warnings: string[];
}

const hex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const parseHex = (s: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) throw new VectorError('INVALID_ARGUMENT', `Palet rengi #rrggbb olmalı: ${s}`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

function resize(img: DecodedImage, w: number, h: number): Raster {
  if (w === img.width && h === img.height) return { w, h, rgba: img.rgba };
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(img.canvas, 0, 0, w, h);
  return { w, h, rgba: x.getImageData(0, 0, w, h).data };
}

/** Basit sınıflandırma: renk çeşitliliği ve düz bölge oranı. */
function classify(img: Raster): TracePreset {
  const n = img.w * img.h, step = Math.max(1, Math.floor(n / 50_000));
  const buckets = new Map<number, number>();
  let gray = 0, total = 0;
  for (let p = 0; p < n; p += step) {
    if (img.rgba[p * 4 + 3] < 128) continue;
    const r = img.rgba[p * 4], g = img.rgba[p * 4 + 1], b = img.rgba[p * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); // 5 bit/kanal: düşük kontrastlı düz renkler ayrışsın
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    if (Math.max(r, g, b) - Math.min(r, g, b) < 24) gray++;
    total++;
  }
  if (!total) return 'logo'; // tamamen saydam: içerik yok
  const sorted = [...buckets.values()].sort((a, b) => b - a);
  const top8 = sorted.slice(0, 8).reduce((a, b) => a + b, 0) / total;
  const top32 = sorted.slice(0, 32).reduce((a, b) => a + b, 0) / total;
  // Kapsamanın %90'ına kaç renk kovası yetiyor: çok sayıda DÜZ renk (ör. 64 renkli ızgara) fotoğraf değildir
  let n90 = 0;
  for (let acc = 0; n90 < sorted.length && acc < 0.9 * total; n90++) acc += sorted[n90];
  if (gray / total > 0.97 && top8 > 0.9) return 'lineart';
  if (top8 > 0.9) return 'logo';
  if (top32 > 0.75 || n90 <= 160) return 'illustration';
  return 'photo';
}

/** Kontrol noktaları kirişe `tol` yakınsa kübiği doğruya indir; ardışık eşdoğrusal çapaları sil. */
export function straighten(sp: SubPath, tol: number): SubPath {
  const segs = segments(sp);
  const pts = sp.points.map((p) => ({ ...p }));
  const n = pts.length;
  segs.forEach((c, i) => {
    const dx = c.p3.x - c.p0.x, dy = c.p3.y - c.p0.y, L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    const off = (q: { x: number; y: number }) => Math.abs((q.x - c.p0.x) * dy - (q.y - c.p0.y) * dx) / L;
    const t = (q: { x: number; y: number }) => ((q.x - c.p0.x) * dx + (q.y - c.p0.y) * dy) / (L * L);
    if (off(c.p1) <= tol && off(c.p2) <= tol && t(c.p1) >= -0.01 && t(c.p1) <= 1.01 && t(c.p2) >= -0.01 && t(c.p2) <= 1.01) {
      delete pts[i].out;
      delete pts[(i + 1) % n].in;
    }
  });
  // Eşdoğrusal ara çapaları kaldır: aday, SON KORUNAN çapa ile bir sonraki çapa arasındaki kirişe,
  // aradaki tüm silinmiş çapalarla birlikte `tol` içinde kalıyorsa silinir (zincirleme erimeyi önler).
  const lineIn = (i: number) => !pts[i].in && !pts[(i - 1 + n) % n].out;
  const lineOut = (i: number) => !pts[i].out && !pts[(i + 1) % n].in;
  const keep: typeof pts = [];
  const startIdx = sp.closed ? Math.max(0, pts.findIndex((_, i) => !(lineIn(i) && lineOut(i)))) : 0;
  const order = Array.from({ length: n }, (_, k) => (startIdx + k) % n);
  let removed: typeof pts = [];
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const p = pts[i];
    const lastKept = keep[keep.length - 1];
    const nextIdx = order[k + 1] ?? (sp.closed ? order[0] : -1);
    const canDrop = lastKept && nextIdx >= 0 && lineIn(i) && lineOut(i) && (sp.closed || (k > 0 && k < n - 1)) && n > 3;
    if (canDrop) {
      const nx = pts[nextIdx];
      const dx = nx.x - lastKept.x, dy = nx.y - lastKept.y, L = Math.hypot(dx, dy) || 1;
      const ok = [...removed, p].every((q) => {
        const t = ((q.x - lastKept.x) * dx + (q.y - lastKept.y) * dy) / (L * L);
        return Math.abs((q.x - lastKept.x) * dy - (q.y - lastKept.y) * dx) / L <= tol && t > 0 && t < 1;
      });
      if (ok) { removed.push(p); continue; }
    }
    keep.push(p);
    removed = [];
  }
  return { closed: sp.closed, points: keep.length >= 3 || !sp.closed ? keep : pts };
}

/**
 * Keskin köşe onarımı: iki uzun DOĞRU segment arasında en çok 3 kısa segment (izlemenin yuvarladığı/pahladığı köşe)
 * varsa, bunları iki doğrunun kesişimindeki tek sivri çapayla değiştir.
 */
export function sharpenCorners(sp: SubPath, shortLen: number, minAngleDeg = 20): SubPath {
  if (!sp.closed || sp.points.length < 4) return sp;
  let pts = sp.points.map((p) => ({ ...p }));
  const isLine = (i: number) => !pts[i].out && !pts[(i + 1) % pts.length].in;
  const len = (i: number) => { const a = pts[i], b = pts[(i + 1) % pts.length]; return Math.hypot(b.x - a.x, b.y - a.y); };
  let changed = true, guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    const n = pts.length;
    if (n < 4) break;
    for (let i = 0; i < n && !changed; i++) {
      // i: uzun doğru L1 = pts[i]→pts[i+1]; ardından k kısa segment; sonra uzun doğru L2
      if (!isLine(i) || len(i) < shortLen * 2) continue;
      for (let k = 1; k <= 3; k++) {
        const j = (i + 1 + k) % n; // L2 başlangıç çapası
        if (j === i || (j + 1) % n === i) break;
        let shortTotal = 0, ok = true;
        for (let t = 1; t <= k; t++) { const si = (i + t) % n; shortTotal += len(si); if (len(si) > shortLen) ok = false; }
        if (!ok || !isLine(j) || len(j) < shortLen * 2 || shortTotal > shortLen * 1.5) continue;
        const a0 = pts[i], a1 = pts[(i + 1) % n], b0 = pts[j], b1 = pts[(j + 1) % n];
        const d1x = a1.x - a0.x, d1y = a1.y - a0.y, d2x = b1.x - b0.x, d2y = b1.y - b0.y;
        const cross = d1x * d2y - d1y * d2x;
        const ang = Math.abs(Math.atan2(cross, d1x * d2x + d1y * d2y)) * 180 / Math.PI;
        if (ang < minAngleDeg || Math.abs(cross) < 1e-9) continue;
        const t = ((b0.x - a0.x) * d2y - (b0.y - a0.y) * d2x) / cross;
        const X = { x: a0.x + t * d1x, y: a0.y + t * d1y };
        if (Math.hypot(X.x - a1.x, X.y - a1.y) > shortLen * 3 || Math.hypot(X.x - b0.x, X.y - b0.y) > shortLen * 3) continue;
        // a1..b0 arasındaki çapaları X ile değiştir
        const remove = new Set<number>();
        for (let t2 = 1; t2 <= k + 1; t2++) remove.add((i + t2) % n);
        const next: typeof pts = [];
        for (let q = 0; q < n; q++) {
          if (q === (i + 1) % n) next.push({ x: X.x, y: X.y });
          else if (!remove.has(q)) next.push(pts[q]);
        }
        pts = next;
        changed = true;
        break;
      }
    }
  }
  return { closed: true, points: pts };
}

async function traceMask(mask: Uint8Array, W: number, H: number, cfg: { speckle: number; corner: number; length: number; splice: number }): Promise<SubPath[]> {
  // Maskenin sınır kutusuna kırp (küçük bölgelerde büyük hız kazancı)
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) { const row = y * W; for (let x = 0; x < W; x++) if (mask[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  if (x1 < 0) return [];
  const pad = 4;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const px = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[(y + y0) * W + x + x0]) { const p = (y * w + x) * 4; px[p] = 0; px[p + 1] = 0; px[p + 2] = 0; }
  const svg = await vectorizeRaw(px, { width: w, height: h }, {
    colorMode: ColorMode.Binary, hierarchical: Hierarchical.Cutout, filterSpeckle: cfg.speckle, colorPrecision: 8, layerDifference: 1,
    mode: PathSimplifyMode.Spline, cornerThreshold: cfg.corner, lengthThreshold: cfg.length, maxIterations: 10, spliceThreshold: cfg.splice, pathPrecision: 3,
  });
  const out: SubPath[] = [];
  for (const m of svg.matchAll(/<path d="([^"]+)"[^>]*?(?:transform="translate\(([-\d.e]+),([-\d.e]+)\)")?\s*\/>/g)) {
    const tx = Number(m[2] ?? 0) + x0, ty = Number(m[3] ?? 0) + y0;
    for (const sp of parsePathData(m[1])) out.push(transformSubPath(sp, { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }));
  }
  return out;
}

export async function traceImage(input: Buffer | DecodedImage, o: TraceOptions = {}): Promise<TraceResult> {
  const t0 = Date.now();
  const src = Buffer.isBuffer(input) ? decodeImageBuffer(input) : input;
  if (!src) throw new VectorError('INVALID_ARGUMENT', 'Görsel çözülemedi (desteklenen: PNG, JPEG, WebP, GIF, BMP, TIFF)');
  const warnings: string[] = [];
  const W = src.width, H = src.height;
  if (W * H > 60e6) throw new VectorError('INVALID_ARGUMENT', `Görsel çok büyük (${W}×${H}); en çok 60 MP`);
  let preset = o.preset ?? 'auto';
  const probe = resize(src, Math.min(W, 800), Math.round(H * (Math.min(W, 800) / W)));
  if (preset === 'auto') preset = classify(probe);
  const detail = Math.min(1, Math.max(0, o.detail ?? (preset === 'photo' ? 0.4 : 0.6)));
  const smooth = Math.min(1, Math.max(0, o.smoothness ?? 0.5));

  // Çalışma ölçeği: kısa kenar küçükse büyüt (daha pürüzsüz kenar), çok büyükse küçült (hız)
  const longSide = Math.max(W, H);
  let k = longSide < 1600 ? Math.min(4, 1600 / longSide) : longSide > 3200 ? 3200 / longSide : 1;
  if (preset === 'photo') k = Math.min(k, 1600 / longSide);
  k = Math.round(k * 100) / 100;
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const img = resize(src, w, h);

  // Etiket haritası + etiket başına boya (düz renk veya gradyan, ORİJİNAL piksel koordinatında)
  const useGradients = o.gradients ?? (!o.palette?.length && (preset === 'illustration' || preset === 'photo'));
  let lab: Int16Array;
  let fills: Paint[];
  let models: ('solid' | 'linear' | 'radial')[];
  const softByLabel = new Map<number, { g: SoftGroup; s: number; segW: number; segH: number; labels: Int32Array; rgba: Uint8ClampedArray }>();
  const speckleArea = Math.max(1, Math.round(((1 - detail) * 12 + 1) * k * k)); // ORİJİNAL piksel cinsinden eşik × k²
  let speckles = 0;
  /** İnce yapı renkleri: maskeleri bulanıklaştırılmaz (1–2 px çizgiyi aşındırır / kalınlığını dalgalandırır). */
  const thinLabels = new Set<number>();
  if (useGradients) {
    // Segmentasyon ölçeği s: büyük görselde ≤1200 px'e küçült (hız); küçük görselde varsayılan kaynak çözünürlüğü
    // (ölçüm: çalışma ölçeğinde (≤4×) segmentasyon 2–4× yavaş ve çoğu görselde daha kötü; çok küçük/çok renkli
    // görsellerde traceBest segScale 2.5'i ayrıca dener). s < k ise etiketler sınır iyileştirmeli olarak taşınır.
    const up = k >= 2.5;
    const s = up ? Math.min(k, o.segScale ?? 1) : Math.min(1, 1200 / longSide);
    const sw = Math.max(1, Math.round(W * s)), sh = Math.max(1, Math.round(H * s));
    const segImg = sw === w && sh === h ? img : resize(src, sw, sh);
    // Eşikler gürültüye uyarlanır: temiz görselde düşük kontrastlı kenarlar da ayrılır, JPEG'de gürültü kenar sayılmaz.
    // Büyütmede kenarlar ~s piksele yayılır: piksel başı kenar eşiği s ile ölçeklenir.
    const nz = estimateNoise(probe);
    const seg = segmentRegions(segImg, {
      minArea: Math.max(6, Math.round(((1 - detail) * 30 + 6) * s * s)),
      edge: Math.min(0.05, (0.018 + nz * 0.006) / (up ? Math.max(1, s * 0.6) : 1)),
      // Eşikler yalnız ölçülen gürültüye bağlı (preset'e göre gevşetilmez: gradyanlı ikonlar da "photo" sınıflanabilir)
      maxRms: Math.min(9, Math.max(3, 2.5 + nz * 1.5)),
      outlier: Math.min(14, 5 + nz * 3),
      // Büyütmede yumuşatma karışımı şeritleri (~s px) kalın komşulara eritilir: vektörde hale kalmasın
      ...(up ? { mergeThin: true, thinRatio: 0.8 * Math.max(1, s) } : {}),
    });
    // Algısal olarak ayırt edilemeyen düz renkleri (ΔE_ok < 0.025) alanı en büyük temsilcide birleştir (tek path, daha az node)
    const reps: { lab: [number, number, number]; hex: string }[] = [];
    const snap = new Map<string, string>();
    for (const r of [...seg.regions].sort((a, b) => b.area - a.area)) {
      if (typeof r.paint !== 'string' || snap.has(r.paint)) continue;
      const [R, G, B] = parseHex(r.paint.slice(0, 7));
      if (r.paint.length > 7) { snap.set(r.paint, r.paint); continue; } // yarı saydamlar birleştirilmez
      const c = rgbToOklab(R, G, B);
      const hit = reps.find((q) => (q.lab[0] - c[0]) ** 2 + (q.lab[1] - c[1]) ** 2 + (q.lab[2] - c[2]) ** 2 < 0.025 ** 2);
      if (hit) snap.set(r.paint, hit.hex); else { reps.push({ lab: c, hex: r.paint }); snap.set(r.paint, r.paint); }
    }
    for (const r of seg.regions) if (typeof r.paint === 'string') r.paint = snap.get(r.paint) ?? r.paint;
    // Yumuşak gölge/parıltı grupları: halka bölgeler yerine tek bulanık şekil
    const softGroups = detectSoftGroups(seg, segImg, Math.max(6, Math.round(12 * s * s)), s);
    const softOf = new Map<number, number>();
    softGroups.forEach((g, gi) => g.ids.forEach((id) => softOf.set(id, gi)));
    const keyOf = (r: Region) => (softOf.has(r.id) ? `soft${softOf.get(r.id)}` : typeof r.paint === 'string' ? r.paint : `g${r.id}`);
    const groupIdx = new Map<string, number>();
    const maxId = seg.regions.reduce((m, r) => Math.max(m, r.id), -1) + 1;
    const regToLabel = new Int32Array(maxId).fill(-1);
    fills = []; models = [];
    for (const r of seg.regions) {
      const key = keyOf(r);
      let gi = groupIdx.get(key);
      if (gi === undefined) {
        gi = fills.length; groupIdx.set(key, gi);
        const sg = softOf.has(r.id) ? softGroups[softOf.get(r.id)!] : null;
        if (sg) {
          fills.push(hex(sg.rgb.map(Math.round) as [number, number, number])); models.push('solid');
          softByLabel.set(gi, { g: sg, s, segW: sw, segH: sh, labels: seg.labels, rgba: segImg.rgba });
        } else { fills.push(scalePaint(r.paint, 1 / s)); models.push(r.model); }
      }
      regToLabel[r.id] = gi;
    }
    if (fills.length > 32000) throw new VectorError('UNSUPPORTED', `Görsel çok fazla bölge üretti (${fills.length}); ayrıntıyı düşürün (detail) veya photo preset kullanın`);
    lab = new Int16Array(w * h);
    if (sw === w && sh === h) {
      for (let p = 0; p < w * h; p++) { const v = seg.labels[p]; lab[p] = v < 0 || img.rgba[p * 4 + 3] < 8 ? -1 : regToLabel[v]; }
    } else {
      // Etiketleri çalışma çözünürlüğüne taşı. Sınır piksellerinde en-yakın-komşu merdiveni yerine: komşu segment
      // bölgelerinden, boyası (o noktada değerlendirilmiş) çalışma görüntüsü rengine en yakın olan seçilir.
      const segPaint: Paint[] = new Array(maxId);
      for (const r of seg.regions) segPaint[r.id] = r.paint;
      const cand: number[] = [];
      for (let y = 0; y < h; y++) {
        const fy = ((y + 0.5) * sh) / h, sy = Math.min(sh - 1, Math.floor(fy));
        for (let x = 0; x < w; x++) {
          const fx = ((x + 0.5) * sw) / w, sx = Math.min(sw - 1, Math.floor(fx));
          const p = y * w + x;
          if (img.rgba[p * 4 + 3] < 8) { lab[p] = -1; continue; }
          cand.length = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = sx + dx, yy = sy + dy;
            if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
            const v = seg.labels[yy * sw + xx];
            if (v >= 0 && !cand.includes(v)) cand.push(v);
          }
          if (cand.length === 0) { lab[p] = -1; continue; }
          let best = cand[0];
          if (cand.length > 1) {
            let bd = Infinity;
            for (const v of cand) {
              const c = evalPaint(segPaint[v], fx, fy);
              const dd = (c[0] - img.rgba[p * 4]) ** 2 + (c[1] - img.rgba[p * 4 + 1]) ** 2 + (c[2] - img.rgba[p * 4 + 2]) ** 2 + (c[3] - img.rgba[p * 4 + 3]) ** 2;
              if (dd < bd) { bd = dd; best = v; }
            }
          }
          lab[p] = regToLabel[best];
        }
      }
    }
  } else {
    let pal: Palette;
    if (o.palette?.length) pal = extractPalette(img, { fixed: o.palette.map(parseHex) });
    // Çizim/gri tonlu: renk sayısı otomatik (saf siyah-beyazda dirsek 2'de durur; gri tonlu logolar tonlarını korur)
    else if (preset === 'lineart') pal = extractPalette(img, { k: o.colors, maxK: o.maxColors ?? 8, targetError: 0.016 });
    else pal = extractPalette(img, { k: o.colors, maxK: o.maxColors ?? (preset === 'logo' ? 16 : preset === 'illustration' ? 32 : 48), targetError: preset === 'photo' ? 0.03 : 0.016 });
    lab = labelize(img, pal);
    lab = modeFilter(lab, w, h, detail > 0.8 ? 0 : 1);
    speckles = removeSpeckles(lab, w, h, speckleArea);
    fills = pal.rgb.map(hex);
    models = fills.map(() => 'solid');
    pal.thin?.forEach((t, i) => { if (t) thinLabels.add(i); });
  }
  if (preset === 'photo') warnings.push('Fotoğraf benzeri görsel: sonuç çok sayıda şekil içerir ve fotoğrafik ayrıntı basitleşir. En iyi sonuç logo/illüstrasyon/çizimlerde alınır.');

  // Katman sırası: kapsama alanı büyükten küçüğe (en büyük altta)
  const K = fills.length;
  const area = new Float64Array(K);
  for (let p = 0; p < w * h; p++) if (lab[p] >= 0) area[lab[p]]++;
  const order = [...Array(K).keys()].filter((i) => area[i] > 0).sort((a, b) => (softByLabel.has(b) ? 1 : 0) - (softByLabel.has(a) ? 1 : 0) || area[b] - area[a]);
  const rank = new Int16Array(K).fill(-1);
  order.forEach((ci, r) => { rank[ci] = r; });

  // Arka plan: kenar piksellerinin ≥%60'ı aynı renkse
  const border = new Float64Array(K);
  let bcount = 0;
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const v = lab[y * w + x]; if (v >= 0) { border[v]++; bcount++; } }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const v = lab[y * w + x]; if (v >= 0) { border[v]++; bcount++; } }
  const bgIdx = bcount ? [...border.keys()].sort((a, b) => border[b] - border[a])[0] : -1;
  const hasTransparency = lab.some((v) => v < 0);
  const bgMode = o.background ?? 'auto';
  const bgIsLayer0 = bgIdx >= 0 && rank[bgIdx] === 0 && border[bgIdx] / bcount >= 0.6 && !hasTransparency && typeof fills[bgIdx] === 'string';
  const dropBg = bgIsLayer0 && bgMode !== 'keep';
  const background = bgIsLayer0 && bgMode === 'auto' ? (fills[bgIdx] as string) : null;

  // Parametreler (çalışma ölçeğinde)
  const cfg = {
    speckle: Math.max(1, Math.floor(Math.sqrt(speckleArea))), // vtracer: kenar uzunluğu (alan = değer²)
    corner: Math.round(40 + smooth * 50),      // yüksek = daha az köşe
    length: 2 + smooth * 4,
    splice: Math.round(30 + smooth * 30),
  };
  const method = o.method ?? 'overlap';
  // Kenar yumuşatma yarıçapı: büyütme merdivenini (k) ve ölçülen gürültüyü bastırır; ayrıntı arttıkça küçülür
  const noise = estimateNoise(probe);
  let blurR = Math.round(Math.max(0, (k > 1 ? 0.5 * k : 0) + Math.min(1.5, noise / 3) * k) * (1.2 - detail));
  // Gradyan kipinde etiketler düşük çözünürlükten büyütülür: blok basamaklarını (≈k px) silecek kadar yumuşat
  if (useGradients && k > 1) blurR = Math.max(blurR, Math.round(0.6 * k));
  const bleed = Math.max(1, Math.round(1.2 * k)); // taşma yarıçapı (çalışma pikseli)
  const fitTol = (0.25 + smooth * 0.5) * Math.max(1, k); // çalışma pikseli
  const layers: VNode[] = [];
  const palOut: TraceResult['palette'] = [];
  let anchors = 0, subpathCount = 0;
  const inv = 1 / k;
  // Etiket başına sınır kutusu (katman işlemleri yalnız bu kutuda yapılır → yüzlerce bölgede büyük hız kazancı)
  const bb = Array.from({ length: K }, () => [w, h, -1, -1]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = lab[y * w + x];
    if (v < 0) continue;
    const b = bb[v];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  const pad = bleed + 3 * blurR + 6;
  const regionLabelBBox = (id: number): [number, number, number, number] | null => {
    for (const info of softByLabel.values()) {
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let q = 0; q < info.labels.length; q++) if (info.labels[q] === id) { const x = q % info.segW, y = (q / info.segW) | 0; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      if (x1 < 0) continue;
      const fx = w / info.segW, fy = h / info.segH;
      return [Math.floor(x0 * fx), Math.floor(y0 * fy), Math.min(w - 1, Math.ceil((x1 + 1) * fx)), Math.min(h - 1, Math.ceil((y1 + 1) * fy))];
    }
    return null;
  };
  // Yarı saydam boyalar (fillOpacity<1 ya da opaklıklı gradyan durağı): taşma yapılmaz ve altlarına taşırılmaz
  // (üst üste binen yarı saydamlık iki kat koyulaşır)
  // (ölçüm: yalnız bulanık yumuşak katmanlarda gerekli; kenar yumuşatma halkalarında taşma daha doğru sonuç veriyor)
  const translucent = new Uint8Array(K);
  for (const i of softByLabel.keys()) translucent[i] = 1;
  for (let r = 0; r < order.length; r++) {
    const ci = order[r];
    if (dropBg && ci === bgIdx) continue;
    let [bx0, by0, bx1, by1] = bb[ci];
    const softInfo = softByLabel.get(ci);
    if (softInfo) for (const id of softInfo.g.shapeIds) {
      const lb = regionLabelBBox(id);
      if (!lb) continue;
      const sh = softInfo.g.shift, ex = sh ? Math.ceil(Math.abs(sh.dx) * (w / softInfo.segW)) : 0, ey = sh ? Math.ceil(Math.abs(sh.dy) * (h / softInfo.segH)) : 0;
      bx0 = Math.min(bx0, lb[0] - ex); by0 = Math.min(by0, lb[1] - ey); bx1 = Math.max(bx1, lb[2] + ex); by1 = Math.max(by1, lb[3] + ey);
    }
    if (method === 'stacked') for (let q = r; q < order.length; q++) { const o2 = bb[order[q]]; bx0 = Math.min(bx0, o2[0]); by0 = Math.min(by0, o2[1]); bx1 = Math.max(bx1, o2[2]); by1 = Math.max(by1, o2[3]); }
    bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad); bx1 = Math.min(w - 1, bx1 + pad); by1 = Math.min(h - 1, by1 + pad);
    const cw = bx1 - bx0 + 1, chh = by1 - by0 + 1;
    const cLab = new Int16Array(cw * chh);
    const mask = new Uint8Array(cw * chh);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
      const v = lab[(y + by0) * w + x + bx0];
      cLab[y * cw + x] = v;
      mask[y * cw + x] = v < 0 ? 0 : method === 'stacked' ? (rank[v] >= r ? 1 : 0) : (v === ci ? 1 : 0);
    }
    const soft = softByLabel.get(ci);
    if (soft) {
      // Şekil maskesi: grup pikselleri (yarı-alfa üstü) ∪ gölgeyi düşüren opak bölgeler — segmentasyondan en-yakın örnekle
      for (let y = 0; y < chh; y++) {
        const sy = Math.min(soft.segH - 1, Math.floor(((y + by0 + 0.5) * soft.segH) / h));
        for (let x = 0; x < cw; x++) {
          const sx = Math.min(soft.segW - 1, Math.floor(((x + bx0 + 0.5) * soft.segW) / w));
          const q = sy * soft.segW + sx, v = soft.labels[q];
          const sh = soft.g.shift;
          if (sh) {
            // Kaydırılmış gölge: yarı-alfa üstü görünür kısım ∪ örtücünün (dx,dy) kaydırılmış kopyası
            const ox = sx - sh.dx, oy = sy - sh.dy;
            const u = ox >= 0 && oy >= 0 && ox < soft.segW && oy < soft.segH ? soft.labels[oy * soft.segW + ox] : -1;
            mask[y * cw + x] = (v >= 0 && soft.g.ids.has(v) && soft.rgba[q * 4 + 3] >= soft.g.halfAlpha) || (u >= 0 && soft.g.shapeIds.has(u) && !soft.g.ids.has(u)) ? 1 : 0;
          } else mask[y * cw + x] = v >= 0 && soft.g.shapeIds.has(v) && (!soft.g.ids.has(v) || soft.rgba[q * 4 + 3] >= soft.g.halfAlpha) ? 1 : 0;
        }
      }
    } else if (method === 'overlap' && !translucent[ci]) dilateInto(mask, cLab, rank, r, cw, chh, bleed, translucent);
    smoothMask(mask, cw, chh, thinLabels.has(ci) ? 0 : blurR);
    let sps = (await traceMask(mask, cw, chh, cfg)).map((sp) => transformSubPath(sp, { a: 1, b: 0, c: 0, d: 1, e: bx0, f: by0 }));
    // Düzeltme + çapa azaltma (uydurma), sonra orijinal ölçeğe
    sps = sps.map((sp) => {
      const st = straighten(sp, 0.35 * Math.max(1, k));
      if (st.points.length < 8) return st;
      const [poly] = flattenSubPaths([st], 0.15);
      const fitted = fitClosedPolygon(poly, fitTol, 40 + smooth * 20, false, Math.max(3 * Math.max(1, k), 2 * blurR + 2));
      return fitted.points.length >= 3 && fitted.points.length < st.points.length ? straighten(fitted, 0.35 * Math.max(1, k)) : st;
    }).map((sp) => {
      const b = subpathsBBox([sp]);
      const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
      return sharpenCorners(sp, Math.max(4 * Math.max(1, k), Math.min(30 * Math.max(1, k), 0.035 * diag)));
    }).map((sp) => transformSubPath(sp, { a: inv, b: 0, c: 0, d: inv, e: 0, f: 0 }));
    if (!sps.length) continue;
    let fill = fills[ci];
    let fillOpacity: number | undefined;
    if (typeof fill === 'string' && /^#[0-9a-f]{8}$/i.test(fill)) { fillOpacity = Math.round((parseInt(fill.slice(7), 16) / 255) * 1000) / 1000; fill = fill.slice(0, 7); }
    const color = typeof fill === 'string' ? fill : fill.stops[0].color;
    const nA = sps.reduce((s, sp) => s + sp.points.length, 0);
    anchors += nA; subpathCount += sps.length;
    const label = softInfo ? `Yumuşak gölge ${r + 1} ${color}` : typeof fill === 'string' ? `Renk ${r + 1} ${color}` : `Gradyan ${r + 1} (${fill.type}, ${fill.stops.length} durak)`;
    const node: PathNode = {
      type: 'path', id: newId('path'), name: label, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      style: defaultStyle({
        fill, ...(fillOpacity !== undefined ? { fillOpacity } : {}),
        ...(softInfo ? { opacity: Math.round(softInfo.g.alpha * 1000) / 1000, filters: [{ type: 'blur' as const, radius: Math.round(((2 * softInfo.g.sigma) / softInfo.s) * 100) / 100 }] } : {}),
      }), visible: true, locked: false, subpaths: sps.map((sp) => ({ ...sp, points: sp.points.map(round3) })), fillRule: 'evenodd',
    };
    layers.push(node);
    palOut.push({ color, coverage: Math.round((10000 * area[ci]) / (w * h)) / 100, paths: sps.length, anchors: nA, ...(models[ci] !== 'solid' ? { gradient: models[ci] as 'linear' | 'radial' } : {}) });
  }
  if (!layers.length) warnings.push('İzlenecek içerik bulunamadı (görsel tek renk veya tamamen saydam olabilir)');
  const group: GroupNode = {
    type: 'group', id: newId('group'), name: `Vektör izleme (${preset}, ${layers.length} ${useGradients ? 'bölge' : 'renk'})`, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    style: defaultStyle({ fill: 'none' }), visible: true, locked: false, children: layers,
  };
  return {
    width: W, height: H, group, background, palette: palOut, preset, scale: k,
    stats: { anchors, subpaths: subpathCount, speckles, noise: Math.round(noise * 100) / 100, blur: blurR, ms: Date.now() - t0 }, warnings,
  };
}

/** Görsel gürültüsünü tahmin et: düz görünen bölgelerde 3×3 ortalamadan ortalama mutlak sapma (0–255). */
function estimateNoise(img: Raster): number {
  const { w, h, rgba } = img;
  let sum = 0, cnt = 0;
  const step = Math.max(1, Math.floor((w * h) / 200_000));
  for (let p = w + 1; p < w * (h - 1) - 1; p += step) {
    if (p % w === 0 || p % w === w - 1) continue;
    let dev = 0, maxDev = 0;
    for (let c = 0; c < 3; c++) {
      let m = 0;
      for (const q of [p - w - 1, p - w, p - w + 1, p - 1, p + 1, p + w - 1, p + w, p + w + 1]) m += rgba[q * 4 + c];
      const d = Math.abs(rgba[p * 4 + c] - m / 8);
      dev += d; maxDev = Math.max(maxDev, d);
    }
    if (maxDev < 20) { sum += dev / 3; cnt++; } // kenar değil
  }
  return cnt ? sum / cnt : 0;
}

/** İkili maskeyi kutu bulanıklığı (2 geçiş ≈ Gauss) + 0.5 eşiğiyle yumuşat: JPEG/merdiven titremesini siler, gerçek sınırı korur. */
function smoothMask(mask: Uint8Array, w: number, h: number, r: number) {
  if (r < 1) return;
  let a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = mask[i];
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) { // yatay
      let acc = 0; const row = y * w;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc / (2 * r + 1);
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) { // dikey
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / (2 * r + 1);
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  for (let i = 0; i < w * h; i++) mask[i] = a[i] >= 0.5 ? 1 : 0;
}

/** Maskeyi yalnız ÜST sıradaki renklerin piksellerine doğru `radius` kadar genişlet (alt katman üsttekinin altına girer). */
function dilateInto(mask: Uint8Array, lab: Int16Array, rank: Int16Array, r: number, w: number, h: number, radius: number, translucent?: Uint8Array) {
  let frontier: number[] = [];
  for (let p = 0; p < w * h; p++) if (mask[p]) frontier.push(p);
  for (let step = 0; step < radius; step++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < w * (h - 1) ? p + w : -1];
      for (const q of nb) {
        if (q < 0 || mask[q]) continue;
        const v = lab[q];
        if (v >= 0 && rank[v] > r && !translucent?.[v]) { mask[q] = 1; next.push(q); }
      }
    }
    frontier = next;
  }
}

/** Boya koordinatlarını ölçekle (segmentasyon pikseli → orijinal piksel). */
function scalePaint(p: Paint, f: number): Paint {
  if (typeof p === 'string' || f === 1) return p;
  if (p.type === 'linear') return { ...p, x1: p.x1 * f, y1: p.y1 * f, x2: p.x2 * f, y2: p.y2 * f };
  return { ...p, cx: p.cx * f, cy: p.cy * f, r: p.r * f, ...(p.fx !== undefined ? { fx: p.fx * f } : {}), ...(p.fy !== undefined ? { fy: p.fy * f } : {}) };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
function round3(p: SubPath['points'][number]) {
  const q: SubPath['points'][number] = { x: r3(p.x), y: r3(p.y) };
  if (p.in) q.in = { dx: r3(p.in.dx), dy: r3(p.in.dy) };
  if (p.out) q.out = { dx: r3(p.out.dx), dy: r3(p.out.dy) };
  return q;
}
