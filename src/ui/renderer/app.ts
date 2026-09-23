import type { BBox, Frame, Matrix, PathNode, PathPoint, Point, SubPath, VDocument, VNode } from '../../common/types.js';
import { drawFrame, type Ctx } from '../../render/draw.js';
import { apply, invert, multiply, rotate as rotM, scale as scaleM, translate, around, meanScale } from '../../math/matrix.js';
import { nodeBBox, textBox } from '../../math/geometry.js';
import { emptyBBox, isEmptyBBox, unionBBox, segments } from '../../math/bezier.js';
import { ancestorsMatrix, locate, walk, type Located } from '../../model/scene.js';
import { hitTest, marqueeSelect } from '../../model/hit.js';
import { ApiError, DocClient, type LockInfo } from './api.js';

// ———————————————————————————————— durum

type Tool = 'select' | 'direct' | 'hand' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text';

const params = new URLSearchParams(location.search);
const serverBase = params.get('server') ?? (location.protocol.startsWith('http') ? location.origin : 'http://127.0.0.1:7878');
const api = new DocClient(serverBase, params.get('agent') ?? 'ui:insan');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')! as Ctx;

const state = {
  doc: null as VDocument | null,
  selection: [] as string[],
  tool: 'select' as Tool,
  cam: { z: 1, x: 40, y: 40 },
  dpr: window.devicePixelRatio || 1,
  /** Sürükleme sırasında sunucuya gitmeden gösterilen geçici dönüşüm (frame uzayı). */
  preview: null as null | { ids: string[]; m: Matrix },
  pen: null as null | { points: PathPoint[]; closed: boolean; dragging: boolean },
  marquee: null as null | { a: Point; b: Point },
  draft: null as null | { kind: 'rect' | 'ellipse' | 'line'; a: Point; b: Point },
  editPath: null as null | string, // doğrudan seçimde düzenlenen path id
  pointPreview: null as null | { sp: number; i: number; which: 'anchor' | 'in' | 'out'; p: Point },
  hover: null as string | null,
  spaceDown: false,
  lock: { held: false } as LockInfo,
  fitted: false,
  mouse: { x: 0, y: 0 },
  /** Sürükleme sonucu sunucuya gönderildi; gelen ilk belge önizlemenin yerini alır. */
  committing: false,
};
const agentColors = new Map<string, string>();
const PALETTE = ['#4f8cff', '#ff5c9a', '#3ecf8e', '#f5b041', '#a45cff', '#35c6e8', '#ff8a4c'];
const colorOf = (a: string) => {
  if (!agentColors.has(a)) agentColors.set(a, a.startsWith('ui:') ? '#e6e8ec' : PALETTE[agentColors.size % PALETTE.length]);
  return agentColors.get(a)!;
};

// ———————————————————————————————— yardımcılar

const frame = (): Frame | null => state.doc?.pages[0]?.frames[0] ?? null;
/** frame uzayı → ekran px (CSS) */
const viewM = (f: Frame): Matrix => multiply({ a: state.cam.z, b: 0, c: 0, d: state.cam.z, e: state.cam.x, f: state.cam.y }, translate(f.x, f.y));
const toFrame = (sx: number, sy: number): Point => { const f = frame(); return f ? apply(invert(viewM(f)), { x: sx, y: sy }) : { x: sx, y: sy }; };
const toScreen = (p: Point): Point => { const f = frame()!; return apply(viewM(f), p); };
const loc = (id: string): Located | null => (state.doc ? locate(state.doc, id) : null);
const worldOf = (l: Located): Matrix => multiply(ancestorsMatrix(l.ancestors), l.node.transform);
const r2 = (n: number) => Math.round(n * 100) / 100;

function selectionBBox(ids = state.selection): BBox | null {
  let b = emptyBBox();
  for (const id of ids) {
    const l = loc(id);
    if (!l) continue;
    const nb = nodeBBox(l.node, ancestorsMatrix(l.ancestors));
    if (!isEmptyBBox(nb)) b = unionBBox(b, nb);
  }
  if (isEmptyBBox(b)) return null;
  if (state.preview) {
    const m = state.preview.m;
    const pts = [apply(m, { x: b.minX, y: b.minY }), apply(m, { x: b.maxX, y: b.minY }), apply(m, { x: b.maxX, y: b.maxY }), apply(m, { x: b.minX, y: b.maxY })];
    return { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
  }
  return b;
}

let toastTimer = 0;
function toast(msg: string, kind: 'error' | 'info' = 'error') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind === 'info' ? 'info' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = 'toast'), kind === 'info' ? 1800 : 4200);
}

async function run<T>(p: Promise<T>): Promise<T | undefined> {
  try { return await p; }
  catch (e) {
    if (e instanceof ApiError && e.code === 'LOCKED') toast(`Belge bir ajan tarafından kilitli: ${(e.details as any)?.holder ?? ''}. Bekleyin.`);
    else toast((e as Error).message);
    return undefined;
  }
}

// ———————————————————————————————— çizim

let dirty = true;
const invalidate = () => { dirty = true; };

function resize() {
  const r = canvas.getBoundingClientRect();
  state.dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * state.dpr));
  canvas.height = Math.max(1, Math.round(r.height * state.dpr));
  if (!state.fitted && state.doc) { state.fitted = true; fit(); }
  invalidate();
}

function fit() {
  const f = frame();
  if (!f) return;
  const r = canvas.getBoundingClientRect();
  if (r.width < 100 || r.height < 100) { state.fitted = false; return; } // yerleşim henüz hazır değil; resize'da tekrar
  const z = Math.min((r.width - 80) / f.w, (r.height - 80) / f.h);
  state.cam.z = Math.max(0.05, Math.min(z, 8));
  state.cam.x = (r.width - f.w * state.cam.z) / 2 - f.x * state.cam.z;
  state.cam.y = (r.height - f.h * state.cam.z) / 2 - f.y * state.cam.z;
  updateZoomLabel();
  invalidate();
}

function renderedFrame(f: Frame): Frame {
  if (!state.preview && !state.pointPreview) return f;
  const clone: Frame = structuredClone(f);
  const doc = { ...state.doc!, pages: [{ ...state.doc!.pages[0], frames: [clone] }] } as VDocument;
  if (state.preview) {
    for (const id of state.preview.ids) {
      const l = locate(doc, id);
      if (!l) continue;
      const A = ancestorsMatrix(l.ancestors);
      l.node.transform = multiply(invert(A), multiply(state.preview.m, multiply(A, l.node.transform)));
    }
  }
  if (state.pointPreview && state.editPath) {
    const l = locate(doc, state.editPath);
    if (l && l.node.type === 'path') applyPointEdit(l.node, state.pointPreview, invert(worldOf(l)));
  }
  return clone;
}

