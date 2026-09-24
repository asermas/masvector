import type { GradientStop, Paint } from '../common/types.js';
import { rgbToOklab, type Raster } from './quantize.js';

// Gradyan farkında segmentasyon: görseli KESKİN kenarlarla ayrılan bölgelere böler (yumuşak geçişler tek bölge kalır),
// her bölgeye sabit / doğrusal / radyal gradyan modeli uydurur. Uymayanlar renk kümeleriyle bölünüp yeniden uydurulur.

export interface Region {
  id: number;
  area: number;
  bbox: [number, number, number, number];
  paint: Paint;          // çalışma pikseli koordinatında
  model: 'solid' | 'linear' | 'radial';
  rms: number;           // 0..255 ölçeğinde kalıntı hata
  /** İnce şerit (≈1–2 px; genelde kenar yumuşatma karışımı). İzlemede kalın komşu varsa aday olmaz. */
  thin?: boolean;
}

export interface Segmentation { labels: Int32Array; regions: Region[]; w: number; h: number; prediction?: Uint8ClampedArray }

class DSU {
  p: Int32Array; r: Uint8Array;
  constructor(n: number) { this.p = new Int32Array(n).map((_, i) => i); this.r = new Uint8Array(n); }
  find(x: number): number { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a: number, b: number) {
    a = this.find(a); b = this.find(b); if (a === b) return;
    if (this.r[a] < this.r[b]) [a, b] = [b, a];
    this.p[b] = a; if (this.r[a] === this.r[b]) this.r[a]++;
  }
}

const h2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
/** #rrggbb; alfa neredeyse opak değilse #rrggbbaa (izleme katmanında fill + fillOpacity'ye ayrılır). */
const hex = (r: number, g: number, b: number, a = 255) => `#${h2(r)}${h2(g)}${h2(b)}${a < 252 ? h2(a) : ''}`;

/** Gauss eliminasyonuyla küçük doğrusal sistem çöz (normal denklemler). */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Renk eğrisini (t → rgb) Douglas–Peucker ile az duraklı gradyana indir. */
function curveToStops(ts: number[], cols: number[][], tol: number, maxStops = 8): { t: number; c: number[] }[] {
  const n = ts.length;
  if (n === 0) return [];
  if (n === 1) return [{ t: 0, c: cols[0] }, { t: 1, c: cols[0] }];
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const rec = (a: number, b: number) => {
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const u = (ts[i] - ts[a]) / (ts[b] - ts[a] || 1);
      let d = 0;
      for (let k = 0; k < cols[i].length; k++) d = Math.max(d, Math.abs(cols[i][k] - (cols[a][k] + (cols[b][k] - cols[a][k]) * u)));
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; rec(a, worst); rec(worst, b); }
  };
  rec(0, n - 1);
  let out = ts.map((t, i) => ({ t, c: cols[i] })).filter((_, i) => keep[i]);
  while (out.length > maxStops) { // en az önemli durağı at
    let bi = 1, bd = Infinity;
    for (let i = 1; i < out.length - 1; i++) {
      const u = (out[i].t - out[i - 1].t) / (out[i + 1].t - out[i - 1].t || 1);
      const d = Math.max(...out[i].c.map((_, k) => Math.abs(out[i].c[k] - (out[i - 1].c[k] + (out[i + 1].c[k] - out[i - 1].c[k]) * u))));
      if (d < bd) { bd = d; bi = i; }
    }
    out.splice(bi, 1);
  }
  return out;
}

interface Px { x: Float64Array; y: Float64Array; c: Float64Array[] }

/** Boyayı (x, y) noktasında RGBA olarak değerlendir (segmentasyon pikseli koordinatı). */
export function evalPaint(p: Paint, x: number, y: number): [number, number, number, number] {
  const parse = (c: string, op = 1): [number, number, number, number] => {
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
    if (!m) return [0, 0, 0, 255 * op];
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, (m[2] ? parseInt(m[2], 16) : 255) * op];
  };
  if (typeof p === 'string') return parse(p);
  let t: number;
  if (p.type === 'linear') {
    const dx = p.x2 - p.x1, dy = p.y2 - p.y1, L2 = dx * dx + dy * dy || 1;
    t = ((x - p.x1) * dx + (y - p.y1) * dy) / L2;
  } else t = Math.hypot(x - p.cx, y - p.cy) / (p.r || 1);
  const st = p.stops;
  if (t <= st[0].offset) return parse(st[0].color, st[0].opacity ?? 1);
  for (let i = 1; i < st.length; i++) {
    if (t <= st[i].offset) {
      const a = parse(st[i - 1].color, st[i - 1].opacity ?? 1), b = parse(st[i].color, st[i].opacity ?? 1);
      const u = (t - st[i - 1].offset) / (st[i].offset - st[i - 1].offset || 1);
      return [0, 1, 2, 3].map((k) => a[k] + (b[k] - a[k]) * u) as [number, number, number, number];
    }
  }
  const l = st[st.length - 1];
  return parse(l.color, l.opacity ?? 1);
}

