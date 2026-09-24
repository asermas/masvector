import { createCanvas } from '@napi-rs/canvas';
import type { VDocument } from '../common/types.js';
import { renderRGBA } from '../render/png.js';
import { rgbToOklab } from './quantize.js';

// Vektör sonucunu kaynak raster ile piksel piksel karşılaştırır — "hatasız" iddiasının ölçüsü.

export interface CompareMetrics {
  width: number; height: number;
  /** Ortalama mutlak kanal farkı (0–255). */
  meanAbsError: number;
  /** Ortalama algısal renk farkı (OKLab ΔE; 0.02 altı gözle ayırt edilmez). */
  meanDeltaE: number;
  /** JND üstü (ΔE>0.02) ince fark oranı (%), konum toleranssız — gradyan/ton yaklaşıklığı göstergesi. */
  pctSubtle: number;
  /** PSNR (dB) — 35+ çok iyi, 40+ görsel olarak ayırt edilemez. */
  psnr: number;
  /** Belirgin farklı piksel oranı (%), hiçbir kaydırma toleransı olmadan. */
  pctOffStrict: number;
  /** 1 px konum toleranslı (kenar yumuşatma kaymalarını affeden) farklı piksel oranı (%). Ana kalite ölçüsü. */
  pctOff: number;
  /** Farkın yoğunlaştığı en kötü 32×32 blok (x, y, yüzde). */
  worstBlock: { x: number; y: number; pct: number } | null;
  verdict: 'mükemmel' | 'çok iyi' | 'iyi' | 'zayıf';
  /** Neye karşı ölçüldü (gürültülü kaynaklarda medyanla temizlenmiş kaynak). */
  reference?: string;
}

/** OKLab renk farkı eşiği: ~0.02 zar zor fark edilir (JND), 0.06 açıkça fark edilir. Düşük kontrastlı yapılar kaçmasın diye JND'ye yakın. */
const DE_THRESH = 0.04;
/** İnce fark eşiği (JND civarı) — ayrıca raporlanır. */
const DE_SUBTLE = 0.02;

/** RGBA'yı beyaz zemine birleştir (alfa farklılıkları renk farkına dönüşsün). */
function flatten(px: Uint8ClampedArray): Uint8ClampedArray {
  const o = new Uint8ClampedArray((px.length / 4) * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    const a = px[i + 3] / 255;
    o[j] = px[i] * a + 255 * (1 - a); o[j + 1] = px[i + 1] * a + 255 * (1 - a); o[j + 2] = px[i + 2] * a + 255 * (1 - a);
  }
  return o;
}

