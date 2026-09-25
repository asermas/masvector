import type { GroupNode, PathNode, SubPath } from '../common/types.js';
import { defaultStyle, newId } from '../common/ids.js';
import type { DecodedImage } from '../render/png.js';
import type { TraceResult } from './trace.js';

// Piksel-birebir vektör: sert kenarlı piksel grafikleri (piksel sanatı, 1-bit titreşimli görseller, ince desenler,
// çok küçük ikonlar) için. Her TAM renk bir path; pikseller önce satır koşularına, sonra aynı x aralığındaki
// ardışık koşular dikdörtgenlere birleştirilir. Yumuşatma/uydurma yok: render kaynakla piksel piksel aynıdır.

const h2 = (v: number) => v.toString(16).padStart(2, '0');

/** Görselin tam renk sayısı (saydam hariç); `limit`i aşınca erken döner. */
export function exactColorCount(img: DecodedImage, limit: number): number {
  const seen = new Set<number>();
  const px = img.rgba;
  for (let p = 0; p < img.width * img.height; p++) {
    if (px[p * 4 + 3] < 8) continue;
    seen.add(((px[p * 4] << 24) | (px[p * 4 + 1] << 16) | (px[p * 4 + 2] << 8) | px[p * 4 + 3]) >>> 0);
    if (seen.size > limit) return seen.size;
  }
  return seen.size;
}

/** Komşusuyla (sağ/alt) TAM rengi farklı piksel oranı: dama, titreşim (dither) gibi desenlerde yüksek. */
export function pixelEdgeDensity(img: DecodedImage): number {
  const { width: W, height: H, rgba } = img;
  let diff = 0, tot = 0;
  const step = Math.max(1, Math.floor((W * H) / 250_000));
  for (let p = 0; p < W * H; p += step) {
    const x = p % W;
    for (const q of [x < W - 1 ? p + 1 : -1, p + W < W * H ? p + W : -1]) {
      if (q < 0) continue;
      tot++;
      if (rgba[p * 4] !== rgba[q * 4] || rgba[p * 4 + 1] !== rgba[q * 4 + 1] || rgba[p * 4 + 2] !== rgba[q * 4 + 2] || rgba[p * 4 + 3] !== rgba[q * 4 + 3]) diff++;
    }
  }
  return tot ? diff / tot : 0;
}

export function pixelTrace(img: DecodedImage): TraceResult {
  const t0 = Date.now();
  const { width: W, height: H, rgba } = img;
  const key = (p: number) => ((rgba[p * 4] << 24) | (rgba[p * 4 + 1] << 16) | (rgba[p * 4 + 2] << 8) | rgba[p * 4 + 3]) >>> 0;
  const idx = new Map<number, number>();
  const lab = new Int32Array(W * H);
  const area: number[] = [];
  for (let p = 0; p < W * H; p++) {
    if (rgba[p * 4 + 3] < 8) { lab[p] = -1; continue; }
    const k = key(p);
    let i = idx.get(k);
    if (i === undefined) { i = idx.size; idx.set(k, i); area.push(0); }
    lab[p] = i; area[i]++;
  }
  const colors = [...idx.keys()];
  const rects: SubPath[][] = colors.map(() => []);
  // Satır koşuları; bir önceki satırda aynı [x0,x1) ve renkte açık dikdörtgen varsa uzat
  let open = new Map<string, { x0: number; x1: number; y0: number; c: number }>();
  const close = (r: { x0: number; x1: number; y0: number; c: number }, y1: number) => rects[r.c].push({
    closed: true, points: [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: y1 }, { x: r.x0, y: y1 }],
  });
  for (let y = 0; y < H; y++) {
    const next = new Map<string, { x0: number; x1: number; y0: number; c: number }>();
    for (let x = 0; x < W;) {
      const c = lab[y * W + x];
      let x1 = x + 1;
      while (x1 < W && lab[y * W + x1] === c) x1++;
      if (c >= 0) {
        const k = `${x},${x1},${c}`;
        const r = open.get(k);
        if (r) { open.delete(k); next.set(k, r); } else next.set(k, { x0: x, x1, y0: y, c });
      }
      x = x1;
    }
    for (const r of open.values()) close(r, y);
    open = next;
  }
  for (const r of open.values()) close(r, H);
  // Kapsama büyükten küçüğe; en büyük renk kenarları kaplıyorsa frame arka planı olur
  const order = colors.map((_, i) => i).sort((a, b) => area[b] - area[a]);
  const hexOf = (k: number) => { const r = k >>> 24, g = (k >>> 16) & 255, b = (k >>> 8) & 255, a = k & 255; return { fill: `#${h2(r)}${h2(g)}${h2(b)}`, op: a >= 252 ? undefined : Math.round((a / 255) * 1000) / 1000 }; };
  let border = 0, bTotal = 0;
  const bg = order[0];
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { bTotal++; if (lab[y * W + x] === bg) border++; }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { bTotal++; if (lab[y * W + x] === bg) border++; }
  const bgC = bg !== undefined ? hexOf(colors[bg]) : null;
  const useBg = !!bgC && bgC.op === undefined && !lab.includes(-1) && border / bTotal >= 0.6;
  const layers: PathNode[] = [];
  const palette: TraceResult['palette'] = [];
  let anchors = 0;
  for (const c of order) {
    if (useBg && c === bg) continue;
    const { fill, op } = hexOf(colors[c]);
    const sps = rects[c];
    anchors += sps.length * 4;
    layers.push({
      type: 'path', id: newId('path'), name: `Piksel ${fill}`, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      style: defaultStyle({ fill, ...(op !== undefined ? { fillOpacity: op } : {}) }), visible: true, locked: false,
      subpaths: sps, fillRule: 'nonzero',
    });
    palette.push({ color: fill, coverage: Math.round((10000 * area[c]) / (W * H)) / 100, paths: sps.length, anchors: sps.length * 4 });
  }
  const group: GroupNode = {
    type: 'group', id: newId('group'), name: `Piksel-birebir vektör (${layers.length} renk)`, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    style: defaultStyle({ fill: 'none' }), visible: true, locked: false, children: layers,
  };
  return {
    width: W, height: H, group, background: useBg ? bgC!.fill : null, palette, preset: 'logo', scale: 1,
    stats: { anchors, subpaths: layers.reduce((s, l) => s + l.subpaths.length, 0), speckles: 0, noise: 0, blur: 0, ms: Date.now() - t0 },
    warnings: ['Sert kenarlı piksel grafiği (piksel sanatı / titreşimli / çok küçük görsel): piksel-birebir vektör üretildi. Pürüzsüz (yumuşatılmış) yorum için refine: false kullanın.'],
  };
}