function draw() {
  requestAnimationFrame(draw);
  if (!dirty) return;
  dirty = false;
  const { dpr } = state;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#15171b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const f = frame();
  if (!f) return;
  const screen = multiply(scaleM(dpr), viewM(f));

  // Frame gölgesi + şeffaf arka plan için dama deseni
  ctx.save();
  ctx.setTransform(screen.a, screen.b, screen.c, screen.d, screen.e, screen.f);
  ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 18 * dpr; ctx.shadowOffsetY = 4 * dpr;
  ctx.fillStyle = f.background && f.background !== 'none' ? f.background : '#ffffff';
  ctx.fillRect(0, 0, f.w, f.h);
  ctx.restore();
  if (!f.background || f.background === 'none') drawChecker(f, screen);

  ctx.save();
  // İçerik frame sınırına kırpılır
  ctx.setTransform(screen.a, screen.b, screen.c, screen.d, screen.e, screen.f);
  ctx.beginPath(); ctx.rect(0, 0, f.w, f.h); ctx.clip();
  drawFrame(ctx, renderedFrame(f), screen, {
    width: canvas.width, height: canvas.height, background: false,
    createLayer: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return { canvas: c, ctx: c.getContext('2d')! }; },
  });
  ctx.restore();

  drawOverlays();
}

function drawChecker(f: Frame, m: Matrix) {
  ctx.save();
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  const s = 10 / state.cam.z;
  ctx.fillStyle = '#e9e9e9';
  for (let y = 0; y < f.h; y += s) for (let x = ((y / s) % 2) * s; x < f.w; x += 2 * s) ctx.fillRect(x, y, Math.min(s, f.w - x), Math.min(s, f.h - y));
  ctx.restore();
}

const HANDLE = 8;
type HandleId = 'nw' | 'ne' | 'se' | 'sw' | 'n' | 'e' | 's' | 'w' | 'rot';

function handlePositions(b: BBox): Record<HandleId, Point> {
  const tl = toScreen({ x: b.minX, y: b.minY }), br = toScreen({ x: b.maxX, y: b.maxY });
  const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
  return {
    nw: tl, ne: { x: br.x, y: tl.y }, se: br, sw: { x: tl.x, y: br.y },
    n: { x: cx, y: tl.y }, e: { x: br.x, y: cy }, s: { x: cx, y: br.y }, w: { x: tl.x, y: cy },
    rot: { x: cx, y: tl.y - 26 },
  };
}

