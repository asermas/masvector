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

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
// OKLab L siyaha yakın algısal olarak tekdüze değil (#010101 ile #000000 arası ΔL≈0.067 > eşik, ama gözle ayırt edilemez).
// Ottosson'un "toe" düzeltmesi (Lr; CIELAB L* gibi koyu tonlarda doğrusal) ile ölçülür.
const K1 = 0.206, K2 = 0.03, K3 = (1 + K1) / (1 + K2);
function labT(r: number, g: number, b: number): [number, number, number] {
  const c = rgbToOklab(r, g, b), L = c[0], u = K3 * L - K1;
  // K3'e bölünür: açık tonlarda eğim 1 kalır (ölçüt yalnız koyu tonlarda gevşer, açıklarda sıkılaşmaz)
  return [(u + Math.sqrt(u * u + 4 * K2 * K3 * L)) / 2 / K3, c[1], c[2]];
}

export function compareRGBA(ref: Uint8ClampedArray, out: Uint8ClampedArray, w: number, h: number): { metrics: CompareMetrics; diffMask: Uint8Array } {
  const A = flatten(ref), B = flatten(out);
  const n = w * h;
  let sumAbs = 0, sumSq = 0, strict = 0, tol = 0, sumDE = 0, subtle = 0;
  const diffMask = new Uint8Array(n);
  const toLab = (X: Uint8ClampedArray) => {
    const o = new Float32Array(n * 3);
    for (let p = 0; p < n; p++) { const c = labT(X[p * 3], X[p * 3 + 1], X[p * 3 + 2]); o[p * 3] = c[0]; o[p * 3 + 1] = c[1]; o[p * 3 + 2] = c[2]; }
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
    // Karışım sRGB'de olur (kenar yumuşatma, yeniden örnekleme): P, iki komşunun sRGB karışım doğrusundaki en yakın
    // noktaya OKLab'da ölçülür. Yeniden örnekleme filtreleri (Lanczos vb.) keskin kenarda uçların ±%15 ötesine
    // taşar (çınlama); vektör render'ı bunu üretemez, hata sayılmaz.
    const explain = (PL: Float32Array, PS: Uint8ClampedArray, QL: Float32Array, QS: Uint8ClampedArray) => {
      let bestD = Infinity;
      for (let a = 0; a < nb.length && bestD > THRESH; a++) {
        const qa = nb[a];
        const da = Math.sqrt((PL[i] - QL[qa]) ** 2 + (PL[i + 1] - QL[qa + 1]) ** 2 + (PL[i + 2] - QL[qa + 2]) ** 2);
        if (da < bestD) bestD = da;
        for (let b = a + 1; b < nb.length && bestD > THRESH; b++) {
          const qb = nb[b];
          const vx = QS[qb] - QS[qa], vy = QS[qb + 1] - QS[qa + 1], vz = QS[qb + 2] - QS[qa + 2];
          const vv = vx * vx + vy * vy + vz * vz;
          if (vv < 1) continue;
          const t = Math.max(-0.15, Math.min(1.15, ((PS[i] - QS[qa]) * vx + (PS[i + 1] - QS[qa + 1]) * vy + (PS[i + 2] - QS[qa + 2]) * vz) / vv));
          const c = labT(clamp8(QS[qa] + t * vx), clamp8(QS[qa + 1] + t * vy), clamp8(QS[qa + 2] + t * vz));
          const dd = Math.sqrt((PL[i] - c[0]) ** 2 + (PL[i + 1] - c[1]) ** 2 + (PL[i + 2] - c[2]) ** 2);
          if (dd < bestD) bestD = dd;
        }
      }
      return bestD;
    };
    const best = explain(LA, A, LB, B), best2 = explain(LB, B, LA, A);
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

/**
 * Gürültülü kaynak için ölçüt referansı: 3×3 medyan + (gürültü yüksekse) kenar koruyan sigma süzgeci. Süzgeç yalnız
 * rengi merkezden `3.5 × gürültü`den az farklı komşuların ortalamasını alır: gerçek renk sınırları korunur, tanecik silinir.
 * `noise`: ortalama mutlak sapma (0–255, estimateNoise).
 */
export function cleanReference(rgba: Uint8ClampedArray, w: number, h: number, noise: number, lossy = false): Uint8ClampedArray {
  // Kayıplı kaynakta (JPEG) blok/çınlama gürültüsü düz bölgede ölçülemez: taban 4
  const nz = Math.max(noise, lossy ? 4 : 0);
  if (nz < 2) return rgba;
  // Medyan 1 px çizgileri siler: yalnız yüksek (tuz-biber benzeri) gürültüde. Sigma süzgeci ince yapıları korur
  // (çizgi pikseli komşularından T'den çok farklıdır, ortalamaya katılmaz).
  let a = nz > 8 ? median3(rgba, w, h) : rgba;
  const T = 3.5 * nz, R = nz > 8 ? 3 : 2;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Uint8ClampedArray(a);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      let r = 0, g = 0, b = 0, al = 0, n = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = (yy * w + xx) * 4;
          if (Math.abs(a[q] - a[p]) > T || Math.abs(a[q + 1] - a[p + 1]) > T || Math.abs(a[q + 2] - a[p + 2]) > T || Math.abs(a[q + 3] - a[p + 3]) > T) continue;
          r += a[q]; g += a[q + 1]; b += a[q + 2]; al += a[q + 3]; n++;
        }
      }
      out[p] = r / n; out[p + 1] = g / n; out[p + 2] = b / n; out[p + 3] = al / n;
    }
    a = out;
  }
  return a;
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
/**
 * JPEG renk alt örneklemesi (4:2:0) renk bilgisini kenarın ~1 px dışına taşırır; vektör bunu üretmemeli. Kayıplı
 * kaynakta KARŞILAŞTIRMANIN iki tarafına da aynı renk (Cb/Cr) yumuşatması uygulanır: parlaklık (Y) kenarları piksel
 * hassasiyetinde ölçülmeye devam eder, yalnız JPEG'in zaten attığı renk çözünürlüğü eşitlenir.
 */
