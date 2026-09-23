import type {
  BBox, GroupNode, Matrix, PathNode, PathPoint, Style, SubPath, VDocument, VNode,
} from '../common/types.js';
import { defaultStyle, newId } from '../common/ids.js';
import { VectorError, invalid, notFound } from '../common/errors.js';
import { around, apply, applyVec, identity, invert, multiply, parseSvgTransform, rotate, scale, skew, translate } from '../math/matrix.js';
import { emptyBBox, isEmptyBBox, unionBBox } from '../math/bezier.js';
import { bboxCenter, clipPolygons, nodeBBox, nodePolygons, nodeSubPaths } from '../math/geometry.js';
import { flattenSubPaths, transformSubPath } from '../math/bezier.js';
import { fitClosedPolygon, fitOpenPolyline } from '../math/fit.js';
import { parsePathData } from '../serialization/path-data.js';
import {
  ancestorsMatrix, cloneWithNewIds, containerChildren, findFrame, findPage, isEffectivelyLocked, locate, mustLocate, walk,
  type Located, createFrame,
} from './scene.js';
import { booleanPolygons, clipRegion, normalizeRegion, offsetPolygons, polygonsToSubPaths, strokeToPolygons, type BoolOp, type Operand } from './boolean.js';
import { OP_SCHEMAS, type OpArgs, type OpName } from './schemas.js';

// ————————————————————————————————— yardımcılar

type R = Record<string, unknown>;

export function frameBBox(l: Located, withStroke = false): BBox {
  return nodeBBox(l.node, ancestorsMatrix(l.ancestors), withStroke);
}

