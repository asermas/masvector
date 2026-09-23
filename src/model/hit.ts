import type { BBox, Frame, Point } from '../common/types.js';
import { crossingCount, distToPolyline, windingNumber } from '../math/bezier.js';
import { bboxIntersects, nodeBBox, nodePolygons } from '../math/geometry.js';
import { ancestorsMatrix, walk } from './scene.js';

/**
 * Frame uzayında noktadaki node'lar (üstten alta). Salt okunur geometri sorgusu —
 * hem Document Server (query_hit) hem UI (seçim) aynı fonksiyonu kullanır.
 * Katmanların doğrudan çocukları seçilir; iç içe gruplar `deep` değilse grup olarak döner.
 */
export function hitTest(frame: Frame, p: Point, tol = 3, deep = false): string[] {
  const hits: string[] = [];
  for (const w of walk(frame.nodes)) {
    const n = w.node;
    if (n.type === 'group' || !n.visible || w.ancestors.some((g) => !g.visible)) continue;
    const { polys, closed } = nodePolygons(n, ancestorsMatrix(w.ancestors));
    const closedPolys = polys.filter((_, i) => closed[i]);
    const filled = n.type === 'text' || (n.type !== 'line' && n.style.fill !== 'none');
    const even = n.type === 'path' && n.fillRule === 'evenodd';
    const inside = filled && closedPolys.length > 0 &&
      (even ? crossingCount(closedPolys, p) % 2 === 1 : windingNumber(closedPolys, p) !== 0);
    const sw = n.style.stroke !== 'none' ? n.style.strokeWidth / 2 : 0;
    const near = !inside && polys.some((poly, i) => distToPolyline(p, poly, closed[i]) <= sw + tol);
    if (!inside && !near) continue;
    if (deep) { hits.push(n.id); continue; }
    // Seçilebilir en üst ata: katman değilse en dıştaki grup
    const selectable = w.ancestors.find((g) => !g.isLayer);
    hits.push(selectable ? selectable.id : n.id);
  }
  return [...new Set(hits.reverse())];
}

/** Dikdörtgen seçim: bbox'ı tamamen kutu içinde kalan seçilebilir node'lar. */
export function marqueeSelect(frame: Frame, box: BBox): string[] {
  const out: string[] = [];
  const consider = frame.nodes.flatMap((n) => (n.type === 'group' && n.isLayer ? (n.visible && !n.locked ? n.children.map((c) => ({ c, anc: [n] })) : []) : [{ c: n, anc: [] }]));
  for (const { c, anc } of consider) {
    if (!c.visible || c.locked) continue;
    const b = nodeBBox(c, ancestorsMatrix(anc));
    if (b.minX >= box.minX && b.maxX <= box.maxX && b.minY >= box.minY && b.maxY <= box.maxY && bboxIntersects(b, box)) out.push(c.id);
  }
  return out;
}
