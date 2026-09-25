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
const analyzeCache = new WeakMap<Uint8ClampedArray, { alphaCut: number; r: { lab: Float32Array; flat: Uint8Array } }>();
function analyze(img: Raster, alphaCut: number) {
  const c = analyzeCache.get(img.rgba);
  if (c && c.alphaCut === alphaCut) return c.r;
  const r = analyzeRaw(img, alphaCut);
  analyzeCache.set(img.rgba, { alphaCut, r });
  return r;
}
function analyzeRaw(img: Raster, alphaCut: number) {
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

export interface Palette { colors: Lab[]; rgb: [number, number, number][]; k: number; error: number; tried: { k: number; error: number }[]; /** İnce yapı (çizgi/küçük metin) rengi: düz pikseli yok. */ thin?: boolean[] }

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
  const base = centers.length;
  if (hasFlat && !o.k) centers.push(...thinColors(img, lab, flat, centers, alphaCut, (o.maxK ?? 16) - centers.length));
  return { colors: centers, rgb: centers.map(oklabToRgb), k: centers.length, error: best.error, tried, thin: centers.map((_, i) => i >= base) };
}

/** OKLab'da p'nin [a,b] doğru parçasına uzaklığının karesi (iki rengin kenar yumuşatma karışımı mı?). */
function segD2(p: Lab, a: Lab, b: Lab): number {
  const v0 = b[0] - a[0], v1 = b[1] - a[1], v2 = b[2] - a[2];
  const L = v0 * v0 + v1 * v1 + v2 * v2;
  const t = L > 1e-12 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * v0 + (p[1] - a[1]) * v1 + (p[2] - a[2]) * v2) / L)) : 0;
  return (p[0] - a[0] - t * v0) ** 2 + (p[1] - a[1] - t * v1) ** 2 + (p[2] - a[2] - t * v2) ** 2;
}

/** Piksel, paletteki en yakın 4 rengin tekiyle ya da ikisinin karışımıyla açıklanabiliyor mu? Açıklanamayan uzaklığın karesi. */
function unexplained(p: Lab, colors: Lab[]): number {
  const near = colors.map((c, i) => [d2(p, c), i] as const).sort((a, b) => a[0] - b[0]).slice(0, 4);
  let best = near[0]?.[0] ?? Infinity;
  for (let a = 0; a < near.length; a++) for (let b = a + 1; b < near.length; b++) best = Math.min(best, segD2(p, colors[near[a][1]], colors[near[b][1]]));
  return best;
}

/**
 * İnce çizginin en yoğun pikselleri bile tam kaplanmaz (köşegen/eğri 1 px çizgide ~%75–85): gözlenen uç renk,
 * zeminden (en yakın palet rengi) gerçek renge giden yolun ~%85'i sayılır ve sRGB'de o orana göre uzatılır (gamut içinde).
 */
function extrapolate(c: Lab, centers: Lab[]): Lab {
  let bg = centers[0], bd = Infinity;
  for (const q of centers) { const dd = d2(c, q); if (dd < bd) { bd = dd; bg = q; } }
  const B = oklabToRgb(bg), C = oklabToRgb(c);
  let f = 1 / 0.85;
  for (let i = 0; i < 3; i++) { const dlt = C[i] - B[i]; if (dlt < 0) f = Math.min(f, B[i] / -dlt); else if (dlt > 0) f = Math.min(f, (255 - B[i]) / dlt); }
  const E = [0, 1, 2].map((i) => Math.round(B[i] + (C[i] - B[i]) * Math.max(1, f))) as [number, number, number];
  return rgbToOklab(E[0], E[1], E[2]);
}

/**
 * İnce yapı renkleri: 1–2 px çizgiler, küçük metin, noktalar hiç "düz" piksel içermez; palet yalnız düz bölgelerden
 * öğrenildiğinde bu renkler kaybolur (çizgiler silinir). Palet renklerinin tekiyle ya da karışımıyla açıklanamayan
 * pikseller kümelenir ve her küme, kenar yumuşatmasıyla açılmış tonun ötesine — en doygun/uç üyelerine — itilir.
 */
