import type { BBox, Frame, GroupNode, Matrix, Paint, PathNode, Style, SubPath, VNode } from '../common/types.js';
import { newId } from '../common/ids.js';
import { apply, identity, isIdentity, multiply } from '../math/matrix.js';
import { emptyBBox, isEmptyBBox, subpathsBBox, transformSubPath, flattenSubPaths } from '../math/bezier.js';
import { nodeBBox, nodeSubPaths } from '../math/geometry.js';
import { clipRegion, normalizeRegion, polygonsToSubPaths, totalArea } from '../model/boolean.js';

// İçe aktarılan (PDF/SVG) yapıyı, görüntüyü DEĞİŞTİRMEDEN, bir tasarımcının kuracağı sade hale getirir.
// Her geçiş görsel olarak eşdeğerdir; testler önce/sonra piksel karşılaştırmasıyla bunu doğrular.

export interface CleanupStats {
  nodesBefore: number; nodesAfter: number;
  mergedPaths: number; removedClips: number; absorbedClips: number; unwrappedGroups: number; removedEmpty: number;
}

const countNodes = (ns: VNode[]): number => ns.reduce((s, n) => s + 1 + (n.type === 'group' ? countNodes(n.children) : 0), 0);

const plainGroupStyle = (s: Style) => s.opacity === 1 && s.blendMode === 'normal' && s.filters.length === 0;

function styleKey(s: Style) { return JSON.stringify(s); }

/** Kırpma dikdörtgen mi? (4 köşe, eksen hizalı, handle yok) */
function clipRect(sps: SubPath[]): BBox | null {
  if (sps.length !== 1) return null;
  const p = sps[0].points.filter((q, i, a) => i === 0 || Math.abs(q.x - a[i - 1].x) > 1e-9 || Math.abs(q.y - a[i - 1].y) > 1e-9);
  if (p.length !== 4 || p.some((q) => q.in || q.out)) return null;
  const xs = new Set(p.map((q) => +q.x.toFixed(6))), ys = new Set(p.map((q) => +q.y.toFixed(6)));
  if (xs.size !== 2 || ys.size !== 2) return null;
  return subpathsBBox(sps);
}

const contains = (outer: BBox, inner: BBox, eps = 0.01) =>
  inner.minX >= outer.minX - eps && inner.minY >= outer.minY - eps && inner.maxX <= outer.maxX + eps && inner.maxY <= outer.maxY + eps;

function contentBBox(g: GroupNode): BBox {
  let b = emptyBBox();
  for (const c of g.children) {
    if (!c.visible) continue;
    const cb = nodeBBox(c, identity(), true);
    if (!isEmptyBBox(cb)) b = { minX: Math.min(b.minX, cb.minX), minY: Math.min(b.minY, cb.minY), maxX: Math.max(b.maxX, cb.maxX), maxY: Math.max(b.maxY, cb.maxY) };
  }
  return b;
}

