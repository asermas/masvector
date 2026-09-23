import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { readImageSync } from '@neplex/vectorizer';
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

export interface DecodedImage { width: number; height: number; rgba: Uint8ClampedArray; canvas: Canvas }
const imageCache = new Map<string, DecodedImage | null>();

/** Kodlanmış görseli (PNG/JPEG/WebP/GIF/BMP/TIFF) senkron RGBA'ya çöz. */
export function decodeImageBuffer(buf: Buffer): DecodedImage | null {
  try {
    const d = readImageSync(buf);
    if (!d.width || !d.height) return null;
    const rgba = new Uint8ClampedArray(d.pixels.buffer, d.pixels.byteOffset, d.pixels.length);
    const canvas = createCanvas(d.width, d.height);
    const ctx = canvas.getContext('2d');
    const id = ctx.createImageData(d.width, d.height);
    id.data.set(rgba);
    ctx.putImageData(id, 0, 0);
    return { width: d.width, height: d.height, rgba, canvas };
  } catch { return null; }
}

/** data URI'yi senkron çöz — sonuç önbelleklenir. (napi `Image.src` çözümü asenkron olduğundan kullanılmaz.) */
export function nodeImage(href: string): DecodedImage | null {
  let img = imageCache.get(href);
  if (img !== undefined) return img;
  const m = /^data:[^;,]+(;base64)?,(.*)$/s.exec(href);
  img = m ? decodeImageBuffer(m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]))) : null;
  if (imageCache.size > 64) imageCache.delete(imageCache.keys().next().value!);
  imageCache.set(href, img);
  return img;
}

/** Headless PNG render (ajant önizlemesi ve export). */
export function renderPNG(doc: VDocument, o: PngOptions = {}): { png: Buffer; width: number; height: number; scale: number } {
  const r = renderCanvas(doc, o);
  return { png: r.canvas.toBuffer('image/png'), width: r.width, height: r.height, scale: r.scale };
}

/** Belgeyi RGBA piksellere render et (karşılaştırma için). `width/height` verilirse tam o boyutta. */
export function renderRGBA(doc: VDocument, o: PngOptions & { width?: number; height?: number } = {}) {
  const r = renderCanvas(doc, o);
  const ctx = r.canvas.getContext('2d');
  return { rgba: ctx.getImageData(0, 0, r.width, r.height).data, width: r.width, height: r.height, scale: r.scale };
}

function renderCanvas(doc: VDocument, o: PngOptions & { width?: number; height?: number } = {}) {
  const { frame } = findFrame(doc, o.frameId);
  const r = o.region ?? { x: 0, y: 0, width: frame.w, height: frame.h };
  if (r.width <= 0 || r.height <= 0) throw new VectorError('INVALID_ARGUMENT', 'Bölge boyutu pozitif olmalı');
  let s = o.scale ?? 1;
  if (o.maxSize) s = Math.min(o.maxSize / r.width, o.maxSize / r.height);
  let W = Math.max(1, Math.round(r.width * s)), H = Math.max(1, Math.round(r.height * s));
  let sx = s, sy = s;
  if (o.width && o.height) { W = o.width; H = o.height; sx = W / r.width; sy = H / r.height; s = Math.sqrt(sx * sy); }
  if (W * H > 64e6) throw new VectorError('INVALID_ARGUMENT', `Çıktı çok büyük (${W}×${H})`);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d') as unknown as Ctx;
  const view = multiply(scale(sx, sy), translate(-r.x, -r.y));
  drawFrame(ctx, frame, view, {
    width: W, height: H, background: o.background,
    getImage: (href) => (nodeImage(href)?.canvas ?? null) as unknown as CanvasImageSource | null,
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
  return { canvas, width: W, height: H, scale: s };
}
