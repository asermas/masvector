import type { PathPoint, SubPath } from '../common/types.js';
import { invalid } from '../common/errors.js';

/** SVG `d` sözdizimini tokenlara ayır. */
function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) out.push(m[1] ?? Number(m[2]));
  return out;
}

/** Eliptik yay → kübik Bézier parçaları (SVG uygulama notları F.6). */
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, phiDeg: number, fa: number, fs: number, x2: number, y2: number,
): [number, number, number, number, number, number][] {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  else if (fs && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const delta = dt / segs;
  const k = (4 / 3) * Math.tan(delta / 4);
  const out: [number, number, number, number, number, number][] = [];
  const pt = (t: number) => {
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
  };
  const der = (t: number) => {
    const ex = -rx * Math.sin(t), ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  let t = t1;
  for (let i = 0; i < segs; i++) {
    const [ax, ay] = pt(t), [adx, ady] = der(t);
    const t2 = t + delta;
    const [bx, by] = pt(t2), [bdx, bdy] = der(t2);
    out.push([ax + k * adx, ay + k * ady, bx - k * bdx, by - k * bdy, bx, by]);
    t = t2;
  }
  // Son noktayı tam hedefe sabitle (yuvarlama birikimini önle)
  const last = out[out.length - 1];
  last[4] = x2; last[5] = y2;
  return out;
}

/** SVG path verisini düzenlenebilir çapa+handle yapısına çevir. Q/T/A kübiğe yükseltilir. */
export function parsePathData(d: string): SubPath[] {
  const tk = tokenize(d);
  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: { x: number; y: number; kind: 'C' | 'Q' } | null = null;
  let i = 0, cmd = '';
  const num = () => {
    const v = tk[i++];
    if (typeof v !== 'number') throw invalid(`Path verisi bozuk: sayı bekleniyordu (${String(v)})`);
    return v;
  };
  const lastPt = (): PathPoint => cur!.points[cur!.points.length - 1];
  const ensure = () => {
    if (!cur) { cur = { closed: false, points: [{ x, y }] }; subs.push(cur); }
  };
  const cubicTo = (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => {
    ensure();
    const lp = lastPt();
    if (c1x !== lp.x || c1y !== lp.y) lp.out = { dx: c1x - lp.x, dy: c1y - lp.y };
    const np: PathPoint = { x: ex, y: ey };
    if (c2x !== ex || c2y !== ey) np.in = { dx: c2x - ex, dy: c2y - ey };
    cur!.points.push(np);
    x = ex; y = ey;
  };
  const lineTo = (ex: number, ey: number) => { ensure(); cur!.points.push({ x: ex, y: ey }); x = ex; y = ey; };

  while (i < tk.length) {
    if (typeof tk[i] === 'string') cmd = tk[i++] as string;
    else if (!cmd) throw invalid('Path verisi komutla başlamalı');
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case 'M': {
        const nx = num() + ox, ny = num() + oy;
        cur = { closed: false, points: [{ x: nx, y: ny }] };
        subs.push(cur);
        x = sx = nx; y = sy = ny;
        cmd = rel ? 'l' : 'L'; // sonraki çiftler örtük lineto
        lastCtrl = null;
        break;
      }
      case 'L': lineTo(num() + ox, num() + oy); lastCtrl = null; break;
      case 'H': lineTo(num() + ox, y); lastCtrl = null; break;
      case 'V': lineTo(x, num() + oy); lastCtrl = null; break;
      case 'C': {
        const a = num() + ox, b = num() + oy, c = num() + ox, e = num() + oy, f = num() + ox, g = num() + oy;
        cubicTo(a, b, c, e, f, g); lastCtrl = { x: c, y: e, kind: 'C' }; break;
      }
      case 'S': {
        const c1x = lastCtrl?.kind === 'C' ? 2 * x - lastCtrl.x : x, c1y = lastCtrl?.kind === 'C' ? 2 * y - lastCtrl.y : y;
        const c = num() + ox, e = num() + oy, f = num() + ox, g = num() + oy;
        cubicTo(c1x, c1y, c, e, f, g); lastCtrl = { x: c, y: e, kind: 'C' }; break;
      }
      case 'Q': case 'T': {
        let qx: number, qy: number;
        if (C === 'Q') { qx = num() + ox; qy = num() + oy; }
        else { qx = lastCtrl?.kind === 'Q' ? 2 * x - lastCtrl.x : x; qy = lastCtrl?.kind === 'Q' ? 2 * y - lastCtrl.y : y; }
        const ex = num() + ox, ey = num() + oy;
        cubicTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        lastCtrl = { x: qx, y: qy, kind: 'Q' }; break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), fa = num(), fs = num(), ex = num() + ox, ey = num() + oy;
        for (const s of arcToCubics(x, y, rx, ry, rot, fa, fs, ex, ey)) cubicTo(...s);
        lastCtrl = null; break;
      }
      case 'Z': {
        if (cur) {
          cur.closed = true;
          // Son nokta başlangıçla çakışıyorsa birleştir (in-handle'ı taşı)
          const pts = cur.points;
          if (pts.length > 1) {
            const l = pts[pts.length - 1], f = pts[0];
            if (Math.abs(l.x - f.x) < 1e-9 && Math.abs(l.y - f.y) < 1e-9) {
              if (l.in) f.in = l.in;
              pts.pop();
            }
          }
        }
        x = sx; y = sy; cur = null; lastCtrl = null;
        // Z'den sonra komutsuz sayı gelmez; yeni alt yol M ister ama tolerans: sonraki çizim yeni alt yol açar
        break;
      }
      default: throw invalid(`Desteklenmeyen path komutu: ${cmd}`);
    }
  }
  return subs.filter((s) => s.points.length > 0);
}

const f = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Çapa+handle yapısını kompakt SVG path verisine yaz (handle yoksa L, varsa C). */
export function toPathData(sps: SubPath[]): string {
  const parts: string[] = [];
  for (const sp of sps) {
    const pts = sp.points;
    if (!pts.length) continue;
    parts.push(`M${f(pts[0].x)} ${f(pts[0].y)}`);
    const n = pts.length;
    const count = sp.closed ? n : n - 1;
    for (let k = 0; k < count; k++) {
      const a = pts[k], b = pts[(k + 1) % n];
      const closingLine = sp.closed && k === n - 1 && !a.out && !b.in;
      if (closingLine) break; // Z zaten düz kapatır
      if (!a.out && !b.in) parts.push(`L${f(b.x)} ${f(b.y)}`);
      else {
        const c1x = a.x + (a.out?.dx ?? 0), c1y = a.y + (a.out?.dy ?? 0);
        const c2x = b.x + (b.in?.dx ?? 0), c2y = b.y + (b.in?.dy ?? 0);
        parts.push(`C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(b.x)} ${f(b.y)}`);
      }
    }
    if (sp.closed) parts.push('Z');
  }
  return parts.join('');
}
