import { vectorizeRaw, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';
import { createCanvas } from '@napi-rs/canvas';
import type { GroupNode, PathNode, SubPath, VNode } from '../common/types.js';
import { defaultStyle, newId } from '../common/ids.js';
import { VectorError } from '../common/errors.js';
import { parsePathData } from '../serialization/path-data.js';
import { transformSubPath, flattenSubPaths, segments, subpathsBBox } from '../math/bezier.js';
import { fitClosedPolygon } from '../math/fit.js';
import { decodeImageBuffer, type DecodedImage } from '../render/png.js';
import { extractPalette, labelize, modeFilter, removeSpeckles, type Palette, type Raster } from './quantize.js';

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
}

export interface TraceResult {
  width: number; height: number;
  group: GroupNode;
  background: string | null;
  palette: { color: string; coverage: number; paths: number; anchors: number }[];
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
    buckets.set(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4), (buckets.get(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)) ?? 0) + 1);
    if (Math.max(r, g, b) - Math.min(r, g, b) < 24) gray++;
    total++;
  }
  const sorted = [...buckets.values()].sort((a, b) => b - a);
  const top8 = sorted.slice(0, 8).reduce((a, b) => a + b, 0) / Math.max(total, 1);
  const top32 = sorted.slice(0, 32).reduce((a, b) => a + b, 0) / Math.max(total, 1);
  if (gray / Math.max(total, 1) > 0.97 && top8 > 0.9) return 'lineart';
  if (top8 > 0.9) return 'logo';
  if (top32 > 0.75) return 'illustration';
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

