import type { PathPoint, Point, SubPath } from '../common/types.js';

// Boolean/ofset sonrası düzleşmiş poligonları yeniden düzenlenebilir kübik Bézier'lere çevirir.
// Köşeler korunur; aradaki "eğri" nokta dizileri Schneider (Graphics Gems I, 1990) algoritmasıyla uydurulur.

type V = Point;
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;
const len = (a: V) => Math.hypot(a.x, a.y);
const norm = (a: V): V => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y);

type Bez = [V, V, V, V];

function bezAt(b: Bez, t: number): V {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * b[0].x + 3 * mt * mt * t * b[1].x + 3 * mt * t * t * b[2].x + t * t * t * b[3].x,
    y: mt * mt * mt * b[0].y + 3 * mt * mt * t * b[1].y + 3 * mt * t * t * b[2].y + t * t * t * b[3].y,
  };
}
function bezD1(b: Bez, t: number): V {
  const mt = 1 - t;
  return add(add(mul(sub(b[1], b[0]), 3 * mt * mt), mul(sub(b[2], b[1]), 6 * mt * t)), mul(sub(b[3], b[2]), 3 * t * t));
}
function bezD2(b: Bez, t: number): V {
  return add(mul(add(sub(b[2], mul(b[1], 2)), b[0]), 6 * (1 - t)), mul(add(sub(b[3], mul(b[2], 2)), b[1]), 6 * t));
}

function chordParams(pts: V[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i], pts[i - 1]));
  const L = u[u.length - 1] || 1;
  return u.map((x) => x / L);
}

function generate(pts: V[], u: number[], t1: V, t2: V): Bez {
  const first = pts[0], last = pts[pts.length - 1];
  const C = [[0, 0], [0, 0]], X = [0, 0];
  for (let i = 0; i < pts.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const A1 = mul(t1, b1), A2 = mul(t2, b2);
    C[0][0] += dot(A1, A1); C[0][1] += dot(A1, A2); C[1][1] += dot(A2, A2);
    const tmp = sub(pts[i], add(mul(first, b0 + b1), mul(last, b2 + b3)));
    X[0] += dot(A1, tmp); X[1] += dot(A2, tmp);
  }
  C[1][0] = C[0][1];
  const det = C[0][0] * C[1][1] - C[1][0] * C[0][1];
  let a1 = 0, a2 = 0;
  if (Math.abs(det) > 1e-12) {
    a1 = (X[0] * C[1][1] - X[1] * C[0][1]) / det;
    a2 = (C[0][0] * X[1] - C[1][0] * X[0]) / det;
  }
  const seg = dist(first, last), eps = 1e-6 * seg;
  if (a1 < eps || a2 < eps) { a1 = a2 = seg / 3; } // sayısal bozulma: Wu/Barsky sezgisi
  return [first, add(first, mul(t1, a1)), add(last, mul(t2, a2)), last];
}

function maxError(pts: V[], b: Bez, u: number[]): { err: number; idx: number } {
  let err = 0, idx = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = dist(bezAt(b, u[i]), pts[i]);
    if (d > err) { err = d; idx = i; }
  }
  return { err, idx };
}

function reparam(b: Bez, pts: V[], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(bezAt(b, t), pts[i]), d1 = bezD1(b, t), d2 = bezD2(b, t);
    const den = dot(d1, d1) + dot(d, d2);
    const nt = Math.abs(den) < 1e-12 ? t : t - dot(d, d1) / den;
    return Math.min(1, Math.max(0, nt));
  });
}

