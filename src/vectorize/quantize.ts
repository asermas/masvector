// Renk nicemleme: OKLab uzayında k-means++; palet YALNIZ düz bölgelerden öğrenilir (kenar yumuşatma
// karışım renkleri sahte küme üretmesin). Ardından etiket haritası temizliği (çoğunluk filtresi + küçük bileşen birleştirme).

export type Lab = [number, number, number];

const srgbToLin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const linToSrgb = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
const LIN = new Float32Array(256).map((_, i) => srgbToLin(i));

export function rgbToOklab(r: number, g: number, b: number): Lab {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function oklabToRgb([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
const d2 = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

export interface Raster { w: number; h: number; rgba: Uint8ClampedArray }

/** Her pikselin OKLab değeri + düzlük ağırlığı (3×3 komşulukta renk sapması küçükse düz). */
function analyze(img: Raster, alphaCut: number) {
  const { w, h, rgba } = img;
  const lab = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    const [L, A, B] = rgbToOklab(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
    lab[p * 3] = L; lab[p * 3 + 1] = A; lab[p * 3 + 2] = B;
  }
  const flat = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    if (rgba[p * 4 + 3] < alphaCut) continue;
    let mx = 0;
    for (const q of [p - 1, p + 1, p - w, p + w, p - w - 1, p - w + 1, p + w - 1, p + w + 1]) {
      const dd = (lab[p * 3] - lab[q * 3]) ** 2 + (lab[p * 3 + 1] - lab[q * 3 + 1]) ** 2 + (lab[p * 3 + 2] - lab[q * 3 + 2]) ** 2;
      if (dd > mx) mx = dd;
    }
    flat[p] = mx < 0.0009 ? 2 : mx < 0.004 ? 1 : 0; // ΔE_ok < 0.03 çok düz, < 0.063 yarı düz
  }
  return { lab, flat };
}

function seededRandom(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Ağırlıklı k-means++ (örneklenmiş noktalar üzerinde). */
function kmeans(pts: Lab[], wts: number[], k: number, iters = 24): { centers: Lab[]; error: number; counts: number[] } {
  const rnd = seededRandom(1234 + k);
  const centers: Lab[] = [pts[Math.floor(rnd() * pts.length)]];
  const dist = pts.map((p) => d2(p, centers[0]));
  while (centers.length < k) {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) sum += dist[i] * wts[i];
    if (sum <= 0) break;
    let r = rnd() * sum, idx = 0;
    for (; idx < pts.length - 1; idx++) { r -= dist[idx] * wts[idx]; if (r <= 0) break; }
    centers.push([...pts[idx]] as Lab);
    for (let i = 0; i < pts.length; i++) dist[i] = Math.min(dist[i], d2(pts[i], centers[centers.length - 1]));
  }
  const assign = new Int32Array(pts.length);
  let error = 0;
  for (let it = 0; it < iters; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    error = 0;
    let moved = 0;
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) { const dd = d2(pts[i], centers[c]); if (dd < bd) { bd = dd; best = c; } }
      if (assign[i] !== best) moved++;
      assign[i] = best; error += bd * wts[i];
      const a = acc[best]; a[0] += pts[i][0] * wts[i]; a[1] += pts[i][1] * wts[i]; a[2] += pts[i][2] * wts[i]; a[3] += wts[i];
    }
    for (let c = 0; c < centers.length; c++) if (acc[c][3] > 0) centers[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
    if (it > 2 && moved === 0) break;
  }
  const counts = centers.map(() => 0);
  for (let i = 0; i < pts.length; i++) counts[assign[i]] += wts[i];
  const wsum = wts.reduce((a, b) => a + b, 0) || 1;
  return { centers, error: Math.sqrt(error / wsum), counts };
}

export interface Palette { colors: Lab[]; rgb: [number, number, number][]; k: number; error: number; tried: { k: number; error: number }[] }

/**
 * Palet çıkar. `k` verilirse tam o sayıda; yoksa 2..maxK arasında dirsek (elbow) + hedef hata ile seç.
 * `fixed` renkler (ör. kullanıcının verdiği kurumsal palet) doğrudan kullanılır.
 */
export function extractPalette(img: Raster, o: { k?: number; maxK?: number; targetError?: number; fixed?: [number, number, number][]; alphaCut?: number } = {}): Palette {
  const alphaCut = o.alphaCut ?? 128;
  if (o.fixed?.length) {
    const colors = o.fixed.map(([r, g, b]) => rgbToOklab(r, g, b));
    return { colors, rgb: o.fixed, k: colors.length, error: 0, tried: [] };
  }
  const { lab, flat } = analyze(img, alphaCut);
  const n = img.w * img.h;
  // Örnekleme: düz pikseller ağırlıklı; hiç düz piksel yoksa (foto) hepsi
  const pts: Lab[] = [], wts: number[] = [];
  const hasFlat = flat.some((f) => f === 2);
  const step = Math.max(1, Math.floor(n / 120_000));
  for (let p = 0; p < n; p += step) {
    if (img.rgba[p * 4 + 3] < alphaCut) continue;
    const wgt = hasFlat ? (flat[p] === 2 ? 1 : flat[p] === 1 ? 0.15 : 0) : 1;
    if (wgt === 0) continue;
    pts.push([lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]]); wts.push(wgt);
  }
  if (!pts.length) return { colors: [[1, 0, 0]], rgb: [[255, 255, 255]], k: 1, error: 0, tried: [] };
  const tried: { k: number; error: number }[] = [];
  let best: ReturnType<typeof kmeans>;
  if (o.k) best = kmeans(pts, wts, o.k);
  else {
    const maxK = o.maxK ?? 16, target = o.targetError ?? 0.018;
    let prev = kmeans(pts, wts, 1);
    tried.push({ k: 1, error: prev.error });
    best = prev;
    for (let k = 2; k <= maxK; k++) {
      const cur = kmeans(pts, wts, k);
      tried.push({ k, error: cur.error });
      const gain = (prev.error - cur.error) / Math.max(prev.error, 1e-9);
      best = cur;
      if (cur.error < target) break;               // hedef doğruluk
      if (k >= 4 && gain < 0.08) { best = prev; break; } // dirsek: yeni renk anlamlı katkı vermiyor
      prev = cur;
    }
  }
  // Çok küçük (<%0.02) kümeleri at, çok yakın (ΔE<0.02) renkleri birleştir
  const total = best.counts.reduce((a, b) => a + b, 0);
  let centers = best.centers.filter((_, i) => best.counts[i] / total > 0.0002);
  const merged: Lab[] = [];
  for (const c of centers) if (!merged.some((m) => d2(m, c) < 0.0004)) merged.push(c);
  centers = merged;
  return { colors: centers, rgb: centers.map(oklabToRgb), k: centers.length, error: best.error, tried };
}