function drawOverlays() {
  const d = state.dpr;
  ctx.save();
  ctx.setTransform(d, 0, 0, d, 0, 0);
  // kılavuzlar
  const page = state.doc!.pages[0];
  ctx.strokeStyle = 'rgba(255, 92, 154, .8)'; ctx.lineWidth = 1;
  for (const g of page.guides) {
    ctx.beginPath();
    if (g.axis === 'x') { const x = state.cam.x + g.value * state.cam.z; ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); }
    else { const y = state.cam.y + g.value * state.cam.z; ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); }
    ctx.stroke();
  }
  // üzerine gelinen
  if (state.hover && !state.selection.includes(state.hover) && state.tool === 'select') outlineNode(state.hover, 'rgba(79,140,255,.7)', 1);
  // seçim
  for (const id of state.selection) outlineNode(id, '#4f8cff', 1);
  const b = selectionBBox();
  if (b && state.tool === 'select') {
    const h = handlePositions(b);
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 1;
    ctx.strokeRect(h.nw.x + 0.5, h.nw.y + 0.5, h.se.x - h.nw.x, h.se.y - h.nw.y);
    ctx.beginPath(); ctx.moveTo(h.n.x, h.n.y); ctx.lineTo(h.rot.x, h.rot.y); ctx.stroke();
    for (const [k, p] of Object.entries(h)) {
      ctx.fillStyle = '#fff';
      if (k === 'rot') { ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      else { ctx.fillRect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE); ctx.strokeRect(p.x - HANDLE / 2 + .5, p.y - HANDLE / 2 + .5, HANDLE - 1, HANDLE - 1); }
    }
    // boyut etiketi
    const label = `${r2(b.maxX - b.minX)} × ${r2(b.maxY - b.minY)}`;
    ctx.font = '11px Inter, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = '#4f8cff'; ctx.fillRect(h.s.x - tw / 2 - 5, h.s.y + 8, tw + 10, 17);
    ctx.fillStyle = '#fff'; ctx.fillText(label, h.s.x - tw / 2, h.s.y + 20);
  }
  // doğrudan seçim: çapa ve handle'lar
  if (state.editPath) drawPathEditor(state.editPath);
  // taslak şekil
  if (state.draft) {
    const a = toScreen(state.draft.a), bb = toScreen(state.draft.b);
    ctx.strokeStyle = '#4f8cff'; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    if (state.draft.kind === 'line') { ctx.moveTo(a.x, a.y); ctx.lineTo(bb.x, bb.y); }
    else if (state.draft.kind === 'rect') ctx.rect(a.x, a.y, bb.x - a.x, bb.y - a.y);
    else ctx.ellipse((a.x + bb.x) / 2, (a.y + bb.y) / 2, Math.abs(bb.x - a.x) / 2, Math.abs(bb.y - a.y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke(); ctx.setLineDash([]);
  }
  // kalem önizleme
  if (state.pen && state.pen.points.length) drawPenPreview();
  if (state.marquee) {
    const a = toScreen(state.marquee.a), bb = toScreen(state.marquee.b);
    ctx.fillStyle = 'rgba(79,140,255,.12)'; ctx.strokeStyle = 'rgba(79,140,255,.9)';
    ctx.fillRect(a.x, a.y, bb.x - a.x, bb.y - a.y); ctx.strokeRect(a.x + .5, a.y + .5, bb.x - a.x, bb.y - a.y);
  }
  ctx.restore();
}

function outlineNode(id: string, color: string, width: number) {
  const l = loc(id);
  if (!l) return;
  let W = worldOf(l);
  if (state.preview?.ids.includes(id)) W = multiply(state.preview.m, W);
  const S = viewM(frame()!);
  // Grup: tüm yaprakları kendi birikmiş matrisleriyle çiz
  const leaves: { n: VNode; m: Matrix }[] = l.node.type === 'group'
    ? [...walk(l.node.children)].filter((w) => w.node.type !== 'group')
      .map((w) => ({ n: w.node, m: multiply(W, multiply(ancestorsMatrix(w.ancestors), w.node.transform)) }))
    : [{ n: l.node, m: W }];
  ctx.save();
  ctx.strokeStyle = color;
  for (const { n, m } of leaves) {
    const M = multiply(S, m);
    const d = state.dpr;
    ctx.setTransform(d * M.a, d * M.b, d * M.c, d * M.d, d * M.e, d * M.f);
    ctx.lineWidth = width / (meanScale(M) || 1);
    traceNode(n);
    ctx.stroke();
  }
  ctx.restore();
}

function traceNode(n: VNode) {
  ctx.beginPath();
  if (n.type === 'group') return;
  if (n.type === 'rect') { ctx.rect(n.x, n.y, n.width, n.height); return; }
  if (n.type === 'ellipse') { ctx.ellipse(n.x + n.width / 2, n.y + n.height / 2, Math.abs(n.width / 2), Math.abs(n.height / 2), 0, 0, Math.PI * 2); return; }
  if (n.type === 'line') { ctx.moveTo(n.x1, n.y1); ctx.lineTo(n.x2, n.y2); return; }
  if (n.type === 'text') { const b = textBox(n); ctx.rect(b.x, b.y, b.w, b.h); return; }
  tracePathLocal(n.subpaths);
}

function tracePathLocal(sps: SubPath[]) {
  for (const sp of sps) {
    if (!sp.points.length) continue;
    ctx.moveTo(sp.points[0].x, sp.points[0].y);
    for (const c of segments(sp)) ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
    if (sp.closed) ctx.closePath();
  }
}

function pathEditorPoints(id: string) {
  const l = loc(id);
  if (!l || l.node.type !== 'path') return null;
  let node = l.node;
  if (state.pointPreview) { node = structuredClone(node); applyPointEdit(node, state.pointPreview, invert(worldOf(l))); }
  const W = worldOf(l);
  const out: { sp: number; i: number; anchor: Point; in?: Point; out?: Point }[] = [];
  node.subpaths.forEach((sp, si) => sp.points.forEach((p, i) => {
    const a = toScreen(apply(W, p));
    out.push({
      sp: si, i, anchor: a,
      in: p.in ? toScreen(apply(W, { x: p.x + p.in.dx, y: p.y + p.in.dy })) : undefined,
      out: p.out ? toScreen(apply(W, { x: p.x + p.out.dx, y: p.y + p.out.dy })) : undefined,
    });
  }));
  return { node, W, pts: out };
}

function drawPathEditor(id: string) {
  const r = pathEditorPoints(id);
  if (!r) return;
  // yol konturu
  const M = multiply(viewM(frame()!), r.W);
  ctx.save();
  ctx.setTransform(state.dpr * M.a, state.dpr * M.b, state.dpr * M.c, state.dpr * M.d, state.dpr * M.e, state.dpr * M.f);
  ctx.beginPath(); tracePathLocal(r.node.subpaths);
  ctx.restore();
  ctx.save(); ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 1; ctx.stroke();
  for (const p of r.pts) {
    ctx.strokeStyle = '#a45cff';
    for (const h of [p.in, p.out]) if (h) {
      ctx.beginPath(); ctx.moveTo(p.anchor.x, p.anchor.y); ctx.lineTo(h.x, h.y); ctx.stroke();
      ctx.fillStyle = '#a45cff'; ctx.beginPath(); ctx.arc(h.x, h.y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4f8cff';
    ctx.fillRect(p.anchor.x - 3.5, p.anchor.y - 3.5, 7, 7); ctx.strokeRect(p.anchor.x - 3.5, p.anchor.y - 3.5, 7, 7);
  }
  ctx.restore();
}

function drawPenPreview() {
  const pen = state.pen!;
  const pts = pen.points.map((p) => ({ ...p }));
  ctx.save();
  ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  const S = (p: Point) => toScreen(p);
  const first = S(pts[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const c1 = S({ x: a.x + (a.out?.dx ?? 0), y: a.y + (a.out?.dy ?? 0) }), c2 = S({ x: b.x + (b.in?.dx ?? 0), y: b.y + (b.in?.dy ?? 0) }), e = S(b);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
  }
  if (!pen.dragging) { const m = S(toFrame(state.mouse.x, state.mouse.y)); ctx.lineTo(m.x, m.y); }
  ctx.stroke();
  for (const p of pts) {
    const a = S(p);
    ctx.fillStyle = '#fff'; ctx.fillRect(a.x - 3, a.y - 3, 6, 6); ctx.strokeRect(a.x - 3, a.y - 3, 6, 6);
    if (p.out) { const h = S({ x: p.x + p.out.dx, y: p.y + p.out.dy }), hi = S({ x: p.x - p.out.dx, y: p.y - p.out.dy }); ctx.beginPath(); ctx.moveTo(hi.x, hi.y); ctx.lineTo(h.x, h.y); ctx.stroke(); }
  }
  ctx.restore();
}

// ———————————————————————————————— nokta düzenleme

function applyPointEdit(node: PathNode, e: { sp: number; i: number; which: 'anchor' | 'in' | 'out'; p: Point }, inv: Matrix) {
  const pt = node.subpaths[e.sp]?.points[e.i];
  if (!pt) return;
  const local = apply(inv, e.p);
  if (e.which === 'anchor') { pt.x = local.x; pt.y = local.y; return; }
  const h = { dx: local.x - pt.x, dy: local.y - pt.y };
  const other = e.which === 'in' ? 'out' : 'in';
  if (pt[other] && !altDown) {
    // düzgün düğüm: karşı handle'ı aynı doğrultuda, kendi uzunluğunu koruyarak döndür
    const len = Math.hypot(pt[other]!.dx, pt[other]!.dy), hl = Math.hypot(h.dx, h.dy) || 1;
    pt[other] = { dx: (-h.dx / hl) * len, dy: (-h.dy / hl) * len };
  }
  pt[e.which] = h;
}
let altDown = false;

// ———————————————————————————————— etkileşim

type Drag =
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { kind: 'move'; start: Point; ids: string[] }
  | { kind: 'scale'; handle: HandleId; start: Point; b: BBox; ids: string[] }
  | { kind: 'rotate'; start: Point; c: Point; ids: string[] }
  | { kind: 'marquee'; start: Point; additive: boolean }
  | { kind: 'draft'; start: Point }
  | { kind: 'pen'; start: Point }
  | { kind: 'point'; sp: number; i: number; which: 'anchor' | 'in' | 'out' };
let drag: Drag | null = null;

function hitHandle(sx: number, sy: number): HandleId | null {
  const b = selectionBBox();
  if (!b) return null;
  const h = handlePositions(b);
  for (const [k, p] of Object.entries(h) as [HandleId, Point][]) if (Math.abs(p.x - sx) <= 6 && Math.abs(p.y - sy) <= 6) return k;
  return null;
}

function pick(p: Point, deep = false): string | null {
  const f = frame();
  if (!f) return null;
  const hits = hitTest(f, p, 4 / state.cam.z, deep).filter((id) => {
    const l = loc(id);
    return l && !l.node.locked && !l.ancestors.some((a) => a.locked);
  });
  return hits[0] ?? null;
}

const snapGrid = (p: Point, e: PointerEvent | MouseEvent): Point => {
  const g = state.doc?.pages[0].grid;
  if (!(e.shiftKey && !(drag && drag.kind === 'move')) && !g?.enabled) return p;
  const s = g?.size ?? 8;
  return g?.enabled ? { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s } : p;
};

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const p = toFrame(sx, sy);
  if (e.button === 1 || state.tool === 'hand' || state.spaceDown) { drag = { kind: 'pan', sx, sy, cx: state.cam.x, cy: state.cam.y }; return; }
  if (e.button !== 0) return;

  switch (state.tool) {
    case 'select': {
      const h = hitHandle(sx, sy);
      if (h) {
        const b = selectionBBox()!;
        drag = h === 'rot' ? { kind: 'rotate', start: p, c: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, ids: [...state.selection] }
          : { kind: 'scale', handle: h, start: p, b, ids: [...state.selection] };
        return;
      }
      const id = pick(p);
      if (id) {
        if (e.shiftKey) state.selection = state.selection.includes(id) ? state.selection.filter((x) => x !== id) : [...state.selection, id];
        else if (!state.selection.includes(id)) state.selection = [id];
        if (e.altKey && state.selection.length) {
          // Alt+sürükle: kopyala ve kopyayı taşı
          const ids = [...state.selection];
          void run(api.op<{ id: string }[]>('duplicate', { ids })).then((r) => { if (r) { state.selection = r.result.map((x) => x.id); refreshPanels(); } });
        }
        drag = { kind: 'move', start: p, ids: [...state.selection] };
      } else {
        if (!e.shiftKey) state.selection = [];
        drag = { kind: 'marquee', start: p, additive: e.shiftKey };
        state.marquee = { a: p, b: p };
      }
      refreshPanels();
      break;
    }
    case 'direct': {
      const ed = state.editPath && pathEditorPoints(state.editPath);
      if (ed) {
        for (const q of ed.pts) {
          for (const which of ['in', 'out', 'anchor'] as const) {
            const s = which === 'anchor' ? q.anchor : q[which];
            if (s && Math.hypot(s.x - sx, s.y - sy) <= 6) { drag = { kind: 'point', sp: q.sp, i: q.i, which }; return; }
          }
        }
      }
      const id = pick(p, true);
      if (id) void enterPathEdit(id);
      else { state.editPath = null; state.selection = []; refreshPanels(); }
      break;
    }
    case 'rect': case 'ellipse': case 'line': {
      const q = snapGrid(p, e);
      drag = { kind: 'draft', start: q };
      state.draft = { kind: state.tool, a: q, b: q };
      break;
    }
    case 'pen': {
      const q = snapGrid(p, e);
      if (!state.pen) state.pen = { points: [], closed: false, dragging: false };
      const first = state.pen.points[0];
      if (first && state.pen.points.length > 2 && Math.hypot(toScreen(first).x - sx, toScreen(first).y - sy) < 8) {
        state.pen.closed = true; void finishPen(); return;
      }
      state.pen.points.push({ x: q.x, y: q.y });
      state.pen.dragging = true;
      drag = { kind: 'pen', start: q };
      break;
    }
    case 'text': openTextInput(sx, sy, p); break;
  }
  invalidate();
});

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  state.mouse = { x: sx, y: sy };
  const p = toFrame(sx, sy);
  $('cursor').textContent = `x ${r2(p.x)}  y ${r2(p.y)}`;
  if (!drag) {
    if (state.tool === 'select') {
      const hh = hitHandle(sx, sy);
      canvas.style.cursor = hh === 'rot' ? 'grab' : hh ? (['nw', 'se'].includes(hh) ? 'nwse-resize' : ['ne', 'sw'].includes(hh) ? 'nesw-resize' : ['n', 's'].includes(hh) ? 'ns-resize' : 'ew-resize') : 'default';
      const h = pick(p);
      if (h !== state.hover) { state.hover = h; invalidate(); }
    } else canvas.style.cursor = state.tool === 'hand' || state.spaceDown ? 'grab' : 'crosshair';
    if (state.pen) invalidate();
    return;
  }
  switch (drag.kind) {
    case 'pan': state.cam.x = drag.cx + sx - drag.sx; state.cam.y = drag.cy + sy - drag.sy; break;
    case 'move': {
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      state.preview = { ids: drag.ids, m: translate(dx, dy) };
      break;
    }
    case 'scale': {
      const { b, handle } = drag;
      const ox = handle.includes('w') ? b.maxX : handle.includes('e') ? b.minX : (b.minX + b.maxX) / 2;
      const oy = handle.includes('n') ? b.maxY : handle.includes('s') ? b.minY : (b.minY + b.maxY) / 2;
      const w = b.maxX - b.minX || 1, h = b.maxY - b.minY || 1;
      let sxF = handle === 'n' || handle === 's' ? 1 : (handle.includes('w') ? b.maxX - p.x : p.x - b.minX) / w;
      let syF = handle === 'e' || handle === 'w' ? 1 : (handle.includes('n') ? b.maxY - p.y : p.y - b.minY) / h;
      if (e.shiftKey && handle.length === 2) { const s = Math.max(Math.abs(sxF), Math.abs(syF)); sxF = Math.sign(sxF || 1) * s; syF = Math.sign(syF || 1) * s; }
      if (Math.abs(sxF) < 0.01) sxF = 0.01; if (Math.abs(syF) < 0.01) syF = 0.01;
      state.preview = { ids: drag.ids, m: around(scaleM(sxF, syF), ox, oy) };
      (drag as any).last = { sx: sxF, sy: syF, ox, oy };
      break;
    }
    case 'rotate': {
      const a0 = Math.atan2(drag.start.y - drag.c.y, drag.start.x - drag.c.x), a1 = Math.atan2(p.y - drag.c.y, p.x - drag.c.x);
      let deg = ((a1 - a0) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      state.preview = { ids: drag.ids, m: around(rotM(deg), drag.c.x, drag.c.y) };
      (drag as any).deg = deg;
      break;
    }
    case 'marquee': state.marquee = { a: drag.start, b: p }; break;
    case 'draft': {
      let q = snapGrid(p, e);
      if (e.shiftKey && state.draft!.kind !== 'line') {
        const s = Math.max(Math.abs(q.x - drag.start.x), Math.abs(q.y - drag.start.y));
        q = { x: drag.start.x + Math.sign(q.x - drag.start.x || 1) * s, y: drag.start.y + Math.sign(q.y - drag.start.y || 1) * s };
      }
      state.draft!.b = q;
      break;
    }
    case 'pen': {
      const pt = state.pen!.points[state.pen!.points.length - 1];
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (Math.hypot(dx, dy) * state.cam.z > 2) { pt.out = { dx, dy }; pt.in = { dx: -dx, dy: -dy }; }
      break;
    }
    case 'point': state.pointPreview = { sp: drag.sp, i: drag.i, which: drag.which, p }; break;
  }
  invalidate();
});

canvas.addEventListener('pointerup', async () => {
  const d = drag;
  drag = null;
  if (!d) return;
  state.committing = true;
  switch (d.kind) {
    case 'move': {
      const m = state.preview?.m;
      if (m && (Math.abs(m.e) > 1e-6 || Math.abs(m.f) > 1e-6)) await run(api.op('node_move', { ids: d.ids, dx: r2(m.e), dy: r2(m.f) }));
      break;
    }
    case 'scale': {
      const l = (d as any).last;
      if (l) await run(api.op('node_transform', { ids: d.ids, scale: { x: l.sx, y: l.sy }, origin: { x: l.ox, y: l.oy } }));
      break;
    }
    case 'rotate': {
      const deg = (d as any).deg;
      if (deg) await run(api.op('node_transform', { ids: d.ids, rotate: deg, origin: d.c }));
      break;
    }
    case 'marquee': {
      const f = frame();
      if (f && state.marquee) {
        const a = state.marquee.a, b = state.marquee.b;
        const box = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
        if (box.maxX - box.minX > 1 || box.maxY - box.minY > 1) {
          const ids = marqueeSelect(f, box);
          state.selection = d.additive ? [...new Set([...state.selection, ...ids])] : ids;
        }
      }
      state.marquee = null;
      refreshPanels();
      break;
    }
    case 'draft': {
      const dr = state.draft!;
      state.draft = null;
      const x = Math.min(dr.a.x, dr.b.x), y = Math.min(dr.a.y, dr.b.y), w = Math.abs(dr.b.x - dr.a.x), h = Math.abs(dr.b.y - dr.a.y);
      if (Math.max(w, h) * state.cam.z < 3) { toast('Şekil çizmek için sürükleyin', 'info'); break; }
      const style = currentStyle();
      const res = dr.kind === 'line'
        ? await run(api.op<{ id: string }>('node_add_line', { x1: r2(dr.a.x), y1: r2(dr.a.y), x2: r2(dr.b.x), y2: r2(dr.b.y), style: { stroke: style.stroke === 'none' ? '#111111' : style.stroke, strokeWidth: style.strokeWidth } }))
        : await run(api.op<{ id: string }>(dr.kind === 'rect' ? 'node_add_rect' : 'node_add_ellipse', { x: r2(x), y: r2(y), width: r2(w), height: r2(h), style }));
      if (res) { state.selection = [res.result.id]; setTool('select'); }
      break;
    }
    case 'pen': state.pen!.dragging = false; break;
    case 'point': {
      const pp = state.pointPreview;
      state.pointPreview = null;
      const l = state.editPath ? loc(state.editPath) : null;
      if (pp && l && l.node.type === 'path') {
        const node = structuredClone(l.node);
        applyPointEdit(node, pp, invert(worldOf(l)));
        const q = node.subpaths[pp.sp].points[pp.i];
        await run(api.op('node_edit_handles', { id: l.node.id, edits: [{ action: 'set', subpath: pp.sp, index: pp.i, x: q.x, y: q.y, in: q.in ?? null, out: q.out ?? null }] }));
      }
      break;
    }
  }
  state.committing = false;
  state.preview = null;
  state.pointPreview = null;
  refreshPanels();
});

canvas.addEventListener('dblclick', (e) => {
  const r = canvas.getBoundingClientRect();
  const p = toFrame(e.clientX - r.left, e.clientY - r.top);
  if (state.tool === 'pen') { void finishPen(); return; }
  if (state.tool === 'select') {
    const id = pick(p, true);
    if (id) { const l = loc(id); if (l?.node.type === 'text') { openTextInput(e.clientX - r.left, e.clientY - r.top, p, l.node.id); return; } setTool('direct'); void enterPathEdit(id); }
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (e.ctrlKey || e.metaKey || !e.shiftKey && Math.abs(e.deltaY) > 0 && !e.deltaX && e.deltaMode === 0 && !(e as any).wheelDeltaX) {
    zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
  } else { state.cam.x -= e.deltaX; state.cam.y -= e.deltaY; invalidate(); }
}, { passive: false });

function zoomAt(sx: number, sy: number, k: number) {
  const z = Math.max(0.05, Math.min(64, state.cam.z * k));
  const f = z / state.cam.z;
  state.cam.x = sx - (sx - state.cam.x) * f;
  state.cam.y = sy - (sy - state.cam.y) * f;
  state.cam.z = z;
  updateZoomLabel();
  invalidate();
}
const updateZoomLabel = () => { $('zoom-label').textContent = `${Math.round(state.cam.z * 100)}%`; };

async function enterPathEdit(id: string) {
  const l = loc(id);
  if (!l) return;
  if (l.node.type === 'group' || l.node.type === 'text') { state.selection = [id]; refreshPanels(); return; }
  if (l.node.type !== 'path') {
    const r = await run(api.op('node_to_path', { ids: [id] }));
    if (!r) return;
    toast('Şekil düzenlenebilir path\'e çevrildi', 'info');
  }
  state.editPath = id;
  state.selection = [id];
  refreshPanels();
  invalidate();
}

async function finishPen() {
  const pen = state.pen;
  state.pen = null;
  invalidate();
  if (!pen || pen.points.length < 2) return;
  const style = currentStyle();
  const r = await run(api.op<{ id: string }>('node_add_path', {
    subpaths: [{ closed: pen.closed, points: pen.points.map((p) => ({ x: r2(p.x), y: r2(p.y), ...(p.in ? { in: { dx: r2(p.in.dx), dy: r2(p.in.dy) } } : {}), ...(p.out ? { out: { dx: r2(p.out.dx), dy: r2(p.out.dy) } } : {}) })) }],
    style: pen.closed ? style : { fill: 'none', stroke: style.stroke === 'none' ? '#111111' : style.stroke, strokeWidth: style.strokeWidth || 2 },
  }));
  if (r) state.selection = [r.result.id];
  refreshPanels();
}

function openTextInput(sx: number, sy: number, p: Point, editId?: string) {
  const input = $<HTMLInputElement>('text-input');
  const existing = editId ? (loc(editId)?.node as any) : null;
  input.hidden = false;
  input.style.left = `${sx}px`; input.style.top = `${sy - 14}px`;
  input.value = existing?.content ?? '';
  input.focus(); input.select();
  const done = async (commit: boolean) => {
    input.hidden = true;
    input.onkeydown = null; input.onblur = null;
    const v = input.value.trim();
    if (!commit || !v) return;
    if (existing) await run(api.op('node_update', { id: editId, props: { content: v } }));
    else {
      const s = currentStyle();
      const r = await run(api.op<{ id: string }>('node_add_text', { x: r2(p.x), y: r2(p.y), content: v, fontSize: 24, style: { fill: s.fill === 'none' ? '#111111' : s.fill } }));
      if (r) { state.selection = [r.result.id]; setTool('select'); }
    }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') void done(true); if (e.key === 'Escape') void done(false); e.stopPropagation(); };
  input.onblur = () => void done(true);
}

/** Yeni şekiller için varsayılan stil: seçili tek node'unkini, yoksa hoş bir varsayılanı kullan. */
let lastStyle = { fill: '#4f8cff', stroke: 'none', strokeWidth: 2 };
function currentStyle() { return { ...lastStyle }; }

// ———————————————————————————————— klavye

window.addEventListener('keydown', async (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Alt') altDown = true;
  if (e.key === ' ') { state.spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); return; }
  if (mod && k === 'z') { e.preventDefault(); await cmd(e.shiftKey ? 'redo' : 'undo'); return; }
  if (mod && k === 'y') { e.preventDefault(); await cmd('redo'); return; }
  if (mod && k === 's') { e.preventDefault(); await cmd('save'); return; }
  if (mod && k === '0') { e.preventDefault(); fit(); return; }
  if (mod && k === 'd') { e.preventDefault(); await action('duplicate'); return; }
  if (mod && k === 'g') { e.preventDefault(); await action(e.shiftKey ? 'ungroup' : 'group'); return; }
  if (mod && k === 'a') { e.preventDefault(); const f = frame(); if (f) { state.selection = marqueeSelect(f, { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }); refreshPanels(); } return; }
  if (mod) return;
  if (k === 'escape') {
    if (state.pen) { if (state.pen.points.length > 1) await finishPen(); else state.pen = null; }
    state.selection = []; state.editPath = null; state.draft = null; setTool('select'); refreshPanels(); return;
  }
  if (k === 'enter' && state.pen) { await finishPen(); return; }
  if ((k === 'delete' || k === 'backspace') && state.selection.length) { await action('delete'); return; }
  if (k.startsWith('arrow') && state.selection.length) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const dx = k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0, dy = k === 'arrowup' ? -s : k === 'arrowdown' ? s : 0;
    await run(api.op('node_move', { ids: state.selection, dx, dy }));
    return;
  }
  const tools: Record<string, Tool> = { v: 'select', a: 'direct', h: 'hand', r: 'rect', o: 'ellipse', e: 'ellipse', l: 'line', p: 'pen', t: 'text' };
  if (tools[k]) { setTool(tools[k]); return; }
  if (k === '+' || k === '=') zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.25);
  if (k === '-') zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 0.8);
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { state.spaceDown = false; canvas.style.cursor = 'default'; }
  if (e.key === 'Alt') altDown = false;
});