function thinColors(img: Raster, lab: Float32Array, flat: Uint8Array, centers: Lab[], alphaCut: number, room: number): Lab[] {
  if (room <= 0 || !centers.length) return [];
  const n = img.w * img.h, step = Math.max(1, Math.floor(n / 150_000));
  const pts: Lab[] = [], far: number[] = [];
  const W = img.w, H = img.h;
  const nearestC = (q: number) => { let bd = Infinity, bi = 0; for (let i = 0; i < centers.length; i++) { const c = centers[i]; const dd = (lab[q * 3] - c[0]) ** 2 + (lab[q * 3 + 1] - c[1]) ** 2 + (lab[q * 3 + 2] - c[2]) ** 2; if (dd < bd) { bd = dd; bi = i; } } return bi; };
  // Çizgi mi, kenar artığı mı: bir eksen boyunca iki yandaki ilk düz pikseller AYNI renkteyse çizgi (zemin üstünde
  // ince yapı); farklıysa iki bölgenin sınırındaki JPEG çınlaması / yumuşatma kalıntısıdır → palet rengi değildir.
  const lineLike = (p: number) => {
    const x = p % W, y = (p / W) | 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let a = -1, b = -1;
      for (let d = 1; d <= 10 && a < 0; d++) { const xx = x + dx * d, yy = y + dy * d; if (xx < 0 || yy < 0 || xx >= W || yy >= H) break; const q = yy * W + xx; if (flat[q] === 2) a = nearestC(q); }
      for (let d = 1; d <= 10 && b < 0; d++) { const xx = x - dx * d, yy = y - dy * d; if (xx < 0 || yy < 0 || xx >= W || yy >= H) break; const q = yy * W + xx; if (flat[q] === 2) b = nearestC(q); }
      if (a >= 0 && a === b) return true;
    }
    return false;
  };
  let opaque = 0;
  for (let p = 0; p < n; p += step) {
    if (img.rgba[p * 4 + 3] < alphaCut) continue;
    opaque++;
    if (flat[p] === 2) continue;
    const c: Lab = [lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]];
    const u = unexplained(c, centers);
    if (u > 0.05 ** 2 && lineLike(p)) { pts.push(c); far.push(u); }
  }
  // Gürültü değil yapı: açıklanamayan pikseller opak alanın en az ‰1'i
  if (pts.length < Math.max(12, opaque * 0.001)) return [];
  const wts = pts.map(() => 1);
  let prevErr = Infinity;
  let km = kmeans(pts, wts, 1);
  for (let k = 2; k <= Math.min(room, 8); k++) {
    const cur = kmeans(pts, wts, k);
    if (cur.error > km.error * 0.8 || cur.error < 0.02) { if (cur.error < km.error * 0.8) km = cur; break; }
    prevErr = km.error; km = cur;
  }
  void prevErr;
  const cands: { col: Lab; u: number }[] = [];
  for (let c = 0; c < km.centers.length; c++) {
    // Kenar yumuşatılmış ince çizgi pikselleri zemin→çizgi rengi doğrusu üzerindedir: gerçek renk bu dağılımın UCU.
    // Küme üyelerinden paletten en uzak %3'ün ortalaması (tek aykırı piksele değil, kalabalık uca bakar).
    const mem: { p: Lab; u: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      let bd = Infinity, bi = 0;
      for (let q = 0; q < km.centers.length; q++) { const dd = d2(pts[i], km.centers[q]); if (dd < bd) { bd = dd; bi = q; } }
      if (bi === c) mem.push({ p: pts[i], u: far[i] });
    }
    if (mem.length < Math.max(6, opaque * 0.0003)) continue;
    mem.sort((a, b) => b.u - a.u);
    const top = mem.slice(0, Math.max(3, Math.ceil(mem.length * 0.03)));
    const col: Lab = [0, 0, 0];
    for (const m of top) { col[0] += m.p[0] / top.length; col[1] += m.p[1] / top.length; col[2] += m.p[2] / top.length; }
    cands.push({ col: extrapolate(col, centers), u: unexplained(col, centers) });
  }
  // En uç renkler önce: ardından gelen ara tonlar (ör. kırmızı çizginin pembe yumuşatması) yeni renkle açıklanıyorsa eklenmez
  const out: Lab[] = [];
  for (const c of cands.sort((a, b) => b.u - a.u)) if (unexplained(c.col, [...centers, ...out]) > 0.05 ** 2) out.push(c.col);
  return out;
}