export function chromaSmooth(px: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const n = w * h, Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const r = px[p * 4], g = px[p * 4 + 1], b = px[p * 4 + 2];
    Y[p] = 0.299 * r + 0.587 * g + 0.114 * b; Cb[p] = -0.168736 * r - 0.331264 * g + 0.5 * b; Cr[p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  const blur = (a: Float32Array) => { // 3×3 çadır (≈ 2× alt örnekleme + çift doğrusal büyütme)
    const t = new Float32Array(n), o = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * w + x; t[p] = (a[p] * 2 + a[y * w + Math.max(0, x - 1)] + a[y * w + Math.min(w - 1, x + 1)]) / 4; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * w + x; o[p] = (t[p] * 2 + t[Math.max(0, y - 1) * w + x] + t[Math.min(h - 1, y + 1) * w + x]) / 4; }
    return o;
  };
  const cb = blur(Cb), cr = blur(Cr), out = new Uint8ClampedArray(px);
  for (let p = 0; p < n; p++) {
    out[p * 4] = Y[p] + 1.402 * cr[p]; out[p * 4 + 1] = Y[p] - 0.344136 * cb[p] - 0.714136 * cr[p]; out[p * 4 + 2] = Y[p] + 1.772 * cb[p];
  }
  return out;
}

export function compareDocument(doc: VDocument, ref: { rgba: Uint8ClampedArray; width: number; height: number }, opts: { frameId?: string; hide?: string[]; region?: { x: number; y: number; width: number; height: number }; chroma?: boolean } = {}) {
  const clone: VDocument = opts.hide?.length ? structuredClone(doc) : doc;
  if (opts.hide?.length) {
    const hide = new Set(opts.hide);
    const visit = (nodes: any[]) => nodes.forEach((n) => { if (hide.has(n.id)) n.visible = false; if (n.children) visit(n.children); });
    for (const p of clone.pages) for (const f of p.frames) visit(f.nodes);
  }
  const r = renderRGBA(clone, { frameId: opts.frameId, width: ref.width, height: ref.height, background: true, region: opts.region });
  const A = opts.chroma ? chromaSmooth(ref.rgba, ref.width, ref.height) : ref.rgba;
  const B = opts.chroma ? chromaSmooth(r.rgba, ref.width, ref.height) : r.rgba;
  const { metrics, diffMask } = compareRGBA(A, B, ref.width, ref.height);
  return { metrics, heatmap: () => diffHeatmapPNG(ref.rgba, diffMask, ref.width, ref.height), rendered: r.rgba };
}