/** Boyayı matrisle taşı (gradyan noktaları). Tekdüze olmayan ölçekte radyal gradyan taşınamaz → null. */
function transformPaint(p: Paint, m: Matrix): Paint | null {
  if (typeof p === 'string' || isIdentity(m)) return p;
  if (p.type === 'linear') {
    const a = apply(m, { x: p.x1, y: p.y1 }), b = apply(m, { x: p.x2, y: p.y2 });
    // Doğrusal gradyan afin dönüşümde yalnız eksen doğrultusunda korunur (skew/tekdüze olmayan ölçekte iso-çizgiler bozulur)
    const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d), orth = Math.abs(m.a * m.c + m.b * m.d) < 1e-6 * sx * sy;
    if (!orth || Math.abs(sx - sy) > 1e-6 * sx) return null;
    return { ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
  const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
  if (Math.abs(sx - sy) > 1e-6 * sx || Math.abs(m.a * m.c + m.b * m.d) > 1e-6 * sx * sy) return null;
  const c = apply(m, { x: p.cx, y: p.cy });
  const f = p.fx !== undefined || p.fy !== undefined ? apply(m, { x: p.fx ?? p.cx, y: p.fy ?? p.cy }) : null;
  return { ...p, cx: c.x, cy: c.y, r: p.r * sx, ...(f ? { fx: f.x, fy: f.y } : {}) };
}

/**
 * "Tek şekil + kırpma" kalıbını tek şekle indir: kırpılan içerik, kırpma alanını tamamen dolduran
 * konturları olmayan tek bir yapraksa, sonuç = kırpma geometrisi + yaprağın boyası.
 * (PDF'lerde "dikdörtgen gradyan + yuvarlak köşe kırpması" tam olarak budur.)
 */
function absorbClip(g: GroupNode): PathNode | null {
  if (!g.clip || g.children.length !== 1 || !plainGroupStyle(g.style)) return null;
  const leaf = g.children[0];
  if (leaf.type === 'group' || leaf.type === 'text' || leaf.type === 'image' || leaf.type === 'line' || !leaf.visible) return null;
  if (leaf.style.stroke !== 'none' || leaf.style.filters.length) return null;
  const fill = transformPaint(leaf.style.fill, leaf.transform);
  if (!fill) return null;
  // Yaprak kırpma alanını tamamen kaplıyor mu? alan(kırpma ∩ yaprak) ≈ alan(kırpma)
  const clipPolys = normalizeRegion({ polys: flattenSubPaths(g.clip.subpaths, 0.05), fillRule: g.clip.rule });
  const leafPolys = flattenSubPaths(nodeSubPaths(leaf).map((sp) => transformSubPath(sp, leaf.transform)), 0.05);
  const clipArea = totalArea(clipPolys);
  if (clipArea <= 0) return null;
  const inter = totalArea(clipRegion(clipPolys, { polys: leafPolys, fillRule: leaf.type === 'path' ? leaf.fillRule : 'nonzero' }));
  if (Math.abs(inter - clipArea) > Math.max(0.5, clipArea * 1e-4)) return null;
  return {
    type: 'path', id: leaf.id, name: leaf.name ?? g.name, transform: g.transform, visible: g.visible, locked: false,
    style: { ...leaf.style, fill }, subpaths: g.clip.subpaths, fillRule: g.clip.rule,
  };
}

/**
 * Kırpılmış tek dolgulu yaprak → gerçek kesişim şekli (boolean ∩ + eğri uydurma).
 * Yalnız konturu olmayan yapraklar: kırpılmış kontur tek dolgu şekliyle ifade edilemez.
 */
function intersectClip(g: GroupNode): PathNode | null {
  if (!g.clip || g.children.length !== 1 || !plainGroupStyle(g.style)) return null;
  const leaf = g.children[0];
  if (leaf.type === 'group' || leaf.type === 'text' || leaf.type === 'image' || leaf.type === 'line' || !leaf.visible) return null;
  if (leaf.style.stroke !== 'none' || leaf.style.filters.length) return null;
  const fill = transformPaint(leaf.style.fill, leaf.transform);
  if (!fill) return null;
  const leafPolys = flattenSubPaths(nodeSubPaths(leaf).map((sp) => transformSubPath(sp, leaf.transform)), 0.02);
  const region = clipRegion(normalizeRegion({ polys: leafPolys, fillRule: leaf.type === 'path' ? leaf.fillRule : 'nonzero' }),
    { polys: flattenSubPaths(g.clip.subpaths, 0.02), fillRule: g.clip.rule });
  if (!region.length) return null;
  return {
    type: 'path', id: leaf.id, name: leaf.name ?? g.name, transform: g.transform, visible: g.visible, locked: false,
    style: { ...leaf.style, fill }, subpaths: polygonsToSubPaths(region, true, 0.05), fillRule: 'evenodd',
  };
}

/** Grup içindeki basit path adayını (tek yapraklı, stilsiz sarmalayıcılar dahil) grup uzayında çıkar. */
function simplePath(n: VNode, m: Matrix = identity()): { node: PathNode; m: Matrix } | null {
  const mm = multiply(m, n.transform);
  if (n.type === 'path') return { node: n, m: mm };
  if (n.type === 'group' && !n.clip && !n.isLayer && n.children.length === 1 && plainGroupStyle(n.style) && n.visible) return simplePath(n.children[0], mm);
  return null;
}

/**
 * Aynı stil ve dolgu kuralına sahip, ÖRTÜŞMEYEN ardışık path'leri tek bileşik path'te birleştir.
 * Örtüşme kontrolü şart: nonzero'da ters yönlü, evenodd'da her örtüşme delik açardı.
 */
function mergeRuns(list: VNode[], stats: CleanupStats): VNode[] {
  const out: VNode[] = [];
  let run: { node: PathNode; m: Matrix; bb: BBox; src: VNode }[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0].src);
    else if (run.length > 1) {
      const first = run[0].node;
      out.push({
        type: 'path', id: newId('path'), name: first.name, transform: identity(), visible: true, locked: false,
        style: structuredClone(first.style), fillRule: first.fillRule,
        subpaths: run.flatMap((r) => r.node.subpaths.map((sp) => transformSubPath(sp, r.m))),
      });
      stats.mergedPaths += run.length - 1;
    }
    run = [];
  };
  for (const n of list) {
    const sp = n.visible ? simplePath(n) : null;
    // Gradyanlı path'ler yerel uzaya bağlıdır; yalnız dönüşümü birim olanlar birleşir
    if (!sp || (typeof sp.node.style.fill !== 'string' && !isIdentity(sp.m)) || (typeof sp.node.style.stroke !== 'string' && !isIdentity(sp.m))) { flush(); out.push(n); continue; }
    const bb = subpathsBBox(sp.node.subpaths.map((s) => transformSubPath(s, sp.m)));
    const key = styleKey(sp.node.style) + sp.node.fillRule;
    const same = run.length && styleKey(run[0].node.style) + run[0].node.fillRule === key;
    const overlaps = run.some((r) => r.bb.minX < bb.maxX && bb.minX < r.bb.maxX && r.bb.minY < bb.maxY && bb.minY < r.bb.maxY);
    if (!same || overlaps) flush();
    run.push({ node: sp.node, m: sp.m, bb, src: n });
  }
  flush();
  return out;
}