/**
 * Komşu renklerle açıklanamayan piksel için: zemin (komşu renk a) ile başka bir palet rengi x arasındaki karışım
 * doğrusuna en iyi oturan çifti bul; karışım oranı ≥ 0.42 ise x, değilse a. En-yakın-renk seçimi burada yanılır
 * (beyaz üstündeki ince siyah çizginin grisi, kırmızıya siyahtan daha "yakın" olabilir).
 */
function mixLabel(c: Lab, cand: Set<number>, colors: Lab[], thinIdx: number[]): { a: number; x: number; t: number; d2: number } {
  let best = Infinity, r = { a: [...cand][0], x: -1, t: 0, d2: Infinity };
  for (const a of cand) for (const x of thinIdx) {
    if (cand.has(x)) continue;
    const A = colors[a], X = colors[x];
    const v0 = X[0] - A[0], v1 = X[1] - A[1], v2 = X[2] - A[2];
    const L = v0 * v0 + v1 * v1 + v2 * v2;
    if (L < 1e-12) continue;
    const t = ((c[0] - A[0]) * v0 + (c[1] - A[1]) * v1 + (c[2] - A[2]) * v2) / L;
    const tc = Math.min(1, Math.max(0, t));
    const dd = (c[0] - A[0] - tc * v0) ** 2 + (c[1] - A[1] - tc * v1) ** 2 + (c[2] - A[2] - tc * v2) ** 2;
    if (dd < best) { best = dd; r = { a, x, t, d2: dd }; }
  }
  return r;
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
  // İnce yapı pikselleri (komşu renklerle açıklanamayan): karışım oranı t ile birlikte ertelenir; eşik yerel tepeye
  // göre uyarlanır (köşegen 1 px çizgide t hiç 0.5'e ulaşmaz → sabit eşik çizgiyi kesik kesik yapar)
  const thin = new Map<number, { a: number; x: number; t: number }>();
  const allIdx = pal.colors.map((_, i) => i);
  // Çizgi benzeri piksel: bir eksende iki yandaki ilk düz pikseller aynı renkte (zemin üstünde ince yapı).
  // İki bölgenin sınırındaki karışım pikselleri (farklı renkler) buraya girmez → kenarlarda kırıntı oluşmaz.
  const lineLike = (p: number) => {
    const x = p % w, y = (p / w) | 0;
    let hits = 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let a = -1, b = -1;
      for (let d = 1; d <= 10 && a < 0; d++) { const xx = x + dx * d, yy = y + dy * d; if (xx < 0 || yy < 0 || xx >= w || yy >= h) break; const q = yy * w + xx; if (flat[q] === 2) a = out[q]; }
      for (let d = 1; d <= 10 && b < 0; d++) { const xx = x - dx * d, yy = y - dy * d; if (xx < 0 || yy < 0 || xx >= w || yy >= h) break; const q = yy * w + xx; if (flat[q] === 2) b = out[q]; }
      // Gerçek ince çizgi en az iki eksende (dik + köşegen) aynı zemini görür; kenar saçağı en çok birinde
      if (a >= 0 && a === b && ++hits >= 2) return true;
    }
    return false;
  };
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
      if (!cand.size) { still.push(p); continue; }
      // Komşu renklerin tekiyle/karışımıyla açıklanamayan piksel (ince çizgi, küçük metin): tüm palete açılır
      if (K > 1) {
        const c: Lab = [lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]];
        if (unexplained(c, [...cand].map((i) => pal.colors[i])) > 0.05 ** 2 && lineLike(p)) {
          const m = mixLabel(c, cand, pal.colors, allIdx);
          // Yalnız zemin + tek renk karışımıyla gerçekten açıklanıyorsa (ΔE < 0.04) ince yapı sayılır
          if (m.x >= 0 && m.d2 < 0.04 ** 2) { thin.set(p, m); assign.push([p, m.a]); continue; }
        }
      }
      assign.push([p, nearest(p, cand)]);
    }
    for (const [p, v] of assign) out[p] = v;
    pending = still;
  }
  if (thin.size) {
    const tx = new Float32Array(n).fill(-1);
    for (const [p, m] of thin) if (m.x >= 0) tx[p] = m.t;
    for (const [p, m] of thin) {
      if (m.x < 0) continue;
      const x = p % w, y = (p / w) | 0;
      let peak = m.t;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx, m2 = thin.get(q);
        if (m2 && m2.x === m.x && tx[q] > peak) peak = tx[q];
      }
      if (m.t >= Math.max(0.2, Math.min(0.5, 0.55 * Math.min(1, peak)))) out[p] = m.x;
    }
    // İnce yapı uzun olur: karışım yoluyla atanmış 8-bağlı bileşen 12 pikselden kısaysa (kenar saçağı, tek leke) geri al
    const seen = new Uint8Array(n), stack: number[] = [], comp: number[] = [];
    for (const [p0, m0] of thin) {
      if (seen[p0] || out[p0] !== m0.x) continue;
      stack.length = 0; comp.length = 0; stack.push(p0); seen[p0] = 1;
      while (stack.length) {
        const p = stack.pop()!; comp.push(p);
        const x = p % w, y = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx, mq = thin.get(q);
          if (!seen[q] && mq && out[q] === m0.x) { seen[q] = 1; stack.push(q); }
        }
      }
      if (comp.length < 12) for (const p of comp) out[p] = thin.get(p)!.a;
    }
  }
  for (const p of pending) out[p] = nearest(p); // düz komşusu olmayanlar (foto/gradyan)
  return out;
}