function setTool(t: Tool) {
  if (state.pen && t !== 'pen') void finishPen();
  state.tool = t;
  if (t !== 'direct') state.editPath = null;
  document.querySelectorAll<HTMLButtonElement>('#toolbar button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  const hints: Record<Tool, string> = {
    select: 'Tıkla: seç · Shift: ekle · Alt+sürükle: kopyala · köşeler: ölçekle (Shift oranlı) · üst daire: döndür · çift tık: nokta düzenle',
    direct: 'Çapa/handle sürükle · Alt: handle\'ı bağımsız taşı · Esc: çık',
    hand: 'Sürükle: kaydır', rect: 'Sürükle: dikdörtgen · Shift: kare', ellipse: 'Sürükle: elips · Shift: daire', line: 'Sürükle: çizgi',
    pen: 'Tıkla: köşe · Sürükle: eğri · ilk noktaya tıkla: kapat · Enter/çift tık: bitir', text: 'Tıkla: metin ekle',
  };
  $('hint').textContent = hints[t];
  invalidate();
}
document.querySelectorAll<HTMLButtonElement>('#toolbar button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));

// ———————————————————————————————— komutlar

async function cmd(c: string) {
  switch (c) {
    case 'undo': await run(api.rpc('undo', { force: true })); break;
    case 'redo': await run(api.rpc('redo', { force: true })); break;
    case 'fit': fit(); break;
    case 'zoom-in': zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.25); break;
    case 'zoom-out': zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 0.8); break;
    case 'save': { const r = await run(api.rpc('doc_save', {})); if (r) toast(`Kaydedildi: ${r.path}`, 'info'); break; }
    case 'export-svg': case 'export-png': case 'export-pdf': {
      const fmt = c.slice(7) as 'svg' | 'png' | 'pdf';
      const bridge = (window as any).masvector;
      if (bridge?.saveExport) { const p = await bridge.saveExport(fmt, api.exportUrl(fmt)); if (p) toast(`Dışa aktarıldı: ${p}`, 'info'); }
      else { const a = document.createElement('a'); a.href = api.exportUrl(fmt, fmt === 'png' ? { scale: '2' } : {}); a.download = `${state.doc?.title ?? 'masvector'}.${fmt}`; a.click(); }
      break;
    }
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => b.addEventListener('click', () => void cmd(b.dataset.cmd!)));

