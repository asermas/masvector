import type { BBox, Matrix, PathPoint, Point, Polygon, SubPath } from '../common/types.js';
import { apply, applyVec } from './matrix.js';

export interface Cubic { p0: Point; p1: Point; p2: Point; p3: Point }

export const emptyBBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
export const isEmptyBBox = (b: BBox) => !(b.minX <= b.maxX && b.minY <= b.maxY);
export function growBBox(b: BBox, p: Point): void {
  if (p.x < b.minX) b.minX = p.x; if (p.x > b.maxX) b.maxX = p.x;
  if (p.y < b.minY) b.minY = p.y; if (p.y > b.maxY) b.maxY = p.y;
}
export function unionBBox(a: BBox, b: BBox): BBox {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

export function cubicAt(c: Cubic, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
  return { x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x, y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y };
}

/** Kübik türevinin kökleri (0,1) içinde — tek eksen için. */
function extremaT(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

/** Kübiğin kesin sınır kutusu (türev kökleriyle, kontrol-noktası kutusu değil). */
export function cubicBBox(c: Cubic, into: BBox = emptyBBox()): BBox {
  growBBox(into, c.p0); growBBox(into, c.p3);
  for (const t of [...extremaT(c.p0.x, c.p1.x, c.p2.x, c.p3.x), ...extremaT(c.p0.y, c.p1.y, c.p2.y, c.p3.y)])
    growBBox(into, cubicAt(c, t));
  return into;
}

const isLine = (c: Cubic) =>
  c.p1.x === c.p0.x && c.p1.y === c.p0.y && c.p2.x === c.p3.x && c.p2.y === c.p3.y;

/** Uyarlamalı düzleştirme: kontrol noktalarının kirişe uzaklığı toleransın altına inene dek böl. */
export function flattenCubic(c: Cubic, tol: number, out: Point[], depth = 0): void {
  if (isLine(c)) { out.push(c.p3); return; }
  const dx = c.p3.x - c.p0.x, dy = c.p3.y - c.p0.y;
  const d1 = Math.abs((c.p1.x - c.p3.x) * dy - (c.p1.y - c.p3.y) * dx);
  const d2 = Math.abs((c.p2.x - c.p3.x) * dy - (c.p2.y - c.p3.y) * dx);
  const len2 = dx * dx + dy * dy;
  // d1,d2 = |çapraz çarpım| = kirişe uzaklık · kiriş boyu. Kiriş ~0 ise (kapalı döngü) kontrol noktalarının uzaklığına bak.
  const flat = len2 > 1e-12
    ? (d1 + d2) * (d1 + d2) <= tol * tol * len2
    : Math.max(Math.hypot(c.p1.x - c.p0.x, c.p1.y - c.p0.y), Math.hypot(c.p2.x - c.p0.x, c.p2.y - c.p0.y)) <= tol;
  if (flat || depth > 16) {
    out.push(c.p3);
    return;
  }
  // de Casteljau t=0.5
  const m = (p: Point, q: Point) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  const p01 = m(c.p0, c.p1), p12 = m(c.p1, c.p2), p23 = m(c.p2, c.p3);
  const p012 = m(p01, p12), p123 = m(p12, p23), mid = m(p012, p123);
  flattenCubic({ p0: c.p0, p1: p01, p2: p012, p3: mid }, tol, out, depth + 1);
  flattenCubic({ p0: mid, p1: p123, p2: p23, p3: c.p3 }, tol, out, depth + 1);
}

/** Alt yolun segmentlerini kübik olarak gez (kapalıysa son→ilk segmenti de). */
export function segments(sp: SubPath): Cubic[] {
  const pts = sp.points;
  const out: Cubic[] = [];
  const n = pts.length;
  const count = sp.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push({
      p0: { x: a.x, y: a.y },
      p1: a.out ? { x: a.x + a.out.dx, y: a.y + a.out.dy } : { x: a.x, y: a.y },
      p2: b.in ? { x: b.x + b.in.dx, y: b.y + b.in.dy } : { x: b.x, y: b.y },
      p3: { x: b.x, y: b.y },
    });
  }
  return out;
}

export function transformSubPath(sp: SubPath, m: Matrix): SubPath {
  return {
    closed: sp.closed,
    points: sp.points.map((p): PathPoint => {
      const q = apply(m, p);
      const r: PathPoint = { x: q.x, y: q.y };
      if (p.in) r.in = applyVec(m, p.in.dx, p.in.dy);
      if (p.out) r.out = applyVec(m, p.out.dx, p.out.dy);
      return r;
    }),
  };
}

export function subpathsBBox(sps: SubPath[], into: BBox = emptyBBox()): BBox {
  for (const sp of sps) {
    if (sp.points.length === 1) growBBox(into, sp.points[0]);
    for (const c of segments(sp)) cubicBBox(c, into);
  }
  return into;
}

/** Alt yolları poligonlara düzleştir. Açık yollar da (kapatılmadan) döner. */
export function flattenSubPaths(sps: SubPath[], tol = 0.25): Polygon[] {
  const out: Polygon[] = [];
  for (const sp of sps) {
    if (sp.points.length === 0) continue;
    const poly: Point[] = [{ x: sp.points[0].x, y: sp.points[0].y }];
    for (const c of segments(sp)) flattenCubic(c, tol, poly);
    if (sp.closed && poly.length > 1) {
      const f = poly[0], l = poly[poly.length - 1];
      if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) poly.pop();
    }
    out.push(poly);
  }
  return out;
}

/** İşaretli alan (ekran koordinatında y aşağı; saat yönü pozitif). */
export function signedArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Nonzero sarım kuralıyla nokta-poligon testi (çoklu halka). */
export function windingNumber(polys: Polygon[], p: Point): number {
  let w = 0;
  for (const poly of polys) {
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
    }
  }
  return w;
}

export function crossingCount(polys: Polygon[], p: Point): number {
  let c = 0;
  for (const poly of polys)
    for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c++;
    }
  return c;
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Point, poly: Polygon, closed: boolean): number {
  let d = Infinity;
  const n = poly.length;
  if (n === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y);
  for (let i = 0; i < (closed ? n : n - 1); i++) d = Math.min(d, distToSegment(p, poly[i], poly[(i + 1) % n]));
  return d;
}