/** Bölge piksellerine sabit/doğrusal/radyal model uydur; en düşük kalıntılıyı seç. */
function fitModel(px: Px, n: number): { paint: Paint; model: Region['model']; rms: number; pred: (i: number, k: number) => number } {
  const C = px.c.length; // 4: R, G, B, A
  const mean = px.c.map((ch) => { let s = 0; for (let i = 0; i < n; i++) s += ch[i]; return s / n; });
  const rmsOf = (pred: (i: number, k: number) => number) => {
    let e = 0;
    for (let i = 0; i < n; i++) for (let k = 0; k < C; k++) { const d = px.c[k][i] - pred(i, k); e += d * d; }
    return Math.sqrt(e / (n * C));
  };
  const solidPred = (_: number, k: number) => mean[k];
  const solid = { paint: hex(mean[0], mean[1], mean[2], mean[3]) as Paint, model: 'solid' as const, rms: rmsOf(solidPred), pred: solidPred };
  if (n < 60 || solid.rms < 2.5) return solid;

  // Ortak eksen: her kanalın düzlem eğimi (gx, gy); yön = eğimlerin temel bileşeni
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += px.x[i]; sy += px.y[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = px.x[i] - mx, dy = px.y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const G: number[][] = [];
  for (let k = 0; k < C; k++) {
    let bx = 0, by = 0;
    for (let i = 0; i < n; i++) { const dc = px.c[k][i] - mean[k]; bx += (px.x[i] - mx) * dc; by += (px.y[i] - my) * dc; }
    const g = solve([[sxx, sxy], [sxy, syy]], [bx, by]);
    G.push(g ?? [0, 0]);
  }
  const a11 = G.reduce((s, g) => s + g[0] * g[0], 0), a12 = G.reduce((s, g) => s + g[0] * g[1], 0), a22 = G.reduce((s, g) => s + g[1] * g[1], 0);
  const th = 0.5 * Math.atan2(2 * a12, a11 - a22);
  const dir = [Math.cos(th), Math.sin(th)];

  const binCurve = (tv: Float64Array, bins: number) => {
    let t0 = Infinity, t1 = -Infinity;
    for (let i = 0; i < n; i++) { if (tv[i] < t0) t0 = tv[i]; if (tv[i] > t1) t1 = tv[i]; }
    const span = t1 - t0 || 1;
    const acc = Array.from({ length: bins }, () => new Array(C + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const b = Math.min(bins - 1, Math.floor(((tv[i] - t0) / span) * bins));
      for (let k = 0; k < C; k++) acc[b][k] += px.c[k][i];
      acc[b][C]++;
    }
    const ts: number[] = [], cols: number[][] = [];
    const minCount = Math.max(1, Math.min(3, Math.floor(n / bins / 2)));
    acc.forEach((a, b) => { if (a[C] >= minCount) { ts.push((b + 0.5) / bins); cols.push(a.slice(0, C).map((v) => v / a[C])); } });
    let stops = curveToStops(ts, cols, 3);
    if (stops.length === 0) stops = [{ t: 0, c: mean }, { t: 1, c: mean }];
    else if (stops.length === 1) stops = [{ t: 0, c: stops[0].c }, { t: 1, c: stops[0].c }];
    // durakları [0,1] aralığına yay: uç duraklar eksen uçlarına
    const s0 = stops[0]?.t ?? 0, s1 = stops[stops.length - 1]?.t ?? 1;
    const tA = t0 + s0 * span, tB = t0 + s1 * span;
    const norm = stops.map((s) => ({ t: (s.t - s0) / (s1 - s0 || 1), c: s.c }));
    const interp = (tt: number, k: number) => {
      const u = (tt - tA) / (tB - tA || 1);
      if (u <= 0) return norm[0].c[k];
      if (u >= 1) return norm[norm.length - 1].c[k];
      let j = 1; while (j < norm.length - 1 && norm[j].t < u) j++;
      const a = norm[j - 1], b = norm[j], v = (u - a.t) / (b.t - a.t || 1);
      return a.c[k] + (b.c[k] - a.c[k]) * v;
    };
    return { norm, tA, tB, interp };
  };
  const toStops = (norm: { t: number; c: number[] }[]): GradientStop[] => norm.map((s) => ({
    offset: Math.round(s.t * 1e4) / 1e4, color: hex(s.c[0], s.c[1], s.c[2]),
    ...(C > 3 && s.c[3] < 252 ? { opacity: Math.round((s.c[3] / 255) * 1000) / 1000 } : {}),
  }));

  // Doğrusal
  const tl = new Float64Array(n);
  for (let i = 0; i < n; i++) tl[i] = px.x[i] * dir[0] + px.y[i] * dir[1];
  const L = binCurve(tl, 64);
  const linPred = (i: number, k: number) => L.interp(tl[i], k);
  const linear = {
    paint: { type: 'linear', x1: dir[0] * L.tA, y1: dir[1] * L.tA, x2: dir[0] * L.tB, y2: dir[1] * L.tB, stops: toStops(L.norm) } as Paint,
    model: 'linear' as const, rms: rmsOf(linPred), pred: linPred,
  };

  // Radyal: parlaklığa izotropik ikinci derece yüzey uydur → merkez
  let best = linear.rms < solid.rms * 0.85 ? linear : solid;
  {
    const lum = new Float64Array(n);
    for (let i = 0; i < n; i++) lum[i] = 0.299 * px.c[0][i] + 0.587 * px.c[1][i] + 0.114 * px.c[2][i];
    // L = a + b x + c y + d (x²+y²)  (merkezlenmiş koordinatlarda sayısal kararlılık)
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], B = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const x = px.x[i] - mx, y = px.y[i] - my, r2 = x * x + y * y, v = [1, x, y, r2];
      for (let a = 0; a < 4; a++) { B[a] += v[a] * lum[i]; for (let b = 0; b < 4; b++) A[a][b] += v[a] * v[b]; }
    }
    const sol = solve(A, B);
    if (sol && Math.abs(sol[3]) > 1e-9) {
      const cx = mx - sol[1] / (2 * sol[3]), cy = my - sol[2] / (2 * sol[3]);
      const tr = new Float64Array(n);
      for (let i = 0; i < n; i++) tr[i] = Math.hypot(px.x[i] - cx, px.y[i] - cy);
      const R = binCurve(tr, 64);
      const radPred = (i: number, k: number) => R.interp(tr[i], k);
      const radRms = rmsOf(radPred);
      // Radyal gradyan r=0 merkezden başlar: duraklar [tA/tB, 1]'e yerleşir
      if (radRms < best.rms * 0.85 && R.tB > 1) {
        const stops = toStops(R.norm).map((s) => ({ ...s, offset: Math.round(((R.tA + s.offset * (R.tB - R.tA)) / R.tB) * 1e4) / 1e4 }));
        best = { paint: { type: 'radial', cx, cy, r: R.tB, stops }, model: 'radial', rms: radRms, pred: radPred } as any;
      }
    }
  }
  return best;
}