/** 3×3 çoğunluk filtresi: tek piksellik tırtıkları ve kenar gürültüsünü temizler (ince çizgileri korur: yalnız ≥5 komşu anlaşırsa). */
export function modeFilter(lab: Int16Array, w: number, h: number, passes = 1): Int16Array {
  let src = lab;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Int16Array(src);
    // Etiketler küçük tamsayı (-1 = saydam): sayım dizisi + 9 elemanlı değer listesi (Map yok → ~10× hızlı)
    let maxL = 0;
    for (let i = 0; i < src.length; i++) if (src[i] > maxL) maxL = src[i];
    const cnt = new Int32Array(maxL + 2);
    const vals = new Int32Array(9);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x, own = src[p];
      // Hızlı yol: 4 komşu kendisiyle aynıysa değişemez (≥6 karşı oy gerekir)
      if (src[p - 1] === own && src[p + 1] === own && src[p - w] === own && src[p + w] === own) continue;
      let nv = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = src[p + dy * w + dx] + 1; if (cnt[v]++ === 0) vals[nv++] = v; }
      let bv = own + 1, bc = 0;
      for (let i = 0; i < nv; i++) if (cnt[vals[i]] > bc) { bc = cnt[vals[i]]; bv = vals[i]; }
      if (bv !== own + 1 && bc >= 6 && cnt[own + 1] <= 2) out[p] = bv - 1;
      for (let i = 0; i < nv; i++) cnt[vals[i]] = 0;
    }
    src = out;
  }
  return src;
}

/** `minArea`dan küçük bağlı bileşenleri (4-komşuluk) en çok sınır paylaştıkları etikete kat (lekeleri sil). */
export function removeSpeckles(lab: Int16Array, w: number, h: number, minArea: number): number {
  if (minArea <= 1) return 0;
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp = new Int32Array(Math.max(1, minArea));
  let maxL = 0;
  for (let i = 0; i < n; i++) if (lab[i] > maxL) maxL = lab[i];
  // Sınır sayımı: etiket+1 dizini (−1 saydam = 0); dokunulanlar listesiyle sıfırlanır (kapanış / Map yok)
  const bcnt = new Int32Array(maxL + 2);
  const touched: number[] = [];
  let removed = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const v = lab[s];
    let sp = 0, size = 0;
    stack[sp++] = s; seen[s] = 1;
    touched.length = 0;
    while (sp) {
      const p = stack[--sp];
      if (size < minArea) comp[size] = p;
      size++;
      const x = p % w;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? (x > 0 ? p - 1 : -1) : k === 1 ? (x < w - 1 ? p + 1 : -1) : k === 2 ? p - w : p + w;
        if (q < 0 || q >= n) continue;
        const lq = lab[q];
        if (lq === v) { if (!seen[q]) { seen[q] = 1; stack[sp++] = q; } }
        else if (size < minArea) { if (bcnt[lq + 1]++ === 0) touched.push(lq + 1); }
      }
    }
    if (size < minArea && touched.length) {
      let bv = v, bc = -1;
      for (const t of touched) if (bcnt[t] > bc) { bc = bcnt[t]; bv = t - 1; }
      for (let i = 0; i < size; i++) lab[comp[i]] = bv;
      removed++;
    }
    for (const t of touched) bcnt[t] = 0;
  }
  return removed;
}