export function summarize(doc: VDocument, id: string) {
  const l = mustLocate(doc, id);
  const b = frameBBox(l);
  return {
    id, type: l.node.type, name: l.node.name,
    bbox: isEmptyBBox(b) ? null : { x: r3(b.minX), y: r3(b.minY), width: r3(b.maxX - b.minX), height: r3(b.maxY - b.minY) },
  };
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function editable(doc: VDocument, id: string): Located {
  const l = mustLocate(doc, id);
  if (isEffectivelyLocked(l)) throw new VectorError('NODE_LOCKED', `Node "${id}" (veya bir atası) kilitli`);
  return l;
}

function toMatrix(t: Matrix | string | undefined): Matrix {
  if (!t) return identity();
  return typeof t === 'string' ? parseSvgTransform(t) : { ...t };
}

function mkStyle(partial: Partial<Style> | undefined, base: Partial<Style>): Style {
  const s = defaultStyle(base);
  if (partial) for (const [k, v] of Object.entries(partial)) if (v !== undefined) (s as any)[k] = v;
  return s;
}

/** Varsayılan hedef: ilk frame'in en üstteki açık+kilitsiz katmanı; katman yoksa frame kökü. */
function resolveContainer(doc: VDocument, parentId?: string) {
  if (parentId) {
    const c = containerChildren(doc, parentId);
    if (c.group && (c.group.locked || c.ancestors.some((a) => a.locked))) throw new VectorError('NODE_LOCKED', `Kapsayıcı "${parentId}" kilitli`);
    return c;
  }
  const { frame } = findFrame(doc);
  const layers = frame.nodes.filter((n): n is GroupNode => n.type === 'group' && !!n.isLayer);
  const active = [...layers].reverse().find((l) => l.visible && !l.locked);
  if (active) return { list: active.children, frame, group: active, ancestors: [active] };
  return { list: frame.nodes, frame, group: null as GroupNode | null, ancestors: [] as GroupNode[] };
}

function insertAt<T>(list: T[], item: T, index?: number) {
  if (index === undefined || index >= list.length) list.push(item);
  else list.splice(index, 0, item);
}

function base(type: VNode['type'], a: { name?: string; transform?: Matrix | string }, style: Style) {
  return { id: newId(type), name: a.name, transform: toMatrix(a.transform), style, visible: true, locked: false };
}

function addNode(doc: VDocument, node: VNode, parentId?: string, index?: number) {
  const c = resolveContainer(doc, parentId);
  insertAt(c.list, node, index);
  return summarize(doc, node.id);
}

/** Node'u başka bir ata zincirine taşırken görsel konumunu koru. */
function reparentTransform(n: VNode, from: GroupNode[], to: GroupNode[]) {
  n.transform = multiply(invert(ancestorsMatrix(to)), multiply(ancestorsMatrix(from), n.transform));
}

function detach(l: Located) {
  const i = l.siblings.indexOf(l.node);
  if (i >= 0) l.siblings.splice(i, 1);
}

/** Frame-uzayı vektörünü node'un ebeveyn uzayına çevir. */
function frameVecToParent(l: Located, dx: number, dy: number) {
  const inv = invert(ancestorsMatrix(l.ancestors));
  const v = applyVec(inv, dx, dy);
  return { dx: v.dx, dy: v.dy };
}

function translateNode(l: Located, dx: number, dy: number) {
  const v = frameVecToParent(l, dx, dy);
  l.node.transform = multiply(translate(v.dx, v.dy), l.node.transform);
}

function unionOf(doc: VDocument, ids: string[]): BBox {
  let b = emptyBBox();
  for (const id of ids) { const nb = frameBBox(mustLocate(doc, id)); if (!isEmptyBBox(nb)) b = unionBBox(b, nb); }
  if (isEmptyBBox(b)) throw invalid('Seçimin görünür geometrisi yok');
  return b;
}

/** Stil taşıyan ilk yaprak (grup operandlar için boolean sonucu stili). */
function firstLeafStyle(n: VNode): Style {
  if (n.type !== 'group') return structuredClone(n.style);
  for (const w of walk(n.children)) if (w.node.type !== 'group') return structuredClone(w.node.style);
  return defaultStyle();
}

/** Node'un frame uzayındaki dolu bölgesi (dolgu kuralı çözülmüş; grup kırpmaları uygulanmış). */
function regionOf(n: VNode, parent: Matrix, owner: string): { x: number; y: number }[][] {
  if (n.type === 'text') throw new VectorError('UNSUPPORTED', `"${owner}" metin içeriyor; boolean için metin desteklenmez (önce metni silin veya ayırın)`);
  if (n.type === 'image') throw new VectorError('UNSUPPORTED', `"${owner}" raster görsel içeriyor; boolean için görsel desteklenmez`);
  const m = multiply(parent, n.transform);
  if (n.type === 'group') {
    let region: { x: number; y: number }[][] = [];
    for (const ch of n.children) if (ch.visible) region.push(...regionOf(ch, m, owner));
    if (region.length) region = normalizeRegion({ polys: region, fillRule: 'nonzero' });
    const cp = clipPolygons(n, m);
    return cp ? clipRegion(region, { polys: cp, fillRule: n.clip!.rule }) : region;
  }
  const { polys, closed } = nodePolygons({ ...n, transform: identity() } as VNode, m);
  const closedPolys = polys.filter((_, i) => closed[i]);
  if (!closedPolys.length) return [];
  return normalizeRegion({ polys: closedPolys, fillRule: n.type === 'path' ? n.fillRule : 'nonzero' });
}

function operandOf(l: Located): Operand {
  const polys = regionOf(l.node, ancestorsMatrix(l.ancestors), l.node.id);
  if (!polys.length) throw new VectorError('UNSUPPORTED', `"${l.node.id}" kapalı alan içermiyor (açık yol/çizgi). Önce path_outline_stroke kullanın.`);
  return { polys, fillRule: 'nonzero' };
}

/** Frame-uzayı poligonlarından `target`ın ebeveyn uzayında path node üret. */
function pathFromFramePolys(polys: { x: number; y: number }[][], target: Located, style: Style, name?: string): PathNode {
  const inv = invert(ancestorsMatrix(target.ancestors));
  const local = polys.map((p) => p.map((q) => apply(inv, q)));
  return {
    type: 'path', id: newId('path'), name, transform: identity(), style, visible: true, locked: false,
    subpaths: polygonsToSubPaths(local), fillRule: 'evenodd',
  };
}

function runBoolean(doc: VDocument, op: BoolOp, ids: string[], keep = false) {
  const locs = ids.map((id) => editable(doc, id));
  const res = booleanPolygons(op, locs.map(operandOf));
  if (!res.length) throw invalid(`${op} sonucu boş (şekiller örtüşmüyor olabilir); belge değiştirilmedi`);
  const first = locs[0];
  const node = pathFromFramePolys(res, first, firstLeafStyle(first.node), first.node.name ? `${first.node.name} (${op})` : undefined);
  const at = first.siblings.indexOf(first.node);
  insertAt(first.siblings, node, at + 1);
  if (!keep) for (const l of locs) detach(mustLocate(doc, l.node.id));
  return { ...summarize(doc, node.id), removed: keep ? [] : ids };
}

function mustPath(l: Located): PathNode {
  if (l.node.type !== 'path') throw invalid(`"${l.node.id}" bir path değil (${l.node.type}); önce node_to_path kullanın`);
  return l.node;
}

// ————————————————————————————————— operasyonlar

type Handler<K extends OpName> = (doc: VDocument, a: OpArgs<K>) => unknown;

const handlers: { [K in OpName]: Handler<K> } = {
  node_add_path(doc, a) {
    let subpaths: SubPath[];
    if (a.d) subpaths = parsePathData(a.d);
    else if (a.subpaths) subpaths = structuredClone(a.subpaths) as SubPath[];
    else throw invalid('node_add_path: `d` veya `subpaths` gerekli');
    if (!subpaths.length) throw invalid('Path boş');
    const allOpen = subpaths.every((s) => !s.closed);
    const style = mkStyle(a.style as Partial<Style>, allOpen ? { fill: 'none', stroke: '#000000' } : {});
    const n: PathNode = { type: 'path', ...base('path', a, style), subpaths, fillRule: a.fillRule ?? 'nonzero' };
    return addNode(doc, n, a.parentId, a.index);
  },
  node_add_rect(doc, a) {
    const n: VNode = { type: 'rect', ...base('rect', a, mkStyle(a.style as Partial<Style>, {})), x: a.x, y: a.y, width: a.width, height: a.height, rx: a.rx, ry: a.ry };
    return addNode(doc, n, a.parentId, a.index);
  },
  node_add_ellipse(doc, a) {
    const n: VNode = { type: 'ellipse', ...base('ellipse', a, mkStyle(a.style as Partial<Style>, {})), x: a.x, y: a.y, width: a.width, height: a.height };
    return addNode(doc, n, a.parentId, a.index);
  },
  node_add_line(doc, a) {
    const n: VNode = { type: 'line', ...base('line', a, mkStyle(a.style as Partial<Style>, { fill: 'none', stroke: '#000000' })), x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
    return addNode(doc, n, a.parentId, a.index);
  },
  node_add_text(doc, a) {
    const n: VNode = {
      type: 'text', ...base('text', a, mkStyle(a.style as Partial<Style>, {})),
      x: a.x, y: a.y, content: a.content, fontSize: a.fontSize ?? 16, fontFamily: a.fontFamily ?? 'Inter, Helvetica, Arial, sans-serif',
      fontWeight: a.fontWeight, textAnchor: a.textAnchor,
    };
    return addNode(doc, n, a.parentId, a.index);
  },

  node_update(doc, a) {
    const l = editable(doc, a.id);
    const n = l.node as any;
    const allowed: Record<VNode['type'], string[]> = {
      path: ['d', 'subpaths', 'fillRule'],
      rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
      ellipse: ['x', 'y', 'width', 'height'],
      line: ['x1', 'y1', 'x2', 'y2'],
      text: ['x', 'y', 'content', 'fontSize', 'fontFamily', 'fontWeight', 'textAnchor'],
      image: ['x', 'y', 'width', 'height'],
      group: [],
    };
    const keys = [...allowed[l.node.type], 'name', 'visible', 'locked'];
    for (const [k, v] of Object.entries(a.props)) {
      if (!keys.includes(k)) throw invalid(`"${k}" alanı ${l.node.type} için güncellenemez (izinli: ${keys.join(', ')})`);
      if (k === 'd') { n.subpaths = parsePathData(String(v)); continue; }
      if (k === 'subpaths') { n.subpaths = OP_SCHEMAS.node_add_path.shape.subpaths.parse(v); continue; }
      if (['x', 'y', 'width', 'height', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'fontSize'].includes(k)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`"${k}" sayı olmalı`);
        if (['width', 'height', 'rx', 'ry'].includes(k) && v < 0) throw invalid(`"${k}" negatif olamaz`);
      }
      n[k] = v;
    }
    return summarize(doc, a.id);
  },

  node_delete(doc, a) {
    for (const id of a.ids) detach(editable(doc, id));
    return { deleted: a.ids };
  },

  node_move(doc, a) {
    let dx = a.dx ?? 0, dy = a.dy ?? 0;
    if (a.to) {
      const b = unionOf(doc, a.ids);
      dx = a.to.x - b.minX; dy = a.to.y - b.minY;
    }
    for (const id of a.ids) translateNode(editable(doc, id), dx, dy);
    return a.ids.map((id) => summarize(doc, id));
  },

  node_transform(doc, a) {
    const mode = a.mode ?? 'multiply';
    for (const id of a.ids) {
      const l = editable(doc, id);
      let o: { x: number; y: number };
      if (a.origin === 'origin') o = { x: 0, y: 0 };
      else if (a.origin && typeof a.origin === 'object') o = a.origin;
      else { const b = frameBBox(l); o = isEmptyBBox(b) ? { x: 0, y: 0 } : bboxCenter(b); }
      let t = a.matrix ? { ...a.matrix } : identity();
      if (a.scale !== undefined) {
        const s = typeof a.scale === 'number' ? { x: a.scale, y: a.scale } : a.scale;
        t = multiply(around(scale(s.x, s.y), o.x, o.y), t);
      }
      if (a.skew) t = multiply(around(skew(a.skew.x, a.skew.y), o.x, o.y), t);
      if (a.rotate) t = multiply(around(rotate(a.rotate), o.x, o.y), t);
      if (a.translate) t = multiply(translate(a.translate.x, a.translate.y), t);
      if (mode === 'set') l.node.transform = t;
      else {
        // t frame uzayında: N' = A⁻¹·t·A·N
        const A = ancestorsMatrix(l.ancestors);
        l.node.transform = multiply(invert(A), multiply(t, multiply(A, l.node.transform)));
      }
    }
    return a.ids.map((id) => summarize(doc, id));
  },

  node_set_style(doc, a) {
    for (const id of a.ids) {
      const l = editable(doc, id);
      // Gruplarda opacity/blend/filters grubun kendisine, dolgu/kontur yapraklara uygulanır.
      if (l.node.type === 'group') {
        const { opacity, blendMode, filters, ...leaf } = a.style;
        if (opacity !== undefined) l.node.style.opacity = opacity;
        if (blendMode !== undefined) l.node.style.blendMode = blendMode;
        if (filters !== undefined) l.node.style.filters = structuredClone(filters);
        l.node.children.forEach((c) => applyLeaf(c, leaf));
      } else applyLeaf(l.node, a.style);
    }
    return a.ids.map((id) => summarize(doc, id));
  },

  node_edit_handles(doc, a) {
    const p = mustPath(editable(doc, a.id));
    for (const e of a.edits) {
      const si = e.subpath ?? 0;
      if (e.action === 'insert' && si === p.subpaths.length && e.index === undefined) {
        p.subpaths.push({ closed: false, points: [] });
      }
      const sp = p.subpaths[si];
      if (!sp) throw notFound(`Alt yol ${si}`);
      const pts = sp.points;
      const idx = e.index ?? pts.length - 1;
      const pt = (i: number) => { const q = pts[i]; if (!q) throw notFound(`Nokta ${si}:${i}`); return q; };
      switch (e.action) {
        case 'move': { const q = pt(idx); if (e.x !== undefined) q.x = e.x; if (e.y !== undefined) q.y = e.y; break; }
        case 'set': {
          const q = pt(idx);
          if (e.x !== undefined) q.x = e.x; if (e.y !== undefined) q.y = e.y;
          if (e.in !== undefined) { if (e.in === null) delete q.in; else q.in = { ...e.in }; }
          if (e.out !== undefined) { if (e.out === null) delete q.out; else q.out = { ...e.out }; }
          break;
        }
        case 'insert': {
          if (e.t !== undefined) {
            if (e.index === undefined) throw invalid('insert+t için segment index gerekli');
            splitSegment(sp, e.index, e.t);
          } else {
            if (e.x === undefined || e.y === undefined) throw invalid('insert için x,y veya t gerekli');
            const np: PathPoint = { x: e.x, y: e.y };
            if (e.in) np.in = { ...e.in }; if (e.out) np.out = { ...e.out };
            insertAt(pts, np, e.index);
          }
          break;
        }
        case 'delete': pt(idx); pts.splice(idx, 1); break;
        case 'close': sp.closed = true; break;
        case 'open': sp.closed = false; break;
        case 'smooth': smoothPoint(sp, idx); break;
        case 'corner': { const q = pt(idx); delete q.in; delete q.out; break; }
      }
    }
    p.subpaths = p.subpaths.filter((s) => s.points.length > 0);
    if (!p.subpaths.length) throw invalid('Düzenleme sonrası path boş kalır; bunun yerine node_delete kullanın');
    return { ...summarize(doc, a.id), subpaths: p.subpaths };
  },

  node_reorder(doc, a) {
    const l = editable(doc, a.id);
    const list = l.siblings;
    const i = list.indexOf(l.node);
    list.splice(i, 1);
    let j: number;
    if (typeof a.to === 'number') j = Math.min(a.to, list.length);
    else j = a.to === 'front' ? list.length : a.to === 'back' ? 0 : a.to === 'forward' ? Math.min(i + 1, list.length) : Math.max(i - 1, 0);
    list.splice(j, 0, l.node);
    return { id: a.id, index: j };
  },

  node_to_path(doc, a) {
    return a.ids.map((id) => {
      const l = editable(doc, id);
      const n = l.node;
      if (n.type === 'path') return summarize(doc, id);
      if (n.type === 'group' || n.type === 'text' || n.type === 'image') throw new VectorError('UNSUPPORTED', `${n.type} path'e çevrilemez`);
      const p: PathNode = {
        type: 'path', id: n.id, name: n.name, transform: n.transform, style: n.style, visible: n.visible, locked: n.locked,
        subpaths: structuredClone(nodeSubPaths(n)), fillRule: 'nonzero',
      };
      l.siblings[l.siblings.indexOf(n)] = p;
      return summarize(doc, id);
    });
  },

  boolean_union: (doc, a) => runBoolean(doc, 'union', a.ids, a.keepOriginals),
  boolean_subtract: (doc, a) => runBoolean(doc, 'subtract', a.ids, a.keepOriginals),
  boolean_intersect: (doc, a) => runBoolean(doc, 'intersect', a.ids, a.keepOriginals),
  boolean_exclude: (doc, a) => runBoolean(doc, 'exclude', a.ids, a.keepOriginals),

  path_offset(doc, a) {
    const l = editable(doc, a.id);
    const o = operandOf(l);
    const res = offsetPolygons(o.polys, o.fillRule, a.delta, a.join ?? 'round');
    if (!res.length) throw invalid('Ofset sonucu boş (şekil tamamen küçüldü)');
    const node = pathFromFramePolys(res, l, firstLeafStyle(l.node), l.node.name ? `${l.node.name} (offset)` : undefined);
    insertAt(l.siblings, node, l.siblings.indexOf(l.node) + (a.keepOriginal === false ? 0 : 1));
    if (a.keepOriginal === false) detach(mustLocate(doc, a.id));
    return summarize(doc, node.id);
  },

  path_outline_stroke(doc, a) {
    const l = editable(doc, a.id);
    const n = l.node;
    if (n.type === 'group' || n.type === 'text' || n.type === 'image') throw new VectorError('UNSUPPORTED', `${n.type} için kontur dönüştürme desteklenmez`);
    if (n.style.stroke === 'none' || n.style.strokeWidth <= 0) throw invalid('Node\'un konturu yok');
    const A = ancestorsMatrix(l.ancestors);
    const { polys, closed } = nodePolygons(n, A);
    const m = multiply(A, n.transform);
    const w = n.style.strokeWidth * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    const lj = n.style.strokeLinejoin === 'round' ? 'round' : n.style.strokeLinejoin === 'bevel' ? 'square' : 'miter';
    const res = strokeToPolygons(polys, closed, w, lj, n.style.strokeLinecap ?? 'butt');
    const style = mkStyle({ fill: n.style.stroke, stroke: 'none', opacity: n.style.opacity, fillOpacity: n.style.strokeOpacity }, {});
    const node = pathFromFramePolys(res, l, style, n.name ? `${n.name} (kontur)` : undefined);
    node.fillRule = 'nonzero';
    insertAt(l.siblings, node, l.siblings.indexOf(n) + 1);
    if (!a.keepOriginal) detach(mustLocate(doc, a.id));
    return summarize(doc, node.id);
  },

  group(doc, a) {
    const locs = a.ids.map((id) => editable(doc, id));
    const first = locs[0];
    // Grup, seçimdeki en üstteki node'un yerine, ilkinin kapsayıcısına girer.
    const g: GroupNode = {
      type: 'group', id: newId('group'), name: a.name, transform: identity(), style: defaultStyle({ fill: 'none' }),
      visible: true, locked: false, children: [],
    };
    const container = first.siblings, target = first.ancestors;
    const topIdx = Math.max(...locs.filter((l) => l.siblings === container).map((l) => l.index));
    insertAt(container, g, topIdx + 1);
    // z-sırasını koru: belge sırasına göre ekle
    const order = new Map<string, number>();
    let k = 0;
    for (const p of doc.pages) for (const f of p.frames) for (const w of walk(f.nodes)) order.set(w.node.id, k++);
    locs.sort((x, y) => order.get(x.node.id)! - order.get(y.node.id)!);
    for (const l of locs) {
      detach(l);
      reparentTransform(l.node, l.ancestors, [...target, g]);
      g.children.push(l.node);
    }
    return { ...summarize(doc, g.id), children: a.ids };
  },

  ungroup(doc, a) {
    const l = editable(doc, a.id);
    if (l.node.type !== 'group') throw invalid(`"${a.id}" bir grup değil`);
    if (l.node.isLayer) throw invalid('Katmanlar ungroup edilemez; layer_move_node kullanın');
    const g = l.node;
    const at = l.siblings.indexOf(g);
    l.siblings.splice(at, 1, ...g.children);
    for (const ch of g.children) {
      ch.transform = multiply(g.transform, ch.transform);
      if (g.style.opacity !== 1) ch.style.opacity *= g.style.opacity;
    }
    return { released: g.children.map((c) => c.id) };
  },

  duplicate(doc, a) {
    const out: string[] = [];
    for (const id of a.ids) {
      const l = mustLocate(doc, id);
      const c = cloneWithNewIds(l.node);
      c.locked = false;
      insertAt(l.siblings, c, l.siblings.indexOf(l.node) + 1);
      const cl = mustLocate(doc, c.id);
      translateNode(cl, a.dx ?? 0, a.dy ?? 0);
      out.push(c.id);
    }
    return out.map((id) => summarize(doc, id));
  },

  layer_create(doc, a) {
    const { frame } = findFrame(doc, a.frameId);
    const g: GroupNode = {
      type: 'group', id: newId('layer'), name: a.name, isLayer: true, transform: identity(),
      style: defaultStyle({ fill: 'none' }), visible: true, locked: false, children: [],
    };
    insertAt(frame.nodes, g, a.index);
    return { id: g.id, name: g.name, frameId: frame.id };
  },

  layer_move_node(doc, a) {
    const target = containerChildren(doc, a.layerId);
    if (target.group && target.group.locked) throw new VectorError('NODE_LOCKED', 'Hedef katman kilitli');
    let idx = a.index;
    for (const id of a.ids) {
      const l = editable(doc, id);
      if (target.group && (l.node === target.group || target.ancestors.includes(l.node as GroupNode)))
        throw invalid('Bir node kendi içine taşınamaz');
      detach(l);
      reparentTransform(l.node, l.ancestors, target.ancestors);
      insertAt(target.list, l.node, idx);
      if (idx !== undefined) idx++;
    }
    return a.ids.map((id) => summarize(doc, id));
  },

  layer_toggle(doc, a) {
    const l = mustLocate(doc, a.id);
    l.node.visible = a.visible ?? !l.node.visible;
    return { id: a.id, visible: l.node.visible };
  },

  layer_lock(doc, a) {
    const l = mustLocate(doc, a.id);
    l.node.locked = a.locked ?? !l.node.locked;
    return { id: a.id, locked: l.node.locked };
  },

  frame_create(doc, a) {
    const page = findPage(doc, a.pageId);
    const f = createFrame(a.name, a.x, a.y, a.w, a.h);
    if (a.background) f.background = a.background;
    page.frames.push(f);
    return { id: f.id, pageId: page.id };
  },

  frame_update(doc, a) {
    const { frame } = findFrame(doc, a.id);
    for (const k of ['name', 'x', 'y', 'w', 'h', 'background'] as const) if (a[k] !== undefined) (frame as any)[k] = a[k];
    return { id: frame.id, name: frame.name, x: frame.x, y: frame.y, w: frame.w, h: frame.h, background: frame.background };
  },

  snap_to_grid(doc, a) {
    const page = findPage(doc);
    if (a.size) page.grid.size = a.size;
    const s = a.size ?? page.grid.size;
    const snap = (v: number) => Math.round(v / s) * s;
    const ids = a.ids ?? findFrame(doc).frame.nodes.flatMap((n) => (n.type === 'group' && n.isLayer ? n.children : [n])).map((n) => n.id);
    const moved: string[] = [];
    for (const id of ids) {
      const l = locate(doc, id);
      if (!l || isEffectivelyLocked(l)) continue;
      if (a.mode === 'points' && (l.node.type === 'path' || l.node.type === 'line' || l.node.type === 'rect' || l.node.type === 'ellipse')) {
        snapPoints(l, snap);
      } else {
        const b = frameBBox(l);
        if (isEmptyBBox(b)) continue;
        translateNode(l, snap(b.minX) - b.minX, snap(b.minY) - b.minY);
      }
      moved.push(id);
    }
    return { gridSize: s, snapped: moved.map((id) => summarize(doc, id)) };
  },

  add_guide(doc, a) {
    const page = findPage(doc, a.pageId);
    const g = { id: newId('guide'), axis: a.axis, value: a.value };
    page.guides.push(g);
    return g;
  },

  remove_guide(doc, a) {
    for (const p of doc.pages) {
      const i = p.guides.findIndex((g) => g.id === a.id);
      if (i >= 0) { p.guides.splice(i, 1); return { removed: a.id }; }
    }
    throw notFound(`Kılavuz "${a.id}"`);
  },

  align_to(doc, a) {
    const to = a.to ?? 'selection';
    let target: BBox;
    if (to === 'selection') target = unionOf(doc, a.ids);
    else if (to === 'frame') {
      const l = mustLocate(doc, a.ids[0]);
      target = { minX: 0, minY: 0, maxX: l.frame.w, maxY: l.frame.h };
    } else if (to.startsWith('guide:')) {
      const gid = to.slice(6);
      const l = mustLocate(doc, a.ids[0]);
      const g = l.page.guides.find((x) => x.id === gid);
      if (!g) throw notFound(`Kılavuz "${gid}"`);
      const v = g.value - (g.axis === 'x' ? l.frame.x : l.frame.y);
      target = g.axis === 'x' ? { minX: v, maxX: v, minY: -Infinity, maxY: Infinity } : { minY: v, maxY: v, minX: -Infinity, maxX: Infinity };
      const horizontal = ['left', 'hcenter', 'right'].includes(a.align);
      if (horizontal !== (g.axis === 'x')) throw invalid(`${g.axis} kılavuzu ile ${a.align} hizalaması uyumsuz`);
    } else target = frameBBox(mustLocate(doc, to));
    for (const id of a.ids) {
      if (id === to) continue;
      const l = editable(doc, id);
      const b = frameBBox(l);
      let dx = 0, dy = 0;
      switch (a.align) {
        case 'left': dx = target.minX - b.minX; break;
        case 'right': dx = target.maxX - b.maxX; break;
        case 'hcenter': dx = (target.minX + target.maxX) / 2 - (b.minX + b.maxX) / 2; break;
        case 'top': dy = target.minY - b.minY; break;
        case 'bottom': dy = target.maxY - b.maxY; break;
        case 'vcenter': dy = (target.minY + target.maxY) / 2 - (b.minY + b.maxY) / 2; break;
      }
      translateNode(l, dx, dy);
    }
    return a.ids.map((id) => summarize(doc, id));
  },

  node_add_image(doc, a) {
    if (!/^data:image\/(png|jpe?g|webp|gif|bmp|svg\+xml);base64,/i.test(a.href)) throw invalid('href data:image/...;base64 biçiminde olmalı (dosya için doc_import/vectorize_image kullanın)');
    const n: VNode = { type: 'image', ...base('image', a, mkStyle(a.style as Partial<Style>, { fill: 'none' })), x: a.x, y: a.y, width: a.width, height: a.height, href: a.href };
    return addNode(doc, n, a.parentId, a.index);
  },

  clip_create(doc, a) {
    // Illustrator "kırpma maskesi oluştur": maske şekli seçimin en üstündeki (ya da maskId) node'dur.
    const locs = a.ids.map((id) => editable(doc, id));
    const order = new Map<string, number>();
    let k = 0;
    for (const p of doc.pages) for (const f of p.frames) for (const w of walk(f.nodes)) order.set(w.node.id, k++);
    locs.sort((x, y) => order.get(x.node.id)! - order.get(y.node.id)!);
    const maskLoc = a.maskId ? locs.find((l) => l.node.id === a.maskId) : locs[locs.length - 1];
    if (!maskLoc) throw notFound(`Maske "${a.maskId}" seçimde yok`);
    const content = locs.filter((l) => l !== maskLoc);
    if (!content.length) throw invalid('Maskeyle kırpılacak en az bir node gerekli');
    const mask = maskLoc.node;
    if (mask.type === 'group' || mask.type === 'text' || mask.type === 'image') throw new VectorError('UNSUPPORTED', 'Maske şekli path/rect/ellipse olmalı');
    const first = content[0];
    const g: GroupNode = {
      type: 'group', id: newId('clipgroup'), name: a.name ?? 'Kırpma grubu', transform: identity(), style: defaultStyle({ fill: 'none' }),
      visible: true, locked: false, children: [],
      clip: { subpaths: [], rule: mask.type === 'path' ? mask.fillRule : 'nonzero' },
    };
    const container = first.siblings, target = first.ancestors;
    insertAt(container, g, container.indexOf(first.node) + 1);
    // Maskeyi grup uzayına taşı
    const mm = multiply(invert(ancestorsMatrix([...target, g])), multiply(ancestorsMatrix(maskLoc.ancestors), mask.transform));
    g.clip!.subpaths = nodeSubPaths(mask).map((sp) => transformSubPath(sp, mm));
    detach(maskLoc);
    for (const l of content) {
      const cur = mustLocate(doc, l.node.id);
      detach(cur);
      reparentTransform(cur.node, cur.ancestors, [...target, g]);
      g.children.push(cur.node);
    }
    return { ...summarize(doc, g.id), children: content.map((l) => l.node.id) };
  },

  clip_release(doc, a) {
    const l = editable(doc, a.id);
    if (l.node.type !== 'group' || !l.node.clip) throw invalid(`"${a.id}" kırpma maskesi olan bir grup değil`);
    const g = l.node;
    const mask: PathNode = {
      type: 'path', id: newId('path'), name: 'Maske', transform: identity(), visible: true, locked: false,
      style: defaultStyle({ fill: 'none', stroke: '#888888', strokeWidth: 1 }), subpaths: structuredClone(g.clip!.subpaths), fillRule: g.clip!.rule,
    };
    delete g.clip;
    g.children.push(mask);
    return { id: g.id, maskId: mask.id };
  },

  path_simplify(doc, a) {
    const tol = a.tolerance ?? 0.5;
    const out: unknown[] = [];
    for (const id of a.ids) {
      const l = editable(doc, id);
      const targets = l.node.type === 'group' ? [...walk(l.node.children)].map((w) => w.node) : [l.node];
      let before = 0, after = 0;
      for (const n of targets) {
        if (n.type !== 'path' || isEffectivelyLocked(mustLocate(doc, n.id))) continue;
        before += n.subpaths.reduce((s, sp) => s + sp.points.length, 0);
        n.subpaths = n.subpaths.map((sp) => {
          if (sp.points.length < 3) return sp;
          const [poly] = flattenSubPaths([sp], Math.min(tol / 4, 0.1));
          return sp.closed ? fitClosedPolygon(poly, tol, a.cornerAngle ?? 32) : fitOpenPolyline(poly, tol, a.cornerAngle ?? 32);
        });
        after += n.subpaths.reduce((s, sp) => s + sp.points.length, 0);
      }
      out.push({ id, anchorsBefore: before, anchorsAfter: after });
    }
    return out;
  },

  distribute(doc, a) {
    const items = a.ids.map((id) => ({ l: editable(doc, id), b: frameBBox(mustLocate(doc, id)) }));
    const lo = (b: BBox) => (a.axis === 'x' ? b.minX : b.minY);
    const size = (b: BBox) => (a.axis === 'x' ? b.maxX - b.minX : b.maxY - b.minY);
    items.sort((p, q) => lo(p.b) - lo(q.b));
    const first = items[0].b, last = items[items.length - 1].b;
    const span = lo(last) + size(last) - lo(first);
    const gap = (span - items.reduce((s, it) => s + size(it.b), 0)) / (items.length - 1);
    let cursor = lo(first);
    for (const it of items) {
      const d = cursor - lo(it.b);
      translateNode(it.l, a.axis === 'x' ? d : 0, a.axis === 'y' ? d : 0);
      cursor += size(it.b) + gap;
    }
    return { gap: r3(gap), nodes: a.ids.map((id) => summarize(doc, id)) };
  },
};

function applyLeaf(n: VNode, style: Record<string, unknown>) {
  if (n.type === 'group') { n.children.forEach((c) => applyLeaf(c, style)); return; }
  for (const [k, v] of Object.entries(style)) if (v !== undefined) (n.style as any)[k] = structuredClone(v);
}

/** Segment [i → i+1]'i t noktasında de Casteljau ile böl; eğri şekli korunur. */
function splitSegment(sp: SubPath, i: number, t: number) {
  const n = sp.points.length;
  if (i < 0 || i >= (sp.closed ? n : n - 1)) throw notFound(`Segment ${i}`);
  const a = sp.points[i], b = sp.points[(i + 1) % n];
  const p0 = { x: a.x, y: a.y };
  const p1 = { x: a.x + (a.out?.dx ?? 0), y: a.y + (a.out?.dy ?? 0) };
  const p2 = { x: b.x + (b.in?.dx ?? 0), y: b.y + (b.in?.dy ?? 0) };
  const p3 = { x: b.x, y: b.y };
  const L = (p: { x: number; y: number }, q: { x: number; y: number }) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const p01 = L(p0, p1), p12 = L(p1, p2), p23 = L(p2, p3), p012 = L(p01, p12), p123 = L(p12, p23), m = L(p012, p123);
  const curved = !!(a.out || b.in);
  const mid: PathPoint = { x: m.x, y: m.y };
  if (curved) {
    a.out = { dx: p01.x - a.x, dy: p01.y - a.y };
    mid.in = { dx: p012.x - m.x, dy: p012.y - m.y };
    mid.out = { dx: p123.x - m.x, dy: p123.y - m.y };
    b.in = { dx: p23.x - b.x, dy: p23.y - b.y };
  }
  sp.points.splice(i + 1, 0, mid);
}

/** Komşulara göre simetrik, teğet handle üret (Catmull-Rom benzeri). */
function smoothPoint(sp: SubPath, i: number) {
  const n = sp.points.length;
  const p = sp.points[i];
  if (!p) throw notFound(`Nokta ${i}`);
  const prev = sp.points[(i - 1 + n) % n], next = sp.points[(i + 1) % n];
  const hasPrev = sp.closed || i > 0, hasNext = sp.closed || i < n - 1;
  const P = hasPrev ? prev : p, N = hasNext ? next : p;
  let tx = N.x - P.x, ty = N.y - P.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl; ty /= tl;
  const dIn = hasPrev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0;
  const dOut = hasNext ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
  if (hasPrev) p.in = { dx: -tx * dIn, dy: -ty * dIn };
  if (hasNext) p.out = { dx: tx * dOut, dy: ty * dOut };
}

function snapPoints(l: Located, snap: (v: number) => number) {
  const W = multiply(ancestorsMatrix(l.ancestors), l.node.transform);
  const inv = invert(W);
  const sp = (x: number, y: number) => { const w = apply(W, { x, y }); return apply(inv, { x: snap(w.x), y: snap(w.y) }); };
  const n = l.node;
  if (n.type === 'path') for (const s of n.subpaths) for (const p of s.points) { const q = sp(p.x, p.y); p.x = q.x; p.y = q.y; }
  else if (n.type === 'line') { const a = sp(n.x1, n.y1), b = sp(n.x2, n.y2); n.x1 = a.x; n.y1 = a.y; n.x2 = b.x; n.y2 = b.y; }
  else if (n.type === 'rect' || n.type === 'ellipse') {
    const a = sp(n.x, n.y), b = sp(n.x + n.width, n.y + n.height);
    n.x = Math.min(a.x, b.x); n.y = Math.min(a.y, b.y); n.width = Math.abs(b.x - a.x); n.height = Math.abs(b.y - a.y);
  }
}

/** Doğrula + uygula. Belgeyi yerinde değiştirir; atomiklik (geri alma) çağıranın sorumluluğunda. */
export function applyOp(doc: VDocument, op: string, rawArgs: unknown): unknown {
  const schema = (OP_SCHEMAS as Record<string, (typeof OP_SCHEMAS)[OpName]>)[op];
  if (!schema) throw new VectorError('INVALID_ARGUMENT', `Bilinmeyen operasyon: ${op}`);
  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new VectorError('INVALID_ARGUMENT', `${op} argümanları geçersiz: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(kök)'}: ${i.message}`).join('; ')}`);
  }
  return (handlers[op as OpName] as Handler<OpName>)(doc, parsed.data as never);
}

export const isMutatingOp = (op: string) => op in OP_SCHEMAS;
export type { R };