async function action(a: string, extra: Record<string, unknown> = {}) {
  const ids = state.selection;
  if (!ids.length && a !== 'layer') return;
  let r: any;
  switch (a) {
    case 'delete': r = await run(api.op('node_delete', { ids })); if (r) state.selection = []; break;
    case 'duplicate': r = await run(api.op('duplicate', { ids, dx: 10, dy: 10 })); if (r) state.selection = r.result.map((x: any) => x.id); break;
    case 'group': r = await run(api.op('group', { ids })); if (r) state.selection = [r.result.id]; break;
    case 'ungroup': r = await run(api.op('ungroup', { id: ids[0] })); if (r) state.selection = r.result.released; break;
    case 'union': case 'subtract': case 'intersect': case 'exclude':
      r = await run(api.op(`boolean_${a}`, { ids })); if (r) state.selection = [r.result.id]; break;
    case 'outline': r = await run(api.op('path_outline_stroke', { id: ids[0] })); if (r) state.selection = [r.result.id]; break;
    case 'front': case 'back': for (const id of ids) await run(api.op('node_reorder', { id, to: a })); break;
    case 'align': await run(api.op('align_to', { ids, align: extra.align, to: ids.length > 1 ? 'selection' : 'frame' })); break;
  }
  refreshPanels();
}

