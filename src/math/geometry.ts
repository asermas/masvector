import type { BBox, Matrix, PathPoint, SubPath, TextNode, VNode } from '../common/types.js';
import { emptyBBox, flattenSubPaths, growBBox, isEmptyBBox, subpathsBBox, transformSubPath, unionBBox } from './bezier.js';
import { multiply, meanScale } from './matrix.js';

/** Dörtte bir elips yayı için kübik kontrol çarpanı. */
export const KAPPA = 0.5522847498307936;

export function ellipseSubPath(cx: number, cy: number, rx: number, ry: number): SubPath {
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return {
    closed: true,
    points: [
      { x: cx + rx, y: cy, in: { dx: 0, dy: -ky }, out: { dx: 0, dy: ky } },
      { x: cx, y: cy + ry, in: { dx: kx, dy: 0 }, out: { dx: -kx, dy: 0 } },
      { x: cx - rx, y: cy, in: { dx: 0, dy: ky }, out: { dx: 0, dy: -ky } },
      { x: cx, y: cy - ry, in: { dx: -kx, dy: 0 }, out: { dx: kx, dy: 0 } },
    ],
  };
}

export function rectSubPath(x: number, y: number, w: number, h: number, rx = 0, ry = rx): SubPath {
  rx = Math.max(0, Math.min(rx, w / 2));
  ry = Math.max(0, Math.min(ry || rx, h / 2));
  if (rx === 0 || ry === 0) {
    return { closed: true, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] };
  }
  const kx = rx * KAPPA, ky = ry * KAPPA;
  const pts: PathPoint[] = [
    { x: x + rx, y, in: { dx: -kx, dy: 0 } },
    { x: x + w - rx, y, out: { dx: kx, dy: 0 } },
    { x: x + w, y: y + ry, in: { dx: 0, dy: -ky } },
    { x: x + w, y: y + h - ry, out: { dx: 0, dy: ky } },
    { x: x + w - rx, y: y + h, in: { dx: kx, dy: 0 } },
    { x: x + rx, y: y + h, out: { dx: -kx, dy: 0 } },
    { x, y: y + h - ry, in: { dx: 0, dy: ky } },
    { x, y: y + ry, out: { dx: 0, dy: -ky } },
  ];
  return { closed: true, points: pts };
}

/** Metin genişliği tahmini (headless ortamda font ölçümü olmadan tutarlı sonuç için). */
export function estimateTextWidth(t: Pick<TextNode, 'content' | 'fontSize'>): number {
  let w = 0;
  for (const ch of t.content) {
    if (' .,:;!|il\'"'.includes(ch)) w += 0.3;
    else if ('mwMW@'.includes(ch)) w += 0.85;
    else if (ch >= 'A' && ch <= 'Z') w += 0.66;
    else w += 0.55;
  }
  return w * t.fontSize;
}

export function textBox(t: TextNode): { x: number; y: number; w: number; h: number } {
  const w = estimateTextWidth(t);
  const x = t.textAnchor === 'middle' ? t.x - w / 2 : t.textAnchor === 'end' ? t.x - w : t.x;
  // y = taban çizgisi; yükselen ~0.8em, inen ~0.2em
  return { x, y: t.y - t.fontSize * 0.8, w, h: t.fontSize };
}

/** Grup dışındaki node'ların yerel geometrisi kübik alt yollar olarak. */
export function nodeSubPaths(n: VNode): SubPath[] {
  switch (n.type) {
    case 'path': return n.subpaths;
    case 'rect': return [rectSubPath(n.x, n.y, n.width, n.height, n.rx ?? 0, n.ry ?? n.rx ?? 0)];
    case 'ellipse': return [ellipseSubPath(n.x + n.width / 2, n.y + n.height / 2, n.width / 2, n.height / 2)];
    case 'line': return [{ closed: false, points: [{ x: n.x1, y: n.y1 }, { x: n.x2, y: n.y2 }] }];
    case 'text': { const b = textBox(n); return [rectSubPath(b.x, b.y, b.w, b.h)]; }
    case 'group': return [];
  }
}

/** Node'un (ve alt ağacının) `parent` koordinat sistemindeki sınır kutusu. */
export function nodeBBox(n: VNode, parent: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, withStroke = false): BBox {
  const m = multiply(parent, n.transform);
  if (n.type === 'group') {
    let b = emptyBBox();
    for (const ch of n.children) {
      if (!ch.visible) continue;
      const cb = nodeBBox(ch, m, withStroke);
      if (!isEmptyBBox(cb)) b = unionBBox(b, cb);
    }
    return b;
  }
  const b = subpathsBBox(nodeSubPaths(n).map((sp) => transformSubPath(sp, m)));
  if (withStroke && n.style.stroke !== 'none' && n.style.strokeWidth > 0 && !isEmptyBBox(b)) {
    const h = (n.style.strokeWidth * meanScale(m)) / 2;
    b.minX -= h; b.minY -= h; b.maxX += h; b.maxY += h;
  }
  return b;
}

/** Node'u verilen matrisle dünya-uzayı poligonlarına düzleştir (grup → tüm yapraklar). */
export function nodePolygons(n: VNode, parent: Matrix, tol = 0.1): { polys: { x: number; y: number }[][]; closed: boolean[] } {
  const m = multiply(parent, n.transform);
  if (n.type === 'group') {
    const polys: { x: number; y: number }[][] = [], closed: boolean[] = [];
    for (const ch of n.children) {
      if (!ch.visible) continue;
      const r = nodePolygons(ch, m, tol);
      polys.push(...r.polys); closed.push(...r.closed);
    }
    return { polys, closed };
  }
  const sps = nodeSubPaths(n).map((sp) => transformSubPath(sp, m));
  return { polys: flattenSubPaths(sps, tol), closed: sps.map((s) => s.closed) };
}

export function bboxCenter(b: BBox) { return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; }
export function bboxToRect(b: BBox) { return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY }; }
export function bboxIntersects(a: BBox, b: BBox) { return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY; }
export { growBBox };
