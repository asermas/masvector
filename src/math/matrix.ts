import type { Matrix, Point } from '../common/types.js';

export const identity = (): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** m1 · m2 — önce m2, sonra m1 uygulanır. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function invert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) throw new Error('Matris tersinir değil (det≈0)');
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export const translate = (tx: number, ty: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });
export const scale = (sx: number, sy = sx): Matrix => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
export function rotate(deg: number): Matrix {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}
export function skew(degX: number, degY: number): Matrix {
  return { a: 1, b: Math.tan((degY * Math.PI) / 180), c: Math.tan((degX * Math.PI) / 180), d: 1, e: 0, f: 0 };
}

/** Bir dönüşümü (cx,cy) merkezli uygula: T(c)·m·T(-c). */
export const around = (m: Matrix, cx: number, cy: number): Matrix =>
  multiply(translate(cx, cy), multiply(m, translate(-cx, -cy)));

export const apply = (m: Matrix, p: Point): Point => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
/** Vektör dönüşümü (öteleme yok) — Bézier handle'ları için. */
export const applyVec = (m: Matrix, dx: number, dy: number) => ({ dx: m.a * dx + m.c * dy, dy: m.b * dx + m.d * dy });

export const isIdentity = (m: Matrix, eps = 1e-9) =>
  Math.abs(m.a - 1) < eps && Math.abs(m.b) < eps && Math.abs(m.c) < eps &&
  Math.abs(m.d - 1) < eps && Math.abs(m.e) < eps && Math.abs(m.f) < eps;

/** Ortalama ölçek (kontur kalınlığı/tolerans için). */
export const meanScale = (m: Matrix) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;

const fmt = (n: number) => +n.toFixed(6);
export function toSvgTransform(m: Matrix): string {
  if (isIdentity(m)) return '';
  if (Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.d - 1) < 1e-9)
    return `translate(${fmt(m.e)} ${fmt(m.f)})`;
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(fmt).join(' ')})`;
}

/** SVG `transform` özniteliğini ayrıştır (matrix/translate/scale/rotate/skewX/skewY, zincirli). */
export function parseSvgTransform(src: string | null | undefined): Matrix {
  let m = identity();
  if (!src) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t: Matrix;
    switch (match[1]) {
      case 'matrix': t = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] }; break;
      case 'translate': t = translate(args[0] ?? 0, args[1] ?? 0); break;
      case 'scale': t = scale(args[0] ?? 1, args[1] ?? args[0] ?? 1); break;
      case 'rotate': t = args.length >= 3 ? around(rotate(args[0]), args[1], args[2]) : rotate(args[0] ?? 0); break;
      case 'skewX': t = skew(args[0] ?? 0, 0); break;
      default: t = skew(0, args[0] ?? 0);
    }
    m = multiply(m, t);
  }
  return m;
}
