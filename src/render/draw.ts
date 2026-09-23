import type { Frame, Matrix, Paint, Style, SubPath, VNode } from '../common/types.js';
import { segments } from '../math/bezier.js';
import { nodeSubPaths, textBox } from '../math/geometry.js';
import { meanScale, multiply } from '../math/matrix.js';

/** Tarayıcı CanvasRenderingContext2D ile @napi-rs/canvas bağlamının ortak alt kümesi. */
export type Ctx = CanvasRenderingContext2D;

export interface DrawOptions {
  /** Grup opaklığı/filtre için ara katman üretici (yoksa alfa çarpımıyla yaklaşık çizilir). */
  createLayer?: (w: number, h: number) => { ctx: Ctx; canvas: unknown };
  /** Hedef tuval piksel boyutu (katman için). */
  width: number;
  height: number;
}

const COMPOSITE: Record<string, string> = { normal: 'source-over' };

function tracePath(ctx: Ctx, sps: SubPath[]) {
  ctx.beginPath();
  for (const sp of sps) {
    if (!sp.points.length) continue;
    ctx.moveTo(sp.points[0].x, sp.points[0].y);
    for (const c of segments(sp)) {
      if (c.p1.x === c.p0.x && c.p1.y === c.p0.y && c.p2.x === c.p3.x && c.p2.y === c.p3.y) ctx.lineTo(c.p3.x, c.p3.y);
      else ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
    }
    if (sp.closed) ctx.closePath();
  }
}

function toCanvasPaint(ctx: Ctx, p: Paint): string | CanvasGradient | null {
  if (typeof p === 'string') return p === 'none' || p === 'transparent' ? null : p;
  const g = p.type === 'linear'
    ? ctx.createLinearGradient(p.x1, p.y1, p.x2, p.y2)
    : ctx.createRadialGradient(p.fx ?? p.cx, p.fy ?? p.cy, 0, p.cx, p.cy, p.r);
  for (const s of p.stops) g.addColorStop(s.offset, s.opacity !== undefined && s.opacity < 1 ? withAlpha(s.color, s.opacity) : s.color);
  return g;
}

/** Renk metnine alfa ekle (#rgb/#rrggbb/rgb()). Diğerlerinde olduğu gibi döner. */
export function withAlpha(color: string, a: number): string {
  let m = /^#([0-9a-f]{3})$/i.exec(color);
  if (m) color = '#' + m[1].split('').map((c) => c + c).join('');
  m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m) {
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }
  const r = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (r) {
    const parts = r[1].split(/[\s,/]+/).filter(Boolean);
    const base = parts.length > 3 ? parseFloat(parts[3]) : 1;
    return `rgba(${parts.slice(0, 3).join(',')},${base * a})`;
  }
  return color;
}

function cssFilter(style: Style, viewScale: number): string {
  if (!style.filters.length) return 'none';
  return style.filters.map((f) => f.type === 'blur'
    ? `blur(${(f.radius * viewScale) / 2}px)`
    : `drop-shadow(${f.dx * viewScale}px ${f.dy * viewScale}px ${(f.blur * viewScale) / 2}px ${f.color})`).join(' ');
}

const setM = (ctx: Ctx, m: Matrix) => ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);

function drawLeaf(ctx: Ctx, n: Exclude<VNode, { type: 'group' }>, m: Matrix, alpha: number) {
  const s = n.style;
  setM(ctx, m);
  ctx.globalCompositeOperation = (COMPOSITE[s.blendMode] ?? s.blendMode) as GlobalCompositeOperation;
  const vs = meanScale(m);
  const f = cssFilter(s, vs);
  if ('filter' in ctx) (ctx as any).filter = f;

  if (n.type === 'text') {
    ctx.font = `${n.fontWeight ?? 'normal'} ${n.fontSize}px ${n.fontFamily}`;
    ctx.textAlign = n.textAnchor === 'middle' ? 'center' : n.textAnchor === 'end' ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    const fill = toCanvasPaint(ctx, s.fill);
    if (fill) { ctx.globalAlpha = alpha * s.opacity * (s.fillOpacity ?? 1); ctx.fillStyle = fill; ctx.fillText(n.content, n.x, n.y); }
    const stroke = toCanvasPaint(ctx, s.stroke);
    if (stroke && s.strokeWidth > 0) {
      ctx.globalAlpha = alpha * s.opacity * (s.strokeOpacity ?? 1);
      ctx.strokeStyle = stroke; ctx.lineWidth = s.strokeWidth; ctx.strokeText(n.content, n.x, n.y);
    }
    return;
  }

  tracePath(ctx, nodeSubPaths(n));
  if (n.type !== 'line') {
    const fill = toCanvasPaint(ctx, s.fill);
    if (fill) {
      ctx.globalAlpha = alpha * s.opacity * (s.fillOpacity ?? 1);
      ctx.fillStyle = fill;
      ctx.fill(n.type === 'path' ? n.fillRule : 'nonzero');
    }
  }
  const stroke = toCanvasPaint(ctx, s.stroke);
  if (stroke && s.strokeWidth > 0) {
    ctx.globalAlpha = alpha * s.opacity * (s.strokeOpacity ?? 1);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = s.strokeWidth;
    ctx.lineCap = s.strokeLinecap ?? 'butt';
    ctx.lineJoin = s.strokeLinejoin ?? 'miter';
    ctx.setLineDash(s.strokeDasharray ?? []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function drawNode(ctx: Ctx, n: VNode, parent: Matrix, opts: DrawOptions, alpha = 1): void {
  if (!n.visible) return;
  const m = multiply(parent, n.transform);
  if (n.type !== 'group') {
    ctx.save();
    drawLeaf(ctx, n, m, alpha);
    ctx.restore();
    return;
  }
  const s = n.style;
  const needsLayer = s.opacity < 1 || s.blendMode !== 'normal' || s.filters.length > 0;
  if (needsLayer && opts.createLayer) {
    const layer = opts.createLayer(opts.width, opts.height);
    for (const c of n.children) drawNode(layer.ctx, c, m, opts, 1);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha * s.opacity;
    ctx.globalCompositeOperation = (COMPOSITE[s.blendMode] ?? s.blendMode) as GlobalCompositeOperation;
    if ('filter' in ctx) (ctx as any).filter = cssFilter(s, meanScale(m));
    ctx.drawImage(layer.canvas as CanvasImageSource, 0, 0);
    ctx.restore();
    return;
  }
  for (const c of n.children) drawNode(ctx, c, m, opts, alpha * s.opacity);
}

/** Frame'i `view` matrisiyle (frame uzayı → piksel) çiz. */
export function drawFrame(ctx: Ctx, frame: Frame, view: Matrix, opts: DrawOptions & { background?: boolean }) {
  ctx.save();
  setM(ctx, view);
  if (opts.background !== false && frame.background && frame.background !== 'none') {
    ctx.fillStyle = frame.background;
    ctx.fillRect(0, 0, frame.w, frame.h);
  }
  ctx.restore();
  for (const n of frame.nodes) drawNode(ctx, n, view, opts);
}

export { textBox };
