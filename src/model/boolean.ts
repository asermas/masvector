import ClipperLib from 'clipper-lib';
import type { Polygon, SubPath } from '../common/types.js';
import { VectorError } from '../common/errors.js';
import { signedArea } from '../math/bezier.js';

/** Clipper tamsayı çalışır; 1/1000 birim hassasiyet. */
const SCALE = 1000;

type IntPath = { X: number; Y: number }[];
export type BoolOp = 'union' | 'subtract' | 'intersect' | 'exclude';
export type FillRule = 'nonzero' | 'evenodd';

const toInt = (polys: Polygon[]): IntPath[] =>
  polys.filter((p) => p.length >= 3).map((p) => p.map((q) => ({ X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) })));
const fromInt = (paths: IntPath[]): Polygon[] => paths.map((p) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE })));
const pft = (r: FillRule) => (r === 'evenodd' ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero);

function exec(clipType: number, subj: IntPath[], clip: IntPath[], subjFill: number, clipFill: number): IntPath[] {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const sol: IntPath[] = new ClipperLib.Paths();
  c.Execute(clipType, sol, subjFill, clipFill);
  return sol;
}

/** Tek bir operandın dolgu kuralını çözüp örtüşmesiz dış+delik halkalarına çevir. */
function normalize(polys: Polygon[], rule: FillRule): IntPath[] {
  return exec(ClipperLib.ClipType.ctUnion, toInt(polys), [], pft(rule), pft(rule));
}

export interface Operand { polys: Polygon[]; fillRule: FillRule }

/**
 * Çok operandlı boolean. Sıra önemlidir:
 * - union: hepsinin birleşimi
 * - subtract: ilk operand − (geri kalanların birleşimi)
 * - intersect: hepsinin ortak alanı
 * - exclude: ardışık XOR
 */
export function booleanPolygons(op: BoolOp, operands: Operand[]): Polygon[] {
  if (operands.length < 2) throw new VectorError('INVALID_ARGUMENT', 'Boolean en az 2 operand ister');
  const norm = operands.map((o) => normalize(o.polys, o.fillRule));
  const NZ = ClipperLib.PolyFillType.pftNonZero;
  const CT = ClipperLib.ClipType;
  let res: IntPath[];
  switch (op) {
    case 'union':
      res = exec(CT.ctUnion, norm.flat(), [], NZ, NZ);
      break;
    case 'subtract':
      res = exec(CT.ctDifference, norm[0], norm.slice(1).flat(), NZ, NZ);
      break;
    case 'intersect':
      res = norm[0];
      for (const n of norm.slice(1)) res = exec(CT.ctIntersection, res, n, NZ, NZ);
      break;
    case 'exclude':
      res = norm[0];
      for (const n of norm.slice(1)) res = exec(CT.ctXor, res, n, NZ, NZ);
      break;
  }
  res = ClipperLib.Clipper.CleanPolygons(res, 0.5) as IntPath[];
  return fromInt(res.filter((p) => p.length >= 3));
}

export type JoinType = 'miter' | 'round' | 'square';

/** Kapalı şekli `delta` kadar büyüt (+) / küçült (−). */
export function offsetPolygons(polys: Polygon[], rule: FillRule, delta: number, join: JoinType = 'round', miterLimit = 4): Polygon[] {
  const co = new ClipperLib.ClipperOffset(miterLimit, 0.05 * SCALE);
  co.AddPaths(normalize(polys, rule), joinType(join), ClipperLib.EndType.etClosedPolygon);
  const sol: IntPath[] = new ClipperLib.Paths();
  co.Execute(sol, delta * SCALE);
  return fromInt(ClipperLib.Clipper.CleanPolygons(sol, 0.5) as IntPath[]);
}

/** Konturu dolgu şekline çevir (açık yollar uç tipine göre, kapalılar halka olarak). */
export function strokeToPolygons(
  polys: Polygon[], closed: boolean[], width: number,
  join: JoinType = 'miter', cap: 'butt' | 'round' | 'square' = 'butt', miterLimit = 4,
): Polygon[] {
  const co = new ClipperLib.ClipperOffset(miterLimit, 0.05 * SCALE);
  polys.forEach((p, i) => {
    if (p.length < 2) return;
    const ip = p.map((q) => ({ X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) }));
    const end = closed[i]
      ? ClipperLib.EndType.etClosedLine
      : cap === 'round' ? ClipperLib.EndType.etOpenRound : cap === 'square' ? ClipperLib.EndType.etOpenSquare : ClipperLib.EndType.etOpenButt;
    co.AddPath(ip, joinType(join), end);
  });
  const sol: IntPath[] = new ClipperLib.Paths();
  co.Execute(sol, (width / 2) * SCALE);
  return fromInt(sol);
}

function joinType(j: JoinType) {
  return j === 'round' ? ClipperLib.JoinType.jtRound : j === 'square' ? ClipperLib.JoinType.jtSquare : ClipperLib.JoinType.jtMiter;
}

export function polygonsToSubPaths(polys: Polygon[]): SubPath[] {
  return polys.map((p) => ({ closed: true, points: p.map((q) => ({ x: +q.x.toFixed(3), y: +q.y.toFixed(3) })) }));
}

/** Dolgu alanı (delikler düşülmüş). Clipper çıktısında delikler ters yönlüdür. */
export function totalArea(polys: Polygon[]): number {
  return Math.abs(polys.reduce((s, p) => s + signedArea(p), 0));
}

/** İki şeklin gerçekten örtüşüp örtüşmediği ve ortak alan. */
export function intersectionArea(a: Operand, b: Operand): number {
  const r = exec(ClipperLib.ClipType.ctIntersection, normalize(a.polys, a.fillRule), normalize(b.polys, b.fillRule),
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return totalArea(fromInt(r));
}