async function traceMask(mask: Uint8Array, w: number, h: number, cfg: { speckle: number; corner: number; length: number; splice: number }): Promise<SubPath[]> {
  const px = Buffer.alloc(w * h * 4, 255);
  for (let p = 0; p < w * h; p++) if (mask[p]) { px[p * 4] = 0; px[p * 4 + 1] = 0; px[p * 4 + 2] = 0; }
  const svg = await vectorizeRaw(px, { width: w, height: h }, {
    colorMode: ColorMode.Binary, hierarchical: Hierarchical.Cutout, filterSpeckle: cfg.speckle, colorPrecision: 8, layerDifference: 1,
    mode: PathSimplifyMode.Spline, cornerThreshold: cfg.corner, lengthThreshold: cfg.length, maxIterations: 10, spliceThreshold: cfg.splice, pathPrecision: 3,
  });
  const out: SubPath[] = [];
  for (const m of svg.matchAll(/<path d="([^"]+)"[^>]*?(?:transform="translate\(([-\d.e]+),([-\d.e]+)\)")?\s*\/>/g)) {
    const tx = Number(m[2] ?? 0), ty = Number(m[3] ?? 0);
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

  // Palet
  let pal: Palette;
  if (o.palette?.length) pal = extractPalette(img, { fixed: o.palette.map(parseHex) });
  else if (preset === 'lineart') pal = extractPalette(img, { k: o.colors ?? 2 });
  else pal = extractPalette(img, { k: o.colors, maxK: o.maxColors ?? (preset === 'logo' ? 16 : preset === 'illustration' ? 32 : 48), targetError: preset === 'photo' ? 0.03 : 0.016 });
  if (preset === 'photo') warnings.push('Fotoğraf benzeri görsel: vektör sonucu posterize görünür ve çok sayıda şekil içerir. En iyi sonuç logo/illüstrasyon/çizimlerde alınır.');

  // Etiketler + temizlik
  let lab = labelize(img, pal);
  lab = modeFilter(lab, w, h, detail > 0.8 ? 0 : 1);
  // Leke eşiği ORİJİNAL piksel cinsinden (küçük görsellerde noktalar/i-noktaları korunmalı)
  const speckleArea = Math.max(1, Math.round(((1 - detail) * 12 + 1) * k * k));
  const speckles = removeSpeckles(lab, w, h, speckleArea);

  // Katman sırası: kapsama alanı büyükten küçüğe (en büyük altta)
  const K = pal.colors.length;
  const area = new Float64Array(K);
  for (let p = 0; p < w * h; p++) if (lab[p] >= 0) area[lab[p]]++;
  const order = [...Array(K).keys()].filter((i) => area[i] > 0).sort((a, b) => area[b] - area[a]);
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
  const bgIsLayer0 = bgIdx >= 0 && rank[bgIdx] === 0 && border[bgIdx] / bcount >= 0.6 && !hasTransparency;
  const dropBg = bgIsLayer0 && bgMode !== 'keep';
  const background = bgIsLayer0 && bgMode === 'auto' ? hex(pal.rgb[bgIdx]) : null;

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
  const blurR = Math.round(Math.max(0, (k > 1 ? 0.5 * k : 0) + Math.min(1.5, noise / 3) * k) * (1.2 - detail));
  const bleed = Math.max(1, Math.round(1.2 * k)); // taşma yarıçapı (çalışma pikseli)
  const fitTol = (0.25 + smooth * 0.5) * Math.max(1, k); // çalışma pikseli
  const layers: VNode[] = [];
  const palOut: TraceResult['palette'] = [];
  let anchors = 0, subpathCount = 0;
  const inv = 1 / k;
  const mask = new Uint8Array(w * h);
  for (let r = 0; r < order.length; r++) {
    const ci = order[r];
    if (dropBg && ci === bgIdx) continue;
    for (let p = 0; p < w * h; p++) {
      const v = lab[p];
      mask[p] = v < 0 ? 0 : method === 'stacked' ? (rank[v] >= r ? 1 : 0) : (v === ci ? 1 : 0);
    }
    if (method === 'overlap') dilateInto(mask, lab, rank, r, w, h, bleed);
    smoothMask(mask, w, h, blurR);
    let sps = await traceMask(mask, w, h, cfg);
    if (process.env.MV_TRACE_DEBUG) console.error('vtracer', ci, sps.map((sp) => sp.points.length));
    // Düzeltme + çapa azaltma (uydurma), sonra orijinal ölçeğe
    sps = sps.map((sp) => {
      const st = straighten(sp, 0.35 * Math.max(1, k));
      if (st.points.length < 8) return st;
      const [poly] = flattenSubPaths([st], 0.15);
      const fitted = fitClosedPolygon(poly, fitTol, 40 + smooth * 20, false, Math.max(3 * Math.max(1, k), 2 * blurR + 2));
      if (process.env.MV_TRACE_DEBUG) console.error('  vt', sp.points.length, 'str', st.points.length, 'fit', fitted.points.length);
      return fitted.points.length >= 3 && fitted.points.length < st.points.length ? straighten(fitted, 0.35 * Math.max(1, k)) : st;
    }).map((sp) => {
      const b = subpathsBBox([sp]);
      const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
      const out = sharpenCorners(sp, Math.max(4 * Math.max(1, k), Math.min(30 * Math.max(1, k), 0.035 * diag)));
      if (process.env.MV_TRACE_DEBUG) console.error('  sharpen', sp.points.length, '→', out.points.length, 'lines', sp.points.filter((p, i, a) => !p.out && !a[(i + 1) % a.length].in).length);
      return out;
    }).map((sp) => transformSubPath(sp, { a: inv, b: 0, c: 0, d: inv, e: 0, f: 0 }));
    if (!sps.length) continue;
    const color = hex(pal.rgb[ci]);
    const nA = sps.reduce((s, sp) => s + sp.points.length, 0);
    anchors += nA; subpathCount += sps.length;
    const node: PathNode = {
      type: 'path', id: newId('path'), name: `Renk ${r + 1} ${color}`, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      style: defaultStyle({ fill: color }), visible: true, locked: false, subpaths: sps.map((sp) => ({ ...sp, points: sp.points.map(round3) })), fillRule: 'evenodd',
    };
    layers.push(node);
    palOut.push({ color, coverage: Math.round((10000 * area[ci]) / (w * h)) / 100, paths: sps.length, anchors: nA });
  }
  if (!layers.length) warnings.push('İzlenecek içerik bulunamadı (görsel tek renk veya tamamen saydam olabilir)');
  const group: GroupNode = {
    type: 'group', id: newId('group'), name: `Vektör izleme (${preset}, ${layers.length} renk)`, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
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
function dilateInto(mask: Uint8Array, lab: Int16Array, rank: Int16Array, r: number, w: number, h: number, radius: number) {
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
        if (v >= 0 && rank[v] > r) { mask[q] = 1; next.push(q); }
      }
    }
    frontier = next;
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
function round3(p: SubPath['points'][number]) {
  const q: SubPath['points'][number] = { x: r3(p.x), y: r3(p.y) };
  if (p.in) q.in = { dx: r3(p.in.dx), dy: r3(p.in.dy) };
  if (p.out) q.out = { dx: r3(p.out.dx), dy: r3(p.out.dy) };
  return q;
}