export interface SegmentOptions {
  /** Komşu pikseller arası bu OKLab farkının üstü kenar sayılır. */
  edge?: number;
  minArea?: number;
  /** Bu kalıntının (0–255) üstündeki bölgeler bölünür. */
  maxRms?: number;
  /** Kalıntı ayırma eşiği (kanal farkı 0–255). */
  outlier?: number;
  alphaCut?: number;
  /** Yumuşatma şeritlerini komşulara erit (varsayılan kapalı). */
  mergeThin?: boolean;
  /** Şerit sayılma eşiği: alan / sınır pikseli (büyütmede k ile ölçeklenir). */
  thinRatio?: number;
  /** Hata ayıklama: her pikselin bölge modeliyle tahmin edilen rengini döndür. */
  debugPrediction?: boolean;
}

/** Görseli gradyanlı/düz bölgelere ayır ve boya modellerini uydur. */
export function segmentRegions(img: Raster, o: SegmentOptions = {}): Segmentation {
  const { w, h, rgba } = img;
  const n = w * h;
  const edge = o.edge ?? 0.045, minArea = o.minArea ?? 24, maxRms = o.maxRms ?? 7, alphaCut = o.alphaCut ?? 8;
  const outlierT = o.outlier ?? 7; // kanal sapması (0–255): bunun üstü "görünür" sapma
  const L = new Float32Array(n), A = new Float32Array(n), Bc = new Float32Array(n);
  for (let p = 0; p < n; p++) { const [l, a, b] = rgbToOklab(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]); L[p] = l; A[p] = a; Bc[p] = b; }
  const opaque = (p: number) => rgba[p * 4 + 3] >= alphaCut;
  // Renk + alfa farkı (yarı saydam kenarlar/yumuşak gölgeler de bölge sınırı olabilsin)
  const d = (p: number, q: number) => Math.sqrt((L[p] - L[q]) ** 2 + (A[p] - A[q]) ** 2 + (Bc[p] - Bc[q]) ** 2 + ((rgba[p * 4 + 3] - rgba[q * 4 + 3]) / 255) ** 2);
  const dsu = new DSU(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!opaque(p)) continue;
    if (x + 1 < w && opaque(p + 1) && d(p, p + 1) < edge) dsu.union(p, p + 1);
    if (y + 1 < h && opaque(p + w) && d(p, p + w) < edge) dsu.union(p, p + w);
  }
  // Etiketle
  let labels = new Int32Array(n).fill(-1);
  const rootId = new Map<number, number>();
  for (let p = 0; p < n; p++) if (opaque(p)) { const r = dsu.find(p); let id = rootId.get(r); if (id === undefined) { id = rootId.size; rootId.set(r, id); } labels[p] = id; }
  let count = rootId.size;

  // Küçük bölgeleri (yumuşatma pikselleri, gürültü) renkçe en yakın komşuya kat — tekrarla
  for (let iter = 0; iter < 6; iter++) {
    const area = new Float64Array(count), sL = new Float64Array(count), sA = new Float64Array(count), sB = new Float64Array(count);
    for (let p = 0; p < n; p++) { const l = labels[p]; if (l < 0) continue; area[l]++; sL[l] += L[p]; sA[l] += A[p]; sB[l] += Bc[p]; }
    const mean = (l: number) => [sL[l] / area[l], sA[l] / area[l], sB[l] / area[l]];
    const small = new Set<number>();
    for (let l = 0; l < count; l++) if (area[l] > 0 && area[l] < minArea) small.add(l);
    if (!small.size) break;
    const target = new Map<number, number>(), scores = new Map<number, number>();
    for (let p = 0; p < n; p++) {
      const l = labels[p];
      if (!small.has(l)) continue;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1]) {
        if (q < 0) continue;
        const m = labels[q];
        if (m < 0 || m === l) continue;
        const ml = mean(l), mm = mean(m);
        // renkçe en yakın komşu; büyük komşu tercih edilir (küçük↔küçük zincirlerini kısaltır)
        const score = (ml[0] - mm[0]) ** 2 + (ml[1] - mm[1]) ** 2 + (ml[2] - mm[2]) ** 2 - (small.has(m) ? 0 : 1e-3);
        if (!target.has(l) || score < scores.get(l)!) { target.set(l, m); scores.set(l, score); }
      }
    }
    if (!target.size) break;
    // Zincirleri çöz
    const res = (l: number) => { let k = l, g = 0; while (target.has(k) && g++ < 64) k = target.get(k)!; return k; };
    for (let p = 0; p < n; p++) { const l = labels[p]; if (l >= 0 && target.has(l)) labels[p] = res(l); }
  }
  // Yeniden sırala
  const remap = new Map<number, number>();
  for (let p = 0; p < n; p++) { const l = labels[p]; if (l < 0) continue; let m = remap.get(l); if (m === undefined) { m = remap.size; remap.set(l, m); } labels[p] = m; }
  count = remap.size;

  // Her bölgeye model uydur; kalıntı yüksekse renk kümesine göre böl (en çok 3 düzey)
  const regions: Region[] = [];
  const predImg = o.debugPrediction ? new Uint8ClampedArray(n * 4).fill(255) : null;
  const collect = (list: number[]) => {
    const m = list.length;
    const px: Px = { x: new Float64Array(m), y: new Float64Array(m), c: [new Float64Array(m), new Float64Array(m), new Float64Array(m), new Float64Array(m)] };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    list.forEach((p, i) => {
      const x = p % w, y = (p / w) | 0;
      px.x[i] = x + 0.5; px.y[i] = y + 0.5;
      px.c[0][i] = rgba[p * 4]; px.c[1][i] = rgba[p * 4 + 1]; px.c[2][i] = rgba[p * 4 + 2]; px.c[3][i] = rgba[p * 4 + 3];
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    });
    return { px, bbox: [x0, y0, x1 + 1, y1 + 1] as [number, number, number, number] };
  };
  const members: number[][] = Array.from({ length: count }, () => []);
  for (let p = 0; p < n; p++) if (labels[p] >= 0) members[labels[p]].push(p);
  let nextId = 0;
  const out = new Int32Array(n).fill(-1);
  const process = (list: number[], depth: number) => {
    const { px, bbox } = collect(list);
    const fit = fitModel(px, list.length);
    // 1) Kalıntı ayırma: modelin açıklayamadığı (görünür sapmalı) bağlı piksel kümeleri ayrı bölge olur —
    //    gradyanlı zemin üstündeki düşük kontrastlı şekiller, zemini renk bantlarına bölmeden yakalanır.
    if (depth < 40 && list.length > minArea * 2) {
      const out: number[] = [];
      for (let i = 0; i < list.length; i++) {
        let dev = 0;
        for (let k = 0; k < 4; k++) dev = Math.max(dev, Math.abs(px.c[k][i] - fit.pred(i, k)));
        if (dev > outlierT) out.push(list[i]);
      }
      if (out.length >= minArea) {
        const comps = components(out, w).filter((c) => c.length >= minArea);
        const taken = comps.reduce((a, c) => a + c.length, 0);
        if (comps.length && taken < list.length) {
          const takenSet = new Set<number>();
          for (const c of comps) for (const p of c) takenSet.add(p);
          const rest = list.filter((p) => !takenSet.has(p));
          for (const comp of components(rest, w)) process(comp, depth + 1);
          for (const c of comps) process(c, depth + 1);
          return;
        }
      }
    }
    // 2) Kalıntı dağınıksa (tek küme değil) ve ortalama hata yüksekse: renk kümesine göre ikiye böl
    if (fit.rms > maxRms && depth < 40 && list.length > minArea * 4) {
      // 2-ortalama böl (OKLab), sonra bağlı bileşenlere ayırarak yeniden işle
      let c0 = list[0], c1 = list[list.length - 1], far = 0;
      for (const p of list) { const dd = d(p, c0); if (dd > far) { far = dd; c1 = p; } }
      let m0 = [L[c0], A[c0], Bc[c0]], m1 = [L[c1], A[c1], Bc[c1]];
      const side = new Uint8Array(list.length);
      for (let it = 0; it < 8; it++) {
        const s0 = [0, 0, 0, 0], s1 = [0, 0, 0, 0];
        list.forEach((p, i) => {
          const d0 = (L[p] - m0[0]) ** 2 + (A[p] - m0[1]) ** 2 + (Bc[p] - m0[2]) ** 2, d1 = (L[p] - m1[0]) ** 2 + (A[p] - m1[1]) ** 2 + (Bc[p] - m1[2]) ** 2;
          side[i] = d1 < d0 ? 1 : 0;
          const s = side[i] ? s1 : s0; s[0] += L[p]; s[1] += A[p]; s[2] += Bc[p]; s[3]++;
        });
        if (!s0[3] || !s1[3]) break;
        m0 = [s0[0] / s0[3], s0[1] / s0[3], s0[2] / s0[3]]; m1 = [s1[0] / s1[3], s1[1] / s1[3], s1[2] / s1[3]];
      }
      const halves: number[][] = [[], []];
      list.forEach((p, i) => halves[side[i]].push(p));
      if (halves[0].length && halves[1].length) {
        for (const half of halves) for (const comp of components(half, w)) process(comp, depth + 1);
        return;
      }
    }
    const id = nextId++;
    for (let i = 0; i < list.length; i++) {
      out[list[i]] = id;
      if (predImg) for (let k = 0; k < 4; k++) predImg[list[i] * 4 + k] = fit.pred(i, k);
    }
    regions.push({ id, area: list.length, bbox, paint: fit.paint, model: fit.model, rms: Math.round(fit.rms * 100) / 100 });
  };
  for (const list of members) if (list.length) process(list, 0);

  // İsteğe bağlı: ince şerit bölgeleri (kenar yumuşatma karışımları) → piksellerini, boyası o noktada renge en yakın
  // kalın komşu bölgeye dağıt. Ölçümde sadakati düşürdüğü görüldüğünden varsayılan KAPALI.
  if (o.mergeThin) {
    const boundary = new Float64Array(regions.length), areaR = new Float64Array(regions.length);
    for (let p = 0; p < n; p++) {
      const l = out[p]; if (l < 0) continue;
      areaR[l]++;
      const x = p % w;
      if ((x > 0 && out[p - 1] !== l) || (x < w - 1 && out[p + 1] !== l) || (p >= w && out[p - w] !== l) || (p < n - w && out[p + w] !== l)) boundary[l]++;
    }
    // Karışım testi: şerit pikselinin rengi, 4-komşularındaki iki farklı bölgenin tahmini renkleri arasındaki
    // doğru parçasına yakınsa (kısmi örtme) "karışım" sayılır. Şerit ancak piksellerinin çoğu karışımsa eritilir.
    const byId = new Map(regions.map((r) => [r.id, r]));
    const blendScore = new Float64Array(regions.length);
    const thinRatio = o.thinRatio ?? 1.3;
    const candidateThin = regions.map((r) => areaR[r.id] > 0 && areaR[r.id] / Math.max(1, boundary[r.id]) < thinRatio && areaR[r.id] < n * 0.005);
    const idxOf = new Map(regions.map((r, i) => [r.id, i]));
    for (let p = 0; p < n; p++) {
      const l = out[p]; if (l < 0) continue;
      const ri = idxOf.get(l)!;
      if (!candidateThin[ri]) continue;
      const x = p % w, y = (p / w) | 0;
      const nbr = new Set<number>();
      const R = Math.ceil(thinRatio * 1.5) + 1;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const m = out[yy * w + xx];
        if (m >= 0 && m !== l) nbr.add(m);
      }
      const cols = [...nbr].map((m) => evalPaint(byId.get(m)!.paint, x + 0.5, y + 0.5));
      const P = [rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2], rgba[p * 4 + 3]];
      let ok = false;
      for (let a = 0; a < cols.length && !ok; a++) for (let b = a + 1; b < cols.length && !ok; b++) {
        const A0 = cols[a], B0 = cols[b];
        const v = [0, 1, 2, 3].map((k) => B0[k] - A0[k]), vv = v.reduce((q, c) => q + c * c, 0) || 1;
        const t = Math.max(0, Math.min(1, [0, 1, 2, 3].reduce((q, k) => q + (P[k] - A0[k]) * v[k], 0) / vv));
        const dist = Math.sqrt([0, 1, 2, 3].reduce((q, k) => q + (P[k] - A0[k] - t * v[k]) ** 2, 0));
        if (dist < 14) ok = true;
      }
      if (ok) blendScore[ri]++;
    }
    // Saydamlığa sönen şeritler (yumuşak gölge/kenar) gerçek içeriktir: saydama komşu ya da yarı saydam olanlar eritilmez
    const touchesClear = new Uint8Array(regions.length), alphaSum = new Float64Array(regions.length);
    for (let p = 0; p < n; p++) {
      const l = out[p]; if (l < 0) continue;
      const ri = idxOf.get(l)!;
      alphaSum[ri] += rgba[p * 4 + 3];
      const x = p % w;
      if ((x > 0 && out[p - 1] < 0) || (x < w - 1 && out[p + 1] < 0) || (p >= w && out[p - w] < 0) || (p < n - w && out[p + w] < 0)) touchesClear[ri] = 1;
    }
    const thin = regions.map((r, i) => candidateThin[i] && blendScore[i] >= 0.7 * areaR[r.id] && !touchesClear[i] && alphaSum[i] / areaR[r.id] > 245);
    const thinById = new Map(regions.map((r, i) => [r.id, thin[i]]));
    if (thin.some(Boolean)) {
      // Tek geçiş, sırasız: her şerit pikseli için R yarıçapındaki TÜM kalın bölgeler aday; renge en yakın kazanır
      // (tur tur yayılma dış kenara bitişik pikselleri yanlışlıkla dış bölgeye verirdi).
      const R2 = Math.ceil(thinRatio * 2) + 1;
      const assign: [number, number][] = [];
      for (let p = 0; p < n; p++) {
        if (out[p] < 0 || !thinById.get(out[p])) continue;
        const x = p % w, y = (p / w) | 0;
        let best = -1, bd = Infinity;
        const seen = new Set<number>();
        for (let dy = -R2; dy <= R2; dy++) for (let dx = -R2; dx <= R2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const m = out[yy * w + xx];
          if (m < 0 || thinById.get(m) || seen.has(m)) continue;
          seen.add(m);
          const c = evalPaint(byId.get(m)!.paint, x + 0.5, y + 0.5);
          const dd = (c[0] - rgba[p * 4]) ** 2 + (c[1] - rgba[p * 4 + 1]) ** 2 + (c[2] - rgba[p * 4 + 2]) ** 2 + (c[3] - rgba[p * 4 + 3]) ** 2;
          if (dd < bd) { bd = dd; best = m; }
        }
        if (best >= 0) assign.push([p, best]);
      }
      for (const [p, m] of assign) { out[p] = m; if (predImg) { const c = evalPaint(byId.get(m)!.paint, (p % w) + 0.5, ((p / w) | 0) + 0.5); for (let k = 0; k < 4; k++) predImg[p * 4 + k] = c[k]; } }
      // Hiç kalın komşusu olmayan izole ince bölgeler (ör. kıl çizgiler) olduğu gibi kalır
      const alive = new Set<number>();
      for (let p = 0; p < n; p++) if (out[p] >= 0) alive.add(out[p]);
      for (let i = regions.length - 1; i >= 0; i--) if (!alive.has(regions[i].id)) regions.splice(i, 1);
    }
  }
  // İnce şerit işareti (alan / sınır pikseli)
  {
    const bnd = new Map<number, number>(), ar = new Map<number, number>();
    for (let p = 0; p < n; p++) {
      const l = out[p]; if (l < 0) continue;
      ar.set(l, (ar.get(l) ?? 0) + 1);
      const x = p % w;
      if ((x > 0 && out[p - 1] !== l) || (x < w - 1 && out[p + 1] !== l) || (p >= w && out[p - w] !== l) || (p < n - w && out[p + w] !== l)) bnd.set(l, (bnd.get(l) ?? 0) + 1);
    }
    for (const r of regions) { const a = ar.get(r.id) ?? 0; r.thin = a > 0 && a / Math.max(1, bnd.get(r.id) ?? 1) < 1.5; }
  }
  labels = out;
  return { labels, regions, w, h, prediction: predImg ?? undefined };
}

