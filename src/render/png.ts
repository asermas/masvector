import { createCanvas } from '@napi-rs/canvas';
import type { VDocument } from '../common/types.js';
import { findFrame } from '../model/scene.js';
import { drawFrame, type Ctx } from './draw.js';
import { multiply, scale, translate } from '../math/matrix.js';
import { VectorError } from '../common/errors.js';

export interface PngOptions {
  frameId?: string;
  /** Piksel/birim. `maxSize` verilirse en uzun kenar ona sığdırılır. */
  scale?: number;
  maxSize?: number;
  background?: boolean;
  /** İsteğe bağlı bölge (frame uzayında) — yakın plan önizleme için. */
  region?: { x: number; y: number; width: number; height: number };
  /** Kılavuz ızgara çiz (ajantın konum okuması için). */
  grid?: number;
}

/** Headless PNG render (ajant önizlemesi ve export). */
export function renderPNG(doc: VDocument, o: PngOptions = {}): { png: Buffer; width: number; height: number; scale: number } {
  const { frame } = findFrame(doc, o.frameId);
  const r = o.region ?? { x: 0, y: 0, width: frame.w, height: frame.h };
  if (r.width <= 0 || r.height <= 0) throw new VectorError('INVALID_ARGUMENT', 'Bölge boyutu pozitif olmalı');
  let s = o.scale ?? 1;
  if (o.maxSize) s = Math.min(o.maxSize / r.width, o.maxSize / r.height);
  const W = Math.max(1, Math.round(r.width * s)), H = Math.max(1, Math.round(r.height * s));
  if (W * H > 64e6) throw new VectorError('INVALID_ARGUMENT', `Çıktı çok büyük (${W}×${H})`);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d') as unknown as Ctx;
  const view = multiply(scale(s), translate(-r.x, -r.y));
  drawFrame(ctx, frame, view, {
    width: W, height: H, background: o.background,
    createLayer: (w, h) => { const c = createCanvas(w, h); return { canvas: c, ctx: c.getContext('2d') as unknown as Ctx }; },
  });
  if (o.grid && o.grid > 0) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = 'rgba(255,0,128,0.25)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,0,128,0.7)';
    ctx.font = '10px sans-serif';
    for (let x = Math.ceil(r.x / o.grid) * o.grid; x <= r.x + r.width; x += o.grid) {
      const px = Math.round((x - r.x) * s) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
      ctx.fillText(String(x), px + 2, 10);
    }
    for (let y = Math.ceil(r.y / o.grid) * o.grid; y <= r.y + r.height; y += o.grid) {
      const py = Math.round((y - r.y) * s) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
      ctx.fillText(String(y), 2, py - 2);
    }
    ctx.restore();
  }
  return { png: canvas.toBuffer('image/png'), width: W, height: H, scale: s };
}
