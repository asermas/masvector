import { createCanvas } from '@napi-rs/canvas';
import { nodeImage, type DecodedImage } from './png.js';

/** RGBA pikseller → PNG data URI. */
export function rgbaToDataUri(px: Uint8ClampedArray | Buffer, w: number, h: number): string {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  const id = x.createImageData(w, h);
  id.data.set(px);
  x.putImageData(id, 0, 0);
  return `data:image/png;base64,${c.toBuffer('image/png').toString('base64')}`;
}

/** Çözülmüş görseli (gerekirse yeniden örnekleyerek) RGBA'ya al. */
export function resampleRGBA(img: DecodedImage, w = img.width, h = img.height): Uint8ClampedArray {
  if (w === img.width && h === img.height) return img.rgba;
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(img.canvas, 0, 0, w, h);
  return x.getImageData(0, 0, w, h).data;
}

/**
 * Yumuşak maske birleştirme (SVG luminance mask → alfa): alfa = içerik.a × lum(maske) × maske.a.
 * pdftocairo, PDF SMask'lı görselleri bu kalıpla yazar.
 */
export function combineMaskImages(contentHref: string, maskHref: string): string | null {
  const ci = nodeImage(contentHref), mi = nodeImage(maskHref);
  if (!ci || !mi) return null;
  const w = ci.width, h = ci.height;
  const c = ci.rgba;
  const m = resampleRGBA(mi, w, h);
  const out = new Uint8ClampedArray(c.length);
  for (let i = 0; i < c.length; i += 4) {
    const lum = (0.2126 * m[i] + 0.7152 * m[i + 1] + 0.0722 * m[i + 2]) / 255;
    out[i] = c[i]; out[i + 1] = c[i + 1]; out[i + 2] = c[i + 2];
    out[i + 3] = Math.round(c[i + 3] * lum * (m[i + 3] / 255));
  }
  return rgbaToDataUri(out, w, h);
}