// ———————————————————————————————— paneller

function refreshPanels() {
  renderLayers();
  renderProps();
  const n = state.selection.length;
  $('sel-info').textContent = n === 0 ? 'seçim yok' : n === 1 ? `${loc(state.selection[0])?.node.type ?? ''} · ${state.selection[0]}` : `${n} node seçili`;
  invalidate();
}

const TYPE_ICON: Record<string, string> = { path: '✎', rect: '▭', ellipse: '◯', line: '╱', text: 'T', group: '▣' };

function renderLayers() {
  const el = $('layers');
  const f = frame();
  el.textContent = '';
  if (!f) return;
  const add = (n: VNode, depth: number) => {
    const row = document.createElement('div');
    row.className = `item${n.type === 'group' && n.isLayer ? ' layer' : ''}${state.selection.includes(n.id) ? ' selected' : ''}${n.visible ? '' : ' hidden'}`;
    row.style.paddingLeft = `${4 + depth * 12}px`;
    const icon = document.createElement('span'); icon.className = 'type'; icon.textContent = n.type === 'group' && n.isLayer ? '☰' : TYPE_ICON[n.type];
    const name = document.createElement('span'); name.className = 'name'; name.textContent = n.name ?? (n.type === 'text' ? `“${n.content}”` : n.id);
    name.title = n.id;
    const eye = document.createElement('button'); eye.textContent = '👁'; eye.title = 'Görünürlük'; if (!n.visible) eye.classList.add('off');
    eye.onclick = (ev) => { ev.stopPropagation(); void run(api.op('layer_toggle', { id: n.id })); };
    const lock = document.createElement('button'); lock.textContent = n.locked ? '🔒' : '🔓'; lock.title = 'Kilit'; if (!n.locked) lock.classList.add('off');
    lock.onclick = (ev) => { ev.stopPropagation(); void run(api.op('layer_lock', { id: n.id })); };
    row.append(icon, name, eye, lock);
    row.onclick = (ev) => {
      if (n.type === 'group' && n.isLayer) return;
      state.selection = ev.shiftKey ? [...new Set([...state.selection, n.id])] : [n.id];
      refreshPanels();
    };
    el.append(row);
    if (n.type === 'group') for (let i = n.children.length - 1; i >= 0; i--) add(n.children[i], depth + 1);
  };
  for (let i = f.nodes.length - 1; i >= 0; i--) add(f.nodes[i], 0);
  if (!f.nodes.length) el.innerHTML = '<div class="empty">Boş belge — araç çubuğundan çizin ya da bir ajan bağlayın.</div>';
}

