import type { SubPath } from '../common/types.js';
import { fitClosedPolygon, fitOpenPolyline } from '../math/fit.js';

// İnce çizgi → merkez çizgisi (stroke). Dış hat izleme 1–2 px çizgide kalınlığı/konumu ±0,5 px dalgalandırır;
// burada çizgi iskeleti çıkarılır, her nokta rengin KAPLAMA haritasındaki (t: 0 zemin … 1 tam renk) kesit ağırlık
// merkezine alt piksel hassasiyetle taşınır, genişlik kesitteki toplam kaplamadan (= mürekkep miktarı) ölçülür.

type P = { x: number; y: number };

/** Zhang–Suen inceltme (yerinde). */
function thin(m: Uint8Array, w: number, h: number) {
  const del: number[] = [];
  let changed = true;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? m[y * w + x] : 0);
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
        const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let A = 0;
        for (let i = 0; i < 8; i++) if (!seq[i] && seq[i + 1]) A++;
        if (A !== 1) continue;
        if (pass === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        del.push(y * w + x);
      }
      for (const q of del) m[q] = 0;
      if (del.length) changed = true;
    }
  }
}

const NB = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const;

/** İskeleti zincirlere ayır (uç noktalardan başlayarak; kalanlar kapalı döngü). */
function chains(sk: Uint8Array, w: number, h: number): { pts: P[]; closed: boolean }[] {
  const deg = new Uint8Array(w * h);
  const list: number[] = [];
  for (let p = 0; p < w * h; p++) if (sk[p]) {
    list.push(p);
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of NB) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && sk[yy * w + xx]) deg[p]++; }
  }
  const seen = new Uint8Array(w * h);
  const out: { pts: P[]; closed: boolean }[] = [];
  const walk = (start: number) => {
    const pts: P[] = [];
    let p = start, prev = -1, pdx = 0, pdy = 0;
    for (;;) {
      seen[p] = 1;
      const x = p % w, y = (p / w) | 0;
      pts.push({ x: x + 0.5, y: y + 0.5 });
      // Sonraki: görülmemiş komşu; yön sürekliliği en iyi olan (kavşakta düz devam)
      let best = -1, bs = -Infinity;
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!sk[q] || seen[q]) continue;
        const s = (dx * pdx + dy * pdy) / Math.hypot(dx, dy) - (Math.abs(dx) + Math.abs(dy) === 2 ? 0.01 : 0);
        if (s > bs) { bs = s; best = q; }
      }
      if (best < 0) break;
      pdx = (best % w) - x; pdy = ((best / w) | 0) - y;
      prev = p; p = best;
    }
    void prev;
    // Kapalı mı: son nokta başlangıca komşu ve zincir yeterince uzun
    const a = pts[0], b = pts[pts.length - 1];
    const closed = pts.length > 8 && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
    out.push({ pts, closed });
  };
  for (const p of list) if (!seen[p] && deg[p] === 1) walk(p);
  for (const p of list) if (!seen[p] && deg[p] >= 3) walk(p);
  for (const p of list) if (!seen[p]) walk(p);
  return out;
}

/**
 * Kesişim boşluklarını köprüle: iki açık zincirin uçları birbirine bakıyorsa (uç teğetleri ve aradaki doğrultu
 * 35° içinde) ve aralarındaki mesafe ≤ maxGap ise zincirler birleştirilir. Kesişim pikselleri üç rengin karışımı
 * olduğundan iki çizgi de orada kopar; stroke'ta boşluk kalmamalı.
 */
