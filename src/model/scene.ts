import type { Frame, GroupNode, Matrix, Page, VDocument, VNode } from '../common/types.js';
import { newId } from '../common/ids.js';
import { notFound } from '../common/errors.js';
import { identity, multiply } from '../math/matrix.js';

export function createDocument(title = 'Adsız', w = 1024, h = 768): VDocument {
  return {
    id: newId('doc'),
    title,
    version: 0,
    pages: [createPage('Sayfa 1', w, h)],
  };
}

export function createPage(name: string, w = 1024, h = 768): Page {
  return {
    id: newId('page'),
    name,
    frames: [createFrame('Çerçeve 1', 0, 0, w, h)],
    guides: [],
    grid: { size: 8, enabled: false },
  };
}

export function createFrame(name: string, x: number, y: number, w: number, h: number): Frame {
  return { id: newId('frame'), name, x, y, w, h, background: '#ffffff', nodes: [] };
}

/** Bir node'un belgedeki konumu: sayfa, frame, ebeveyn grubu (yoksa frame kökü) ve kardeş listesi. */
export interface Located {
  node: VNode;
  page: Page;
  frame: Frame;
  parent: GroupNode | null;
  siblings: VNode[];
  index: number;
  /** Kökten ebeveyne kadar grup zinciri. */
  ancestors: GroupNode[];
}

export function* walk(nodes: VNode[], ancestors: GroupNode[] = []): Generator<{ node: VNode; ancestors: GroupNode[]; siblings: VNode[]; index: number }> {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    yield { node: n, ancestors, siblings: nodes, index: i };
    if (n.type === 'group') yield* walk(n.children, [...ancestors, n]);
  }
}

export function locate(doc: VDocument, id: string): Located | null {
  for (const page of doc.pages)
    for (const frame of page.frames)
      for (const w of walk(frame.nodes)) {
        if (w.node.id === id) {
          return {
            node: w.node, page, frame,
            parent: w.ancestors[w.ancestors.length - 1] ?? null,
            siblings: w.siblings, index: w.index, ancestors: w.ancestors,
          };
        }
      }
  return null;
}

export function mustLocate(doc: VDocument, id: string): Located {
  const l = locate(doc, id);
  if (!l) throw notFound(`Node "${id}"`);
  return l;
}

export function findFrame(doc: VDocument, frameId?: string): { page: Page; frame: Frame } {
  for (const page of doc.pages)
    for (const frame of page.frames)
      if (!frameId || frame.id === frameId) return { page, frame };
  throw notFound(`Frame "${frameId}"`);
}

export function findPage(doc: VDocument, pageId?: string): Page {
  const p = pageId ? doc.pages.find((x) => x.id === pageId) : doc.pages[0];
  if (!p) throw notFound(`Sayfa "${pageId}"`);
  return p;
}

/** Id'si frame, grup ya da katman olan kapsayıcının çocuk listesini döner. */
export function containerChildren(doc: VDocument, containerId: string | undefined): { list: VNode[]; frame: Frame; group: GroupNode | null; ancestors: GroupNode[] } {
  if (!containerId) {
    const { frame } = findFrame(doc);
    return { list: frame.nodes, frame, group: null, ancestors: [] };
  }
  for (const page of doc.pages)
    for (const frame of page.frames)
      if (frame.id === containerId) return { list: frame.nodes, frame, group: null, ancestors: [] };
  const l = mustLocate(doc, containerId);
  if (l.node.type !== 'group') throw notFound(`"${containerId}" bir grup/katman değil; kapsayıcı`);
  return { list: l.node.children, frame: l.frame, group: l.node, ancestors: [...l.ancestors, l.node] };
}

/** Frame kökünden verilen ata zincirine kadar birikmiş matris (node'un ebeveyn uzayı → frame uzayı). */
export function ancestorsMatrix(ancestors: GroupNode[]): Matrix {
  let m = identity();
  for (const g of ancestors) m = multiply(m, g.transform);
  return m;
}

/** Node'un yerel uzayından frame uzayına matris. */
export function worldMatrix(l: Located): Matrix {
  return multiply(ancestorsMatrix(l.ancestors), l.node.transform);
}

export function isEffectivelyLocked(l: Located): boolean {
  return l.node.locked || l.ancestors.some((a) => a.locked);
}

/** Derin kopya + tüm alt ağaçta yeni id'ler. */
export function cloneWithNewIds<T extends VNode>(n: T): T {
  const c = structuredClone(n);
  const reid = (x: VNode) => {
    x.id = newId(x.type);
    if (x.type === 'group') x.children.forEach(reid);
  };
  reid(c);
  return c;
}

export function allNodes(doc: VDocument): VNode[] {
  const out: VNode[] = [];
  for (const p of doc.pages) for (const f of p.frames) for (const w of walk(f.nodes)) out.push(w.node);
  return out;
}