export function compareRGBA(ref: Uint8ClampedArray, out: Uint8ClampedArray, w: number, h: number): { metrics: CompareMetrics; diffMask: Uint8Array } {
  const A = flatten(ref), B = flatten(out);
  const n = w * h;
  let sumAbs = 0, sumSq = 0, strict = 0, tol = 0, sumDE = 0, subtle = 0;
  const diffMask = new Uint8Array(n);
  const toLab = (X: Uint8ClampedArray) => {
    const o = new Float32Array(n * 3);
    for (let p = 0; p < n; p++) { const c = rgbToOklab(X[p * 3], X[p * 3 + 1], X[p * 3 + 2]); o[p * 3] = c[0]; o[p * 3 + 1] = c[1]; o[p * 3 + 2] = c[2]; }
    return o;
  };
  const LA = toLab(A), LB = toLab(B);
  const d = (i: number, j: number) => Math.sqrt((LA[i] - LB[j]) ** 2 + (LA[i + 1] - LB[j + 1]) ** 2 + (LA[i + 2] - LB[j + 2]) ** 2);
  const THRESH = DE_THRESH;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, i = p * 3;
    for (let k = 0; k < 3; k++) { const e = A[i + k] - B[i + k]; sumAbs += Math.abs(e); sumSq += e * e; }
    const de = d(i, i);
    sumDE += de;
    if (de > DE_SUBTLE) subtle++;
    if (de <= THRESH) continue;
    strict++;
    // 1 px + kenar yumuşatma toleransı: kaynak piksel, çıktının 3×3 komşuluğundaki bir pikselle YA DA iki komşunun
    // karışımıyla (kısmi örtme) açıklanabiliyorsa hata değildir; aynısı ters yönde.
    const nb: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) nb.push((yy * w + xx) * 3);
    }
    const explain = (P: Float32Array, Q: Float32Array) => {
      let bestD = Infinity;
      for (let a = 0; a < nb.length && bestD > THRESH; a++) {
        const qa = nb[a];
        const da = Math.sqrt((P[i] - Q[qa]) ** 2 + (P[i + 1] - Q[qa + 1]) ** 2 + (P[i + 2] - Q[qa + 2]) ** 2);
        if (da < bestD) bestD = da;
        for (let b = a + 1; b < nb.length && bestD > THRESH; b++) {
          const qb = nb[b];
          // P[i]'nin [Q[qa], Q[qb]] doğru parçasına uzaklığı
          const vx = Q[qb] - Q[qa], vy = Q[qb + 1] - Q[qa + 1], vz = Q[qb + 2] - Q[qa + 2];
          const vv = vx * vx + vy * vy + vz * vz;
          if (vv < 1e-9) continue;
          const t = Math.max(0, Math.min(1, ((P[i] - Q[qa]) * vx + (P[i + 1] - Q[qa + 1]) * vy + (P[i + 2] - Q[qa + 2]) * vz) / vv));
          const dd = Math.sqrt((P[i] - Q[qa] - t * vx) ** 2 + (P[i + 1] - Q[qa + 1] - t * vy) ** 2 + (P[i + 2] - Q[qa + 2] - t * vz) ** 2);
          if (dd < bestD) bestD = dd;
        }
      }
      return bestD;
    };
    const best = explain(LA, LB), best2 = explain(LB, LA);
    if (best > THRESH || best2 > THRESH) { tol++; diffMask[p] = 1; }
  }
  const mse = sumSq / (n * 3);
  // En kötü blok
  let worst: CompareMetrics['worstBlock'] = null;
  const BS = 32;
  for (let by = 0; by < h; by += BS) for (let bx = 0; bx < w; bx += BS) {
    let c = 0, t = 0;
    for (let y = by; y < Math.min(h, by + BS); y++) for (let x = bx; x < Math.min(w, bx + BS); x++) { t++; c += diffMask[y * w + x]; }
    const pct = (100 * c) / t;
    if (pct > 0 && (!worst || pct > worst.pct)) worst = { x: bx, y: by, pct: Math.round(pct * 100) / 100 };
  }
  const pctOff = (100 * tol) / n;
  return {
    metrics: {
      width: w, height: h,
      meanAbsError: Math.round((sumAbs / (n * 3)) * 100) / 100,
      meanDeltaE: Math.round((sumDE / n) * 10000) / 10000,
      pctSubtle: Math.round(((100 * subtle) / n) * 1000) / 1000,
      psnr: mse === 0 ? 99 : Math.round(10 * Math.log10((255 * 255) / mse) * 100) / 100,
      pctOffStrict: Math.round(((100 * strict) / n) * 1000) / 1000,
      pctOff: Math.round(pctOff * 1000) / 1000,
      worstBlock: worst,
      verdict: pctOff < 0.25 ? 'mükemmel' : pctOff < 1 ? 'çok iyi' : pctOff < 3 ? 'iyi' : 'zayıf',
    },
    diffMask,
  };
}

/** 3×3 medyan (kanal başına): JPEG blok/halka gürültüsünü siler, kenarları korur. Gürültülü kaynakta "amaçlanan görüntü" tahmini. */
export function median3(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const v = new Uint8Array(9);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    for (let c = 0; c < 4; c++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v[k++] = rgba[((y + dy) * w + x + dx) * 4 + c];
      v.sort();
      out[(y * w + x) * 4 + c] = v[4];
    }
  }
  return out;
}

/** Fark haritası: kaynak soluk gri, hatalı pikseller kırmızı. */
export function diffHeatmapPNG(ref: Uint8ClampedArray, mask: Uint8Array, w: number, h: number): Buffer {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  const id = x.createImageData(w, h);
  const A = flatten(ref);
  for (let p = 0; p < w * h; p++) {
    const g = 150 + (0.299 * A[p * 3] + 0.587 * A[p * 3 + 1] + 0.114 * A[p * 3 + 2]) * 0.4;
    const o = p * 4;
    if (mask[p]) { id.data[o] = 235; id.data[o + 1] = 20; id.data[o + 2] = 60; }
    else { id.data[o] = g; id.data[o + 1] = g; id.data[o + 2] = g; }
    id.data[o + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  return c.toBuffer('image/png');
}

/** Belgeyi referans boyutunda render edip karşılaştır. `hide` id'leri (ör. referans katmanı) render dışı tutulur. */
export function compareDocument(doc: VDocument, ref: { rgba: Uint8ClampedArray; width: number; height: number }, opts: { frameId?: string; hide?: string[]; region?: { x: number; y: number; width: number; height: number } } = {}) {
  const clone: VDocument = opts.hide?.length ? structuredClone(doc) : doc;
  if (opts.hide?.length) {
    const hide = new Set(opts.hide);
    const visit = (nodes: any[]) => nodes.forEach((n) => { if (hide.has(n.id)) n.visible = false; if (n.children) visit(n.children); });
    for (const p of clone.pages) for (const f of p.frames) visit(f.nodes);
  }
  const r = renderRGBA(clone, { frameId: opts.frameId, width: ref.width, height: ref.height, background: true, region: opts.region });
  const { metrics, diffMask } = compareRGBA(ref.rgba, r.rgba, ref.width, ref.height);
  return { metrics, heatmap: () => diffHeatmapPNG(ref.rgba, diffMask, ref.width, ref.height), rendered: r.rgba };
}