function fitCubic(pts: V[], t1: V, t2: V, tol: number, out: Bez[], depth = 0): void {
  if (pts.length === 2) {
    const d = dist(pts[0], pts[1]) / 3;
    out.push([pts[0], add(pts[0], mul(t1, d)), add(pts[1], mul(t2, d)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let b = generate(pts, u, t1, t2);
  let { err, idx } = maxError(pts, b, u);
  if (err <= tol) { out.push(b); return; }
  if (err <= tol * 4) {
    for (let k = 0; k < 6; k++) {
      u = reparam(b, pts, u);
      b = generate(pts, u, t1, t2);
      ({ err, idx } = maxError(pts, b, u));
      if (err <= tol) { out.push(b); return; }
    }
  }
  if (depth > 12) { out.push(b); return; }
  const tc = norm(sub(pts[idx - 1], pts[idx + 1]));
  fitCubic(pts.slice(0, idx + 1), t1, tc, tol, out, depth + 1);
  fitCubic(pts.slice(idx), mul(tc, -1), t2, tol, out, depth + 1);
}

const isCollinearRun = (pts: V[], tol: number) => {
  const a = pts[0], b = pts[pts.length - 1], ab = sub(b, a), L = len(ab) || 1;
  return pts.every((p) => Math.abs((p.x - a.x) * ab.y - (p.y - a.y) * ab.x) / L <= tol);
};

/**
 * Kapalı poligonu çapa+handle yoluna çevir.
 * @param tol  uydurma hatası (birim)
 * @param cornerDeg  bu açıdan keskin dönüşler köşe sayılır
 */
export function fitClosedPolygon(poly: V[], tol = 0.2, cornerDeg = 32): SubPath {
  // Tekrarlı/çakışık noktaları at
  const p = poly.filter((q, i) => dist(q, poly[(i + poly.length - 1) % poly.length]) > 1e-6);
  const n = p.length;
  if (n < 3) return { closed: true, points: p.map((q) => ({ x: q.x, y: q.y })) };
  const cosLim = Math.cos((cornerDeg * Math.PI) / 180);
  const turn = (i: number) => {
    const a = norm(sub(p[i], p[(i - 1 + n) % n])), b = norm(sub(p[(i + 1) % n], p[i]));
    return dot(a, b);
  };
  // Uzun segmentler (düzleştirme toleransının çok üstünde) gerçek düz kenardır: uçları köşe sayılır.
  const segLen = p.map((q, i) => dist(q, p[(i + 1) % n]));
  const sorted = [...segLen].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const longSeg = (i: number) => segLen[i] > Math.max(8 * median, 12 * tol);
  const corner = p.map((_, i) => turn(i) < cosLim || longSeg(i) || longSeg((i - 1 + n) % n));
  let start = corner.indexOf(true);
  const allSmooth = start < 0;
  if (allSmooth) start = 0;

  const order = Array.from({ length: n }, (_, k) => (start + k) % n);
  const cornersAt = order.filter((i) => corner[i] || (allSmooth && (i === start || i === order[Math.floor(n / 2)])));
  const beziers: { b: Bez; line: boolean }[] = [];
  for (let c = 0; c < cornersAt.length; c++) {
    const i0 = cornersAt[c], i1 = cornersAt[(c + 1) % cornersAt.length];
    const run: V[] = [];
    for (let k = i0; ; k = (k + 1) % n) { run.push(p[k]); if (k === i1 && run.length > 1) break; if (run.length > n + 1) break; }
    if (run.length === 2 || isCollinearRun(run, tol)) { beziers.push({ b: [run[0], run[0], run[run.length - 1], run[run.length - 1]], line: true }); continue; }
    const smoothEnd = (i: number) => !corner[i];
    // Uç teğetleri: köşede tek yönlü, pürüzsüz sınırda merkezi fark (süreklilik)
    const t1 = smoothEnd(i0) ? norm(sub(p[(i0 + 1) % n], p[(i0 - 1 + n) % n])) : norm(sub(run[1], run[0]));
    const t2 = smoothEnd(i1) ? norm(sub(p[(i1 - 1 + n) % n], p[(i1 + 1) % n])) : norm(sub(run[run.length - 2], run[run.length - 1]));
    const out: Bez[] = [];
    fitCubic(run, t1, t2, tol, out);
    for (const b of out) beziers.push({ b, line: false });
  }
  // Bézier listesini çapa noktalarına dök
  const pts: PathPoint[] = [];
  const r = (v: number) => Math.round(v * 1000) / 1000;
  for (const { b, line } of beziers) {
    const a: PathPoint = pts.length ? pts[pts.length - 1] : (pts.push({ x: r(b[0].x), y: r(b[0].y) }), pts[0]);
    if (!line) a.out = { dx: r(b[1].x - b[0].x), dy: r(b[1].y - b[0].y) };
    const e: PathPoint = { x: r(b[3].x), y: r(b[3].y) };
    if (!line) e.in = { dx: r(b[2].x - b[3].x), dy: r(b[2].y - b[3].y) };
    pts.push(e);
  }
  // Son nokta = ilk nokta: in-handle'ı ilk noktaya taşı
  if (pts.length > 1) {
    const last = pts.pop()!;
    if (last.in) pts[0].in = last.in;
  }
  return { closed: true, points: pts };
}