/**
 * Pikselleri palet rengine ata. -1 = saydam.
 * Kenar-farkında: düz pikseller en yakın renge atanır; kenar (yumuşatma karışımı) pikselleri YALNIZ
 * komşu düz bölgelerin renkleri arasından seçilir. Böylece lacivert+beyaz karışımı "kırmızıya daha yakın"
 * olsa bile kırmızı şerit oluşmaz.
 */
export function labelize(img: Raster, pal: Palette, alphaCut = 128): Int16Array {
  const { w, h, rgba } = img;
  const n = w * h;
  const out = new Int16Array(n).fill(-2); // -2 = henüz atanmadı
  const { lab, flat } = analyze(img, alphaCut);
  const K = pal.colors.length;
  const nearest = (p: number, allowed?: Set<number>) => {
    let bd = Infinity, li = 0;
    for (let i = 0; i < K; i++) {
      if (allowed && !allowed.has(i)) continue;
      const c = pal.colors[i];
      const dd = (lab[p * 3] - c[0]) ** 2 + (lab[p * 3 + 1] - c[1]) ** 2 + (lab[p * 3 + 2] - c[2]) ** 2;
      if (dd < bd) { bd = dd; li = i; }
    }
    return li;
  };
  let pending: number[] = [];
  for (let p = 0; p < n; p++) {
    if (rgba[p * 4 + 3] < alphaCut) out[p] = -1;
    else if (flat[p]) out[p] = nearest(p);
    else pending.push(p);
  }
  // Düz bölgelerden içeri doğru yay (her tur bir piksel)
  for (let pass = 0; pass < 6 && pending.length; pass++) {
    const assign: [number, number][] = [];
    const still: number[] = [];
    for (const p of pending) {
      const x = p % w, y = (p / w) | 0;
      const cand = new Set<number>();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const v = out[yy * w + xx];
        if (v >= 0) cand.add(v);
      }
      if (cand.size) assign.push([p, nearest(p, cand)]); else still.push(p);
    }
    for (const [p, v] of assign) out[p] = v;
    pending = still;
  }
  for (const p of pending) out[p] = nearest(p); // düz komşusu olmayanlar (foto/gradyan)
  return out;
}

/** 3×3 çoğunluk filtresi: tek piksellik tırtıkları ve kenar gürültüsünü temizler (ince çizgileri korur: yalnız ≥5 komşu anlaşırsa). */
export function modeFilter(lab: Int16Array, w: number, h: number, passes = 1): Int16Array {
  let src = lab;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Int16Array(src);
    const cnt = new Map<number, number>();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      cnt.clear();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = src[p + dy * w + dx]; cnt.set(v, (cnt.get(v) ?? 0) + 1); }
      let bv = src[p], bc = 0;
      for (const [v, c] of cnt) if (c > bc) { bc = c; bv = v; }
      if (bv !== src[p] && bc >= 6 && (cnt.get(src[p]) ?? 0) <= 2) out[p] = bv;
    }
    src = out;
  }
  return src;
}

/** `minArea`dan küçük bağlı bileşenleri (4-komşuluk) en çok sınır paylaştıkları etikete kat (lekeleri sil). */
export function removeSpeckles(lab: Int16Array, w: number, h: number, minArea: number): number {
  if (minArea <= 1) return 0;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp = new Int32Array(Math.max(1, minArea));
  let removed = 0;
  for (let s = 0; s < w * h; s++) {
    if (seen[s]) continue;
    const v = lab[s];
    let sp = 0, size = 0;
    stack[sp++] = s; seen[s] = 1;
    const border = new Map<number, number>();
    while (sp) {
      const p = stack[--sp];
      if (size < minArea) comp[size] = p;
      size++;
      const x = p % w;
      if (x > 0) visit(p - 1); if (x < w - 1) visit(p + 1); if (p >= w) visit(p - w); if (p < w * (h - 1)) visit(p + w);
    }
    if (size < minArea && border.size) {
      let bv = v, bc = -1;
      for (const [k, c] of border) if (c > bc) { bc = c; bv = k; }
      for (let i = 0; i < size; i++) lab[comp[i]] = bv;
      removed++;
    }
    function visit(q: number) {
      if (lab[q] === v) { if (!seen[q]) { seen[q] = 1; stack[sp++] = q; } }
      else if (size < minArea) border.set(lab[q], (border.get(lab[q]) ?? 0) + 1);
    }
  }
  return removed;
}