/** Piksel listesini 4-komşulukta bağlı bileşenlere ayır. */
function components(list: number[], w: number): number[][] {
  const set = new Set(list), seen = new Set<number>(), out: number[][] = [];
  for (const s of list) {
    if (seen.has(s)) continue;
    const comp: number[] = [], stack = [s]; seen.add(s);
    while (stack.length) {
      const p = stack.pop()!; comp.push(p);
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && set.has(q) && !seen.has(q)) { seen.add(q); stack.push(q); }
    }
    out.push(comp);
  }
  return out;
}

export interface SoftGroup {
  /** Gruptaki yarı saydam bölge kimlikleri. */
  ids: Set<number>;
  /** Şekil = yarı-alfa üstü yumuşak pikseller ∪ gölgeyi düşüren (bitişik opak) bölgeler. */
  shapeIds: Set<number>;
  rgb: [number, number, number];
  /** 0..1 */
  alpha: number;
  /** Gauss σ (segmentasyon pikseli). */
  sigma: number;
  halfAlpha: number;
}

/**
 * Yumuşak gölge / parıltı tespiti: saydam zemine sönen, aynı renk tonundaki komşu yarı saydam bölgeler tek grup olur.
 * Böyle bir grup "bulanıklaştırılmış tek şekil" ile temsil edilir (tasarımcının drop-shadow/blur efekti) — halkalar yerine.
 */