function colorField(label: string, value: unknown, onChange: (v: string) => void) {
  const row = document.createElement('div'); row.className = 'row';
  const l = document.createElement('label'); l.textContent = label;
  const wrap = document.createElement('div'); wrap.className = 'color';
  const isGrad = typeof value === 'object' && value !== null;
  const txt = document.createElement('input'); txt.type = 'text';
  txt.value = isGrad ? `${(value as any).type} gradyan` : String(value ?? 'none');
  const pick = document.createElement('input'); pick.type = 'color';
  pick.value = /^#[0-9a-f]{6}$/i.test(txt.value) ? txt.value : '#000000';
  pick.oninput = () => { txt.value = pick.value; };
  pick.onchange = () => onChange(pick.value);
  txt.onchange = () => onChange(txt.value.trim());
  wrap.append(pick, txt);
  row.append(l, wrap);
  return row;
}

function numField(label: string, values: [string, number | undefined, (v: number) => void][]) {
  const row = document.createElement('div'); row.className = 'row';
  const l = document.createElement('label'); l.textContent = label;
  const pair = document.createElement('div'); pair.className = 'pair';
  for (const [ph, v, cb] of values) {
    const i = document.createElement('input'); i.type = 'number'; i.step = 'any'; i.placeholder = ph; i.title = ph;
    if (v !== undefined) i.value = String(r2(v));
    i.onchange = () => { const n = Number(i.value); if (Number.isFinite(n)) cb(n); };
    pair.append(i);
  }
  row.append(l, pair);
  return row;
}