function bridge(cs: { pts: P[]; closed: boolean; len: number }[], maxGap: number, gapOk: (a: P, b: P) => boolean) {
  const cosA = Math.cos((35 * Math.PI) / 180);
  // Uç bilgisi: teğet uçtan içeride ölçülür (uçtaki iskelet çıkıntısı kesişime doğru kıvrılır)
  const endInfo = (c: { pts: P[] }, atStart: boolean) => {
    const n = c.pts.length, k0 = Math.min(n - 2, 3), k1 = Math.min(n - 1, 12);
    const e = atStart ? c.pts[0] : c.pts[n - 1];
    const e2 = atStart ? c.pts[k0] : c.pts[n - 1 - k0], q = atStart ? c.pts[k1] : c.pts[n - 1 - k1];
    const dx = e2.x - q.x, dy = e2.y - q.y, L = Math.hypot(dx, dy) || 1;
    return { p: e, d: { x: dx / L, y: dy / L } };
  };
  // Uçlar: id = 2*zincir + (0 baş, 1 son)
  const ends: { c: number; start: boolean; p: P; d: P }[] = [];
  cs.forEach((c, i) => { if (!c.closed && c.pts.length >= 3) for (const st of [true, false]) ends.push({ c: i, start: st, ...endInfo(c, st) }); });
  if (ends.length < 2) return;
  // Izgara karması → aday çiftler (tek geçiş), mesafeye göre sırala
  const cell = Math.max(1, maxGap), grid = new Map<string, number[]>();
  ends.forEach((e, i) => { const k = `${Math.floor(e.p.x / cell)},${Math.floor(e.p.y / cell)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  const pairs: { i: number; j: number; dist: number }[] = [];
  ends.forEach((A, i) => {
    const gx = Math.floor(A.p.x / cell), gy = Math.floor(A.p.y / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
      if (j <= i || ends[j].c === A.c) continue;
      const B = ends[j];
      const vx = B.p.x - A.p.x, vy = B.p.y - A.p.y, dist = Math.hypot(vx, vy);
      if (dist > maxGap) continue;
      const ux = vx / (dist || 1), uy = vy / (dist || 1);
      if (dist > 1.5 && (A.d.x * ux + A.d.y * uy < cosA || -(B.d.x * ux + B.d.y * uy) < cosA)) continue;
      if (A.d.x * B.d.x + A.d.y * B.d.y > -cosA) continue; // uçlar karşı karşıya değil
      if (dist > 1.5 && !gapOk(A.p, B.p)) continue; // boşluk zemin (harf aralığı) — kesişim değil
      pairs.push({ i, j, dist });
    }
  });
  if (!pairs.length) return;
  pairs.sort((a, b) => a.dist - b.dist);
  // Açgözlü eşleştirme: her uç en çok bir bağ
  const link = new Int32Array(ends.length).fill(-1);
  for (const pr of pairs) if (link[pr.i] < 0 && link[pr.j] < 0) { link[pr.i] = pr.j; link[pr.j] = pr.i; }
  // Uç id → ends dizini
  const endOf = new Map<number, number>();
  ends.forEach((e, i) => endOf.set(e.c * 2 + (e.start ? 0 : 1), i));
  const used = new Uint8Array(cs.length);
  const out: { pts: P[]; closed: boolean; len: number }[] = [];
  const assemble = (c0: number, enterStart: boolean) => {
    // c0'a enterStart ucundan gir, diğer uçtan bağ varsa devam et
    const pts: P[] = []; let len = 0, c = c0, fromStart = enterStart, closed = false;
    for (;;) {
      used[c] = 1;
      const seg = fromStart ? cs[c].pts : [...cs[c].pts].reverse();
      if (pts.length) len += Math.hypot(seg[0].x - pts[pts.length - 1].x, seg[0].y - pts[pts.length - 1].y);
      pts.push(...seg); len += cs[c].len;
      const exitIdx = endOf.get(c * 2 + (fromStart ? 1 : 0));
      if (exitIdx === undefined || link[exitIdx] < 0) break;
      const nx = ends[link[exitIdx]];
      if (used[nx.c]) { closed = nx.c === c0; break; }
      c = nx.c; fromStart = nx.start;
    }
    out.push({ pts, closed: closed && pts.length > 8, len });
  };
  // Önce en az bir ucu serbest olan zincirlerden başla (açık yollar), sonra döngüler
  for (let c = 0; c < cs.length; c++) {
    if (used[c]) continue;
    const s0 = endOf.get(c * 2), s1 = endOf.get(c * 2 + 1);
    if (s0 === undefined) continue; // kapalı/kısa zincir: olduğu gibi
    if (link[s0] < 0) assemble(c, true);
    else if (s1 !== undefined && link[s1] < 0) assemble(c, false);
  }
  for (let c = 0; c < cs.length; c++) if (!used[c]) { if (endOf.has(c * 2)) assemble(c, true); else { used[c] = 1; out.push(cs[c]); } }
  cs.length = 0; cs.push(...out);
}

function sampleT(t: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = x - 0.5, fy = y - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  const g = (xx: number, yy: number) => (xx >= 0 && yy >= 0 && xx < w && yy < h ? t[yy * w + xx] : 0);
  return (g(x0, y0) * (1 - ax) + g(x0 + 1, y0) * ax) * (1 - ay) + (g(x0, y0 + 1) * (1 - ax) + g(x0 + 1, y0 + 1) * ax) * ay;
}

export interface StrokeResult { subpaths: SubPath[]; width: number; length: number }

/**
 * `mask`: rengin piksel maskesi (çalışma çözünürlüğü), `t`: kaplama haritası (aynı boyut). Genişlik ve koordinatlar
 * çalışma pikseli cinsindendir. Çizgi değilse (ortalama genişlik > maxWidth) null.
 */
export function extractStrokes(mask: Uint8Array, t: Float32Array, w: number, h: number, maxWidth: number, gapOk: (a: P, b: P) => boolean, minLenFactor = 1.2, precisionOnly = false, validMask?: Uint8Array): StrokeResult | null {
  let area = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) area++;
  if (!area) return null;
  const sk = mask.slice();
  thin(sk, w, h);
  let skLen = 0;
  for (let i = 0; i < w * h; i++) if (sk[i]) skLen++;
  if (!skLen || area / skLen > maxWidth) return null;
  const cs = chains(sk, w, h);
  const widths: number[] = [];
  const R = Math.ceil(maxWidth) + 2;
  const refined: { pts: P[]; closed: boolean; len: number; cv?: number }[] = [];
  for (const c of cs) {
    const n = c.pts.length;
    if (n < 2) continue;
    const pts: P[] = [];
    const cw: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = c.pts[Math.max(0, i - 2)], b = c.pts[Math.min(n - 1, i + 2)];
      let dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const nx = -dy, ny = dx;
      // Normal boyunca kaplama kesiti: ağırlık merkezi (konum) + toplam (genişlik)
      let s0 = 0, s1 = 0;
      for (let s = -R; s <= R; s += 0.25) { const v = sampleT(t, w, h, c.pts[i].x + nx * s, c.pts[i].y + ny * s); s0 += v; s1 += v * s; }
      const off = s0 > 1e-6 ? Math.max(-1.5, Math.min(1.5, s1 / s0)) : 0;
      widths.push(s0 * 0.25); cw.push(s0 * 0.25);
      pts.push({ x: c.pts[i].x + nx * off, y: c.pts[i].y + ny * off });
    }
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    // Zincir boyunca genişlik değişimi (sivrilen şekil: yıldız ışını, köşe ucu) — sabit genişlikli stroke'a uymaz
    const mean = cw.reduce((a, b) => a + b, 0) / cw.length;
    let cvv = mean > 0 ? Math.sqrt(cw.reduce((a, b) => a + (b - mean) ** 2, 0) / cw.length) / mean : 1;
    // Sivrilme: ilk ve son çeyreğin medyan genişlik oranı
    if (cw.length >= 8) {
      const q = Math.floor(cw.length / 4), med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
      const a = med(cw.slice(0, q)), b = med(cw.slice(-q));
      if (Math.max(a, b) > 1.5 * Math.max(0.05, Math.min(a, b))) cvv = Math.max(cvv, 1);
    }
    refined.push({ pts, closed: c.closed, len, cv: cvv });
  }
  if (!widths.length) return null;
  widths.sort((a, b) => a - b);
  const width = Math.max(0.5, widths[Math.floor(widths.length / 2)]);
  bridge(refined, 6 * width + 8, gapOk);
  const subpaths: SubPath[] = [];
  let length = 0;
  for (const r of refined) {
    // Kavşak çıkıntısı (kısa kol) at; tek başına kısa parçalar (nokta/kısa çizgi) kalır
    if (r.len < width * minLenFactor && (refined.length > 1 || minLenFactor > 1.2)) continue;
    if (precisionOnly && (r.cv ?? 0) > 0.3) continue;
    length += r.len;
    const tol = Math.max(0.15, width * 0.12);
    if (r.closed && r.pts.length >= 6) subpaths.push(fitClosedPolygon(r.pts, tol, 50, false));
    else if (r.pts.length >= 3) subpaths.push(fitOpenPolyline(r.pts, tol, 50));
    else subpaths.push({ closed: false, points: r.pts.map((p) => ({ x: p.x, y: p.y })) });
  }
  if (!subpaths.length) return null;
  // Doğrulama: stroke'lar (yarıçap = genişlik/2 + 0.75 px) maskeyi örtmeli; örtmüyorsa (metin gövdesi, kalın/dolgu
  // şekil, dağınık lekeler) dış hat izlemeye bırak
  const cov = new Uint8Array(w * h);
  const rad = width / 2 + 0.75;
  for (const r of refined) {
    if (r.len < width * minLenFactor && (refined.length > 1 || minLenFactor > 1.2)) continue;
    for (let i = 0; i < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[Math.min(r.pts.length - 1, i + 1)];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
      for (let st = 0; st <= steps; st++) {
        const cx = a.x + ((b.x - a.x) * st) / steps, cy = a.y + ((b.y - a.y) * st) / steps;
        for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(h - 1, Math.ceil(cy + rad)); y++)
          for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(w - 1, Math.ceil(cx + rad)); x++)
            if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= rad * rad) cov[y * w + x] = 1;
      }
    }
  }
  let inter = 0, uni = 0, cv = 0;
  const vm = validMask ?? mask;
  for (let i = 0; i < w * h; i++) { if (vm[i] && cov[i]) inter++; if (vm[i] || cov[i]) uni++; if (cov[i]) cv++; }
  // precisionOnly: stroke'lar dolgunun ÜSTÜNE eklenir → tek risk maske dışına taşmak (kesinlik ≥ %75)
  if (precisionOnly ? cv === 0 || inter / cv < 0.75 : uni === 0 || inter / uni < 0.6) return null;
  return { subpaths, width, length };
}

/**
 * Maskenin "ince kısımları": yerel kalınlığı (2 × pencere içindeki en büyük uzaklık dönüşümü) ≤ maxThick olan
 * pikseller. Kalın şekle bağlanan 1 px çizgiler böyle ayrılır; kalın şeklin içi/kenarı dahil olmaz.
 */
export function thinParts(mask: Uint8Array, w: number, h: number, maxThick: number): Uint8Array {
  // Chamfer 3-4 uzaklık dönüşümü (arka plana), piksel birimi ×3
  const INF = 1 << 28, d = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; if (!d[p]) continue;
    let v = d[p];
    if (x > 0) v = Math.min(v, d[p - 1] + 3); else v = Math.min(v, 3);
    if (y > 0) { v = Math.min(v, d[p - w] + 3); if (x > 0) v = Math.min(v, d[p - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[p - w + 1] + 4); } else v = Math.min(v, 3);
    d[p] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const p = y * w + x; if (!d[p]) continue;
    let v = d[p];
    if (x < w - 1) v = Math.min(v, d[p + 1] + 3); else v = Math.min(v, 3);
    if (y < h - 1) { v = Math.min(v, d[p + w] + 3); if (x < w - 1) v = Math.min(v, d[p + w + 1] + 4); if (x > 0) v = Math.min(v, d[p + w - 1] + 4); } else v = Math.min(v, 3);
    d[p] = v;
  }
  // Yerel kalınlık: pencere (r = maxThick/2 + 1) içindeki en büyük uzaklık × 2; ayrılabilir en büyük süzgeç
  const r = Math.ceil(maxThick / 2) + 1;
  const tmp = new Int32Array(w * h), mx = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (d[y * w + k] > m) m = d[y * w + k]; tmp[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x]; mx[y * w + x] = m; }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i] && (2 * mx[i]) / 3 <= maxThick) out[i] = 1;
  return out;
}