export function detectSoftGroups(seg: Segmentation, img: Raster, minArea: number): SoftGroup[] {
  const { labels, w, h } = seg;
  const n = w * h, rgba = img.rgba;
  const stat = new Map<number, { a: number; r: number; g: number; b: number; wa: number; cnt: number; clear: boolean }>();
  for (let p = 0; p < n; p++) {
    const l = labels[p]; if (l < 0) continue;
    let s = stat.get(l); if (!s) { s = { a: 0, r: 0, g: 0, b: 0, wa: 0, cnt: 0, clear: false }; stat.set(l, s); }
    const a = rgba[p * 4 + 3];
    s.a += a; s.cnt++; s.r += rgba[p * 4] * a; s.g += rgba[p * 4 + 1] * a; s.b += rgba[p * 4 + 2] * a; s.wa += a;
    const x = p % w;
    if ((x > 0 && labels[p - 1] < 0) || (x < w - 1 && labels[p + 1] < 0) || (p >= w && labels[p - w] < 0) || (p < n - w && labels[p + w] < 0)) s.clear = true;
  }
  const translucent = (l: number) => { const s = stat.get(l); return !!s && s.a / s.cnt < 235; };
  const rgbOf = (l: number): [number, number, number] => { const s = stat.get(l)!; return [s.r / (s.wa || 1), s.g / (s.wa || 1), s.b / (s.wa || 1)]; };
  // Komşuluk
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => { if (a < 0 || b < 0 || a === b) return; (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b); (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a); };
  for (let p = 0; p < n; p++) { const x = p % w; if (x < w - 1) link(labels[p], labels[p + 1]); if (p < n - w) link(labels[p], labels[p + w]); }
  const seen = new Set<number>();
  const groups: SoftGroup[] = [];
  for (const [l] of stat) {
    if (seen.has(l) || !translucent(l)) continue;
    // Renk tonu benzer (RGB ağırlıklı ortalama farkı küçük) yarı saydam komşularla büyüt
    const ids = new Set<number>([l]); const stack = [l]; seen.add(l);
    const base = rgbOf(l);
    while (stack.length) {
      const c = stack.pop()!;
      for (const m of adj.get(c) ?? []) {
        if (seen.has(m) || !translucent(m)) continue;
        const q = rgbOf(m);
        if (Math.hypot(q[0] - base[0], q[1] - base[1], q[2] - base[2]) > 40) continue;
        seen.add(m); ids.add(m); stack.push(m);
      }
    }
    let area = 0, touchesClear = false;
    for (const i of ids) { const s = stat.get(i)!; area += s.cnt; if (s.clear) touchesClear = true; }
    if (area < minArea * 4 || !touchesClear || ids.size < 2) continue;
    // Alfa istatistikleri
    const alphas: number[] = [];
    let r = 0, g = 0, b = 0, wa = 0;
    for (let p = 0; p < n; p++) if (ids.has(labels[p])) { const a = rgba[p * 4 + 3]; alphas.push(a); r += rgba[p * 4] * a; g += rgba[p * 4 + 1] * a; b += rgba[p * 4 + 2] * a; wa += a; }
    alphas.sort((x, y) => x - y);
    const maxA = alphas[Math.floor(alphas.length * 0.97)] || 255;
    const half = maxA / 2;
    // Geçiş genişliği: %10–%90 bandındaki piksel sayısı / dış sınır uzunluğu  (Gauss kenarında ≈ 2.56σ)
    let band = 0, rim = 0;
    for (let p = 0; p < n; p++) {
      if (!ids.has(labels[p])) continue;
      const a = rgba[p * 4 + 3];
      if (a > 0.1 * maxA && a < 0.9 * maxA) band++;
      const x = p % w;
      if ((x > 0 && labels[p - 1] < 0) || (x < w - 1 && labels[p + 1] < 0) || (p >= w && labels[p - w] < 0) || (p < n - w && labels[p + w] < 0)) rim++;
    }
    const width = band / Math.max(1, rim);
    // Kenar yumuşatma halkası (~1 px) gölge değildir: gerçek yumuşak geçiş en az ~2.5 px genişliktedir
    if (width < 2.5) continue;
    const sigma = Math.max(0.5, width / 2.56);
    // Şekil: yumuşak grup + ona bitişik opak bölgeler (gölgeyi düşüren nesne)
    const shapeIds = new Set(ids);
    for (const i of ids) for (const m of adj.get(i) ?? []) if (!translucent(m)) shapeIds.add(m);
    groups.push({ ids, shapeIds, rgb: [r / wa, g / wa, b / wa], alpha: maxA / 255, sigma, halfAlpha: half });
  }
  return groups;
}