function renderProps() {
  const el = $('props');
  el.textContent = '';
  const ids = state.selection.filter((id) => loc(id));
  if (!ids.length) {
    const f = frame();
    if (!f) return;
    el.append(numField('Frame', [['genişlik', f.w, (w) => void run(api.op('frame_update', { id: f.id, w }))], ['yükseklik', f.h, (h) => void run(api.op('frame_update', { id: f.id, h }))]]));
    el.append(colorField('Arka plan', f.background ?? 'none', (v) => void run(api.op('frame_update', { id: f.id, background: v }))));
    const grid = state.doc!.pages[0].grid;
    const g = document.createElement('div'); g.className = 'row';
    g.innerHTML = `<label>Izgara</label><div class="pair"><input type="number" min="1" value="${grid.size}" title="adım"/><select><option value="0">kapalı</option><option value="1">yasla</option></select></div>`;
    const [size, sel] = [g.querySelector('input')!, g.querySelector('select')!];
    sel.value = grid.enabled ? '1' : '0';
    size.onchange = () => { grid.size = Number(size.value) || 8; void run(api.op('snap_to_grid', { ids: [], size: grid.size })); };
    sel.onchange = () => { grid.enabled = sel.value === '1'; };
    el.append(g);
    return;
  }
  const first = loc(ids[0])!.node;
  const b = selectionBBox(ids)!;
  if (ids.length === 1) {
    const nameRow = document.createElement('div'); nameRow.className = 'row';
    nameRow.innerHTML = '<label>Ad</label>';
    const ni = document.createElement('input'); ni.type = 'text'; ni.value = first.name ?? ''; ni.placeholder = first.id;
    ni.onchange = () => void run(api.op('node_update', { id: first.id, props: { name: ni.value } }));
    nameRow.append(ni); el.append(nameRow);
  }
  if (b) {
    el.append(numField('Konum', [['x', b.minX, (x) => void run(api.op('node_move', { ids, to: { x, y: b.minY } }))], ['y', b.minY, (y) => void run(api.op('node_move', { ids, to: { x: b.minX, y } }))]]));
    el.append(numField('Boyut', [
      ['G', b.maxX - b.minX, (w) => void run(api.op('node_transform', { ids, scale: { x: w / Math.max(1e-6, b.maxX - b.minX), y: 1 }, origin: { x: b.minX, y: b.minY } }))],
      ['Y', b.maxY - b.minY, (h) => void run(api.op('node_transform', { ids, scale: { x: 1, y: h / Math.max(1e-6, b.maxY - b.minY) }, origin: { x: b.minX, y: b.minY } }))],
    ]));
  }
  if (first.type !== 'group') {
    const setStyle = (style: Record<string, unknown>) => { Object.assign(lastStyle, style); void run(api.op('node_set_style', { ids, style })); };
    el.append(colorField('Dolgu', first.style.fill, (v) => setStyle({ fill: v })));
    el.append(colorField('Kontur', first.style.stroke, (v) => setStyle({ stroke: v })));
    el.append(numField('Kontur/Opak', [['kalınlık', first.style.strokeWidth, (v) => setStyle({ strokeWidth: Math.max(0, v) })], ['opaklık 0–1', first.style.opacity, (v) => setStyle({ opacity: Math.min(1, Math.max(0, v)) })]]));
    const br = document.createElement('div'); br.className = 'row';
    br.innerHTML = '<label>Karışım</label>';
    const sel = document.createElement('select');
    for (const m of ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion']) sel.add(new Option(m, m));
    sel.value = first.style.blendMode;
    sel.onchange = () => setStyle({ blendMode: sel.value });
    br.append(sel); el.append(br);
  }
  if (first.type === 'text' && ids.length === 1) {
    el.append(numField('Yazı', [['boyut', first.fontSize, (fontSize) => void run(api.op('node_update', { id: first.id, props: { fontSize } }))], ['x', first.x, (x) => void run(api.op('node_update', { id: first.id, props: { x } }))]]));
  }
  if (first.type === 'rect' && ids.length === 1) {
    el.append(numField('Köşe', [['rx', first.rx ?? 0, (rx) => void run(api.op('node_update', { id: first.id, props: { rx, ry: rx } }))], ['—', undefined, () => {}]]));
  }
  const acts = document.createElement('div'); acts.className = 'actions';
  const btn = (label: string, title: string, fn: () => void, cls = '') => { const x = document.createElement('button'); x.textContent = label; x.title = title; x.className = cls; x.onclick = fn; acts.append(x); };
  if (ids.length >= 2) {
    btn('∪ Birleştir', 'boolean_union', () => void action('union'));
    btn('− Çıkar', 'boolean_subtract (ilk seçilenden)', () => void action('subtract'));
    btn('∩ Kesişim', 'boolean_intersect', () => void action('intersect'));
    btn('⊕ Hariç', 'boolean_exclude', () => void action('exclude'));
    btn('Grupla', 'Ctrl+G', () => void action('group'));
  }
  if (ids.length === 1 && first.type === 'group' && !first.isLayer) btn('Grubu çöz', 'Ctrl+Shift+G', () => void action('ungroup'));
  if (ids.length === 1 && first.type !== 'group' && first.type !== 'text' && first.style.stroke !== 'none') btn('Kontur→Dolgu', 'path_outline_stroke', () => void action('outline'));
  for (const [al, lbl] of [['left', '⇤'], ['hcenter', '↔'], ['right', '⇥'], ['top', '⤒'], ['vcenter', '↕'], ['bottom', '⤓']] as const)
    btn(lbl, `Hizala: ${al} (${ids.length > 1 ? 'seçime' : 'frame\'e'})`, () => void action('align', { align: al }));
  btn('Öne', 'En öne', () => void action('front'));
  btn('Arkaya', 'En arkaya', () => void action('back'));
  btn('Kopyala', 'Ctrl+D', () => void action('duplicate'));
  btn('Sil', 'Delete', () => void action('delete'), 'danger');
  el.append(acts);
}

$('add-layer').onclick = async () => {
  const count = frame()?.nodes.filter((n) => n.type === 'group' && n.isLayer).length ?? 0;
  await run(api.op('layer_create', { name: `Katman ${count + 1}` }));
};

// ———————————————————————————————— etkinlik akışı ve bağlantı

function addActivity(agent: string, label: string) {
  const li = document.createElement('li');
  const who = document.createElement('span'); who.className = 'who'; who.textContent = agent; who.style.color = colorOf(agent);
  const what = document.createElement('span'); what.className = 'what'; what.textContent = label; what.title = label;
  const when = document.createElement('span'); when.className = 'when'; when.textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.append(who, what, when);
  const ol = $('activity');
  ol.prepend(li);
  while (ol.children.length > 80) ol.lastElementChild!.remove();
}

function setLock(l: LockInfo) {
  state.lock = l;
  const b = $('lock-badge');
  b.hidden = !l.held;
  if (l.held) b.textContent = `🔒 ${l.agentId}`;
}

function setDoc(doc: VDocument) {
  state.doc = doc;
  if (state.committing) { state.preview = null; state.pointPreview = null; }
  state.selection = state.selection.filter((id) => locate(doc, id));
  if (state.editPath && !locate(doc, state.editPath)) state.editPath = null;
  $('doc-title').textContent = doc.title;
  $('version').textContent = `v${doc.version}`;
  if (!state.fitted) { state.fitted = true; fit(); }
  refreshPanels();
}

api.connect({
  hello: (doc, lock) => { setDoc(doc); setLock(lock); },
  change: (e) => {
    const prevFrame = state.doc?.pages[0]?.frames[0];
    setDoc(e.document);
    const f = frame();
    if (prevFrame && f && (prevFrame.w !== f.w || prevFrame.h !== f.h || prevFrame.id !== f.id)) fit();
    addActivity(e.agentId, e.label);
  },
  lock: setLock,
  status: (on) => {
    $('conn').className = `dot ${on ? 'on' : 'off'}`;
    $('conn-label').textContent = on ? 'bağlı' : 'bağlantı yok';
    $('offline').hidden = on;
  },
});
$('server-url').textContent = serverBase;

new ResizeObserver(resize).observe(canvas);
resize();
setTool('select');
requestAnimationFrame(draw);