function clean(list: VNode[], stats: CleanupStats, depth: number): VNode[] {
  const result: VNode[] = [];
  for (let n of list) {
    if (n.type === 'group') {
      n.children = clean(n.children, stats, depth + 1);
      // Gereksiz kırpma: dikdörtgen kırpma içeriği zaten tamamen kapsıyorsa
      if (n.clip) {
        const r = clipRect(n.clip.subpaths);
        if (r && contains(r, contentBBox(n))) { delete n.clip; stats.removedClips++; }
      }
      if (n.clip) {
        const absorbed = absorbClip(n) ?? intersectClip(n);
        if (absorbed) { stats.absorbedClips++; result.push(absorbed); continue; }
      }
      if (!n.children.length) { stats.removedEmpty++; continue; }
      // Etkisiz sarmalayıcı grubu aç (katman değil, kırpma/stil yok): çocuklara dönüşümü devret
      if (!n.isLayer && !n.clip && plainGroupStyle(n.style) && n.visible && !n.name) {
        const g = n;
        for (const c of g.children) c.transform = multiply(g.transform, c.transform);
        result.push(...g.children);
        stats.unwrappedGroups++;
        continue;
      }
    } else if (!n.visible && depth > 0) { stats.removedEmpty++; continue; }
    else if (n.type === 'path' && !n.subpaths.some((s) => s.points.length > 1)) { stats.removedEmpty++; continue; }
    result.push(n);
  }
  return mergeRuns(result, stats);
}

/** Frame içeriğini sadeleştir (görsel eşdeğerlik korunur). */
export function cleanupFrame(frame: Frame): CleanupStats {
  const stats: CleanupStats = { nodesBefore: countNodes(frame.nodes), nodesAfter: 0, mergedPaths: 0, removedClips: 0, absorbedClips: 0, unwrappedGroups: 0, removedEmpty: 0 };
  // Sayfayı tamamen kaplayan ilk düz renkli dikdörtgen/path → frame arka planı
  frame.nodes = clean(frame.nodes, stats, 0);
  const first = frame.nodes[0];
  if (first && first.type !== 'group' && first.type !== 'image' && first.type !== 'text' && typeof first.style.fill === 'string' && first.style.fill !== 'none'
      && first.style.stroke === 'none' && first.style.opacity === 1 && (first.style.fillOpacity ?? 1) === 1 && first.style.filters.length === 0) {
    const b = nodeBBox(first);
    const r = first.type === 'rect' || (first.type === 'path' && clipRect(first.subpaths.map((s) => transformSubPath(s, first.transform))));
    if (r && b.minX <= 0.01 && b.minY <= 0.01 && b.maxX >= frame.w - 0.01 && b.maxY >= frame.h - 0.01 && first.transform.b === 0 && first.transform.c === 0) {
      frame.background = first.style.fill;
      frame.nodes.shift();
    }
  }
  stats.nodesAfter = countNodes(frame.nodes);
  return stats;
}


