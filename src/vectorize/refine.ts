import { createCanvas } from '@napi-rs/canvas';
import type { GroupNode, PathNode, SubPath, VNode } from '../common/types.js';
import { drawNode, type Ctx } from '../render/draw.js';
import { multiply } from '../math/matrix.js';
import type { Matrix } from '../common/types.js';

// Render döngülü geometri iyileştirme (DiffVG benzeri, türevsiz koordinat inişi):
// izlenen şekillerin her çapası ve Bézier kolu, KAYNAK piksellere karşı yerel render hatasını düşürecek şekilde
// alt piksel adımlarla (0.5 → 0.25 → 0.125 → 0.0625 px) kaydırılır. Değişen yalnız komşu iki segmentin kutusu
// yeniden çizildiğinden hata farkı kesin ve ucuzdur. Düşük çözünürlüklü kaynakta kenar yumuşatma (AA) pikselleri
// kenarın alt piksel konumunu taşır: optimizasyon bu bilgiyi doğrudan kullanır → kenarlar kaynağa birebir oturur.

export interface RefineReport { before: number; after: number; moves: number; sweeps: number; splits: number; ms: number; anchors: number; /** Bütçe içinde tamamlanan adım sayısı (kaldığı yerden devam için). */ completedSteps: number; /** Yarım kalan adımın çapa bayrakları (refineGroup resume seçeneğine verilir). */ resume?: number[][][] }

type Box = [number, number, number, number];

/** Varsayılan alt piksel adım çizelgesi (px). */
export const REFINE_STEPS = [0.5, 0.25, 0.125, 0.0625];

export type RefineOptions = { budgetMs?: number; steps?: number[]; handles?: boolean; split?: boolean; /** Uzunluk cezası (düğüm kontrastının² payı / px). */ lambda?: number; loss?: 'l1' | 'l2'; /** Önceki çağrının report.resume değeri. */ resume?: number[][][]; /** Okunan piksel baytı sınırı (worker dilimi). */ maxReadBytes?: number };

const FLAT = (rgba: Uint8ClampedArray, n: number) => {
  const o = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) {
    const a = rgba[p * 4 + 3] / 255;
    o[p * 3] = rgba[p * 4] * a + 255 * (1 - a); o[p * 3 + 1] = rgba[p * 4 + 1] * a + 255 * (1 - a); o[p * 3 + 2] = rgba[p * 4 + 2] * a + 255 * (1 - a);
  }
  return o;
};

function apply(m: Matrix, x: number, y: number): [number, number] { return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; }

/** Yolun i. çapasına dokunan iki segmentin (kontrol noktaları dahil) yerel kutusu. */
function anchorBox(sp: SubPath, i: number): Box {
  const n = sp.points.length;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  const take = (j: number) => {
    const p = sp.points[j];
    add(p.x, p.y);
    if (p.in) add(p.x + p.in.dx, p.y + p.in.dy);
    if (p.out) add(p.x + p.out.dx, p.y + p.out.dy);
  };
  take(i);
  if (sp.closed || i > 0) take((i - 1 + n) % n);
  if (sp.closed || i < n - 1) take((i + 1) % n);
  return [x0, y0, x1, y1];
}

/** i. çapaya dokunan segmentlerin piksel uzayındaki yay uzunluğu (düzenlileştirme terimi). */
function localLength(sp: SubPath, i: number, M: Matrix): number {
  const n = sp.points.length;
  let len = 0;
  const seg = (a: number, b: number) => {
    const P = sp.points[a], Q = sp.points[b];
    const c = [[P.x, P.y], [P.x + (P.out?.dx ?? 0), P.y + (P.out?.dy ?? 0)], [Q.x + (Q.in?.dx ?? 0), Q.y + (Q.in?.dy ?? 0)], [Q.x, Q.y]].map(([x, y]) => apply(M, x, y));
    let px = c[0][0], py = c[0][1];
    for (let k = 1; k <= 12; k++) {
      const t = k / 12, u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      const x = w0 * c[0][0] + w1 * c[1][0] + w2 * c[2][0] + w3 * c[3][0], y = w0 * c[0][1] + w1 * c[1][1] + w2 * c[2][1] + w3 * c[3][1];
      len += Math.hypot(x - px, y - py); px = x; py = y;
    }
  };
  if (sp.closed || i > 0) seg((i - 1 + n) % n, i);
  if (sp.closed || i < n - 1) seg(i, (i + 1) % n);
  return len;
}

/**
 * Şeklin ortalama genişliği (alan / çevre × 2, piksel). Geniş düz alanların rengi kaynaktan kesin bilinir;
 * yalnız ince şekillerin rengi kenar yumuşatmasından kestirilir.
 */
function meanWidth(n: PathNode, M: Matrix): number {
  let area = 0, per = 0;
  for (const sp of n.subpaths) {
    const pts: [number, number][] = [];
    const k = sp.points.length, segs = sp.closed ? k : k - 1;
    for (let i = 0; i < segs; i++) {
      const P = sp.points[i], Q = sp.points[(i + 1) % k];
      const c = [[P.x, P.y], [P.x + (P.out?.dx ?? 0), P.y + (P.out?.dy ?? 0)], [Q.x + (Q.in?.dx ?? 0), Q.y + (Q.in?.dy ?? 0)], [Q.x, Q.y]].map(([x, y]) => apply(M, x, y));
      for (let j = 0; j < 8; j++) {
        const t = j / 8, u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
        pts.push([w0 * c[0][0] + w1 * c[1][0] + w2 * c[2][0] + w3 * c[3][0], w0 * c[0][1] + w1 * c[1][1] + w2 * c[2][1] + w3 * c[3][1]]);
      }
    }
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; per += Math.hypot(q[0] - p[0], q[1] - p[1]); }
    area += a / 2; // evenodd delikler ters yönlü: işaretli toplam net alanı verir
  }
  return per > 0 ? (2 * Math.abs(area)) / per : 0;
}

/** Alt yolun (kontrol noktaları dahil) yerel kutusu. */
function spBox(sp: SubPath): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sp.points) {
    for (const [x, y] of [[p.x, p.y], [p.x + (p.in?.dx ?? 0), p.y + (p.in?.dy ?? 0)], [p.x + (p.out?.dx ?? 0), p.y + (p.out?.dy ?? 0)]]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}

function nodeBox(n: PathNode): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const sp of n.subpaths) for (const p of sp.points) {
    add(p.x, p.y);
    if (p.in) add(p.x + p.in.dx, p.y + p.in.dy);
    if (p.out) add(p.x + p.out.dx, p.y + p.out.dy);
  }
  const sw = n.style.stroke !== 'none' && n.style.strokeWidth > 0 ? n.style.strokeWidth : 0;
  return [x0 - sw, y0 - sw, x1 + sw, y1 + sw];
}

/**
 * `group`'u (traceImage çıktısı) yerinde iyileştir. `ref`: karşılaştırılacak kaynak (izleme çözünürlüğünde, group
 * koordinatı = piksel). `background`: frame zemini. Bütçe dolunca durur; hata hiçbir koşulda artmaz.
 */
export function refineGroup(group: GroupNode, ref: { rgba: Uint8ClampedArray; width: number; height: number }, background: string | null, o: RefineOptions = {}): RefineReport {
  const t0 = Date.now();
  const budget = o.budgetMs ?? 6000;
  const W = ref.width, H = ref.height, N = W * H;
  const target = FLAT(ref.rgba, N);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d') as unknown as Ctx;
  const gm = group.transform;
  // Yaprak düğümler (çizim sırası) ve mutlak matrisleri
  const leaves: { n: VNode; m: Matrix; box: Box }[] = [];
  const collect = (n: VNode, m: Matrix) => {
    if (!n.visible) return;
    const mm = multiply(m, n.transform);
    if (n.type === 'group') { for (const c of n.children) collect(c, mm); return; }
    leaves.push({ n, m, box: [0, 0, W, H] });
  };
  for (const c of group.children) collect(c, gm);
  const pxBox = (m: Matrix, b: Box): Box => {
    const pts = [apply(m, b[0], b[1]), apply(m, b[2], b[1]), apply(m, b[0], b[3]), apply(m, b[2], b[3])];
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  };
  const refreshBox = (L: (typeof leaves)[number]) => {
    const n = L.n;
    // Bulanık/filtreli düğüm: etki alanı geniş — tüm tuval
    if (n.type === 'path' && !n.style.filters?.length) { const b = pxBox(multiply(L.m, n.transform), nodeBox(n)); L.box = [b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2]; }
    else L.box = [-1e9, -1e9, 1e9, 1e9];
  };
  leaves.forEach(refreshBox);
  const opts = {
    width: W, height: H,
    getImage: () => null,
    createLayer: (w: number, h: number) => { const c = createCanvas(w, h); return { canvas: c, ctx: c.getContext('2d') as unknown as Ctx }; },
  } as any;
  const bg = background ?? '#ffffff';
  const L1 = o.loss === 'l1';
  const sc = (m: Matrix) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  // Alt yol kutuları (piksel uzayı) önbelleği; üzerinde çalışılan alt yol (dirty) her zaman çizilir
  const subBox = new WeakMap<SubPath, Box>();
  let dirty: SubPath | null = null;
  let readBytes = 0;
  /** Pencerenin (tamsayı piksel kutusu) karesel hatası. */
  const winErr = (x0: number, y0: number, x1: number, y1: number): number => {
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return 0;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(x0, y0, w, h);
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    ctx.fillStyle = bg; ctx.globalAlpha = 1; ctx.fillRect(x0, y0, w, h);
    for (const L of leaves) {
      const b = L.box;
      if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      const n = L.n;
      // Çok alt yollu bileşik yol: pencereye değmeyen alt yollar atlanır. Bir alt yol sarım sayısını (evenodd ya da
      // nonzero) yalnız kendi kutusunun içinde değiştirir → penceredeki pikseller birebir aynı kalır.
      if (n.type === 'path' && n.subpaths.length > 4 && !n.style.filters?.length) {
        const M = multiply(L.m, n.transform);
        const pad = 2 + (n.style.stroke !== 'none' ? n.style.strokeWidth * sc(M) : 0);
        const keep = n.subpaths.filter((sp) => {
          if (sp === dirty) return true;
          let sb = subBox.get(sp);
          if (!sb) { sb = pxBox(M, spBox(sp)); subBox.set(sp, sb); }
          return !(sb[2] + pad < x0 || sb[0] - pad > x1 || sb[3] + pad < y0 || sb[1] - pad > y1);
        });
        if (!keep.length) continue;
        drawNode(ctx, keep.length === n.subpaths.length ? n : { ...n, subpaths: keep }, L.m, opts, 1);
        continue;
      }
      drawNode(ctx, n, L.m, opts, 1);
    }
    ctx.restore();
    readBytes += w * h * 4;
    const px = ctx.getImageData(x0, y0, w, h).data;
    let e = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4, p = ((y + y0) * W + x + x0) * 3;
      const a = px[q + 3] / 255;
      const r = px[q] * a + 255 * (1 - a) - target[p], g = px[q + 1] * a + 255 * (1 - a) - target[p + 1], bb = px[q + 2] * a + 255 * (1 - a) - target[p + 2];
      e += L1 ? Math.sqrt(r * r + g * g + bb * bb) : r * r + g * g + bb * bb;
    }
    return e;
  };
  // Tüm görüntü hatası yalnız raporlama içindir; büyük görselde (okuma tamponu sızıntısı + süre) atlanır
  const total = () => (W * H <= 1_000_000 ? winErr(0, 0, W, H) : NaN);
  const before = total();
  // Optimize edilebilir: filtresiz yol düğümleri
  const targets = leaves.filter((L) => L.n.type === 'path' && !L.n.style.filters?.length) as { n: PathNode; m: Matrix; box: Box }[];
  let anchors = 0;
  for (const L of targets) for (const sp of L.n.subpaths) anchors += sp.points.length;
  const steps = o.steps ?? REFINE_STEPS;
  let moves = 0, sweeps = 0, splits = 0;
  // Çapa başına "aktif" bayrağı: son geçişte iyileşmeyen ve komşusu da değişmeyen çapa sonraki geçişte atlanır
  const active: Uint8Array[][] = targets.map((L) => L.n.subpaths.map((sp) => new Uint8Array(sp.points.length).fill(1)));
  const timeUp = () => Date.now() - t0 > budget || readBytes > (o.maxReadBytes ?? Infinity);
  /** Bir çapanın serbestlik dereceleri üzerinde koordinat inişi; iyileşme olduysa true. */
  const lamFrac = o.lambda ?? 0.03;
  const bgRgb = /^#[0-9a-f]{6}/i.test(bg) ? [1, 3, 5].map((k) => parseInt(bg.slice(k, k + 2), 16)) : [255, 255, 255];
  const lamOf = (n: PathNode) => {
    const c = typeof n.style.fill === 'string' && /^#[0-9a-f]{6}/i.test(n.style.fill) ? n.style.fill : typeof n.style.stroke === 'string' && /^#[0-9a-f]{6}/i.test(n.style.stroke) ? n.style.stroke : null;
    if (!c) return lamFrac * (L1 ? 222 : 3 * 128 * 128);
    const rgb = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
    const c2 = Math.max(3 * 32 * 32, (rgb[0] - bgRgb[0]) ** 2 + (rgb[1] - bgRgb[1]) ** 2 + (rgb[2] - bgRgb[2]) ** 2);
    return lamFrac * (L1 ? Math.sqrt(c2) : c2);
  };
  const optimizeAnchor = (L: (typeof targets)[number], sp: SubPath, i: number, step: number): boolean => {
    const M = multiply(L.m, L.n.transform);
    const lam = lamOf(L.n);
    const cost = (b: [number, number, number, number]) => winErr(...b) + lam * localLength(sp, i, M);
    const st = step / sc(M);
    const P = sp.points[i];
    dirty = sp;
    const win = (): [number, number, number, number] => {
      const b = pxBox(M, anchorBox(sp, i));
      const sw = L.n.style.stroke !== 'none' ? L.n.style.strokeWidth * sc(M) : 0;
      return [Math.max(0, Math.floor(b[0] - 2 - sw)), Math.max(0, Math.floor(b[1] - 2 - sw)), Math.min(W, Math.ceil(b[2] + 2 + sw)), Math.min(H, Math.ceil(b[3] + 2 + sw))];
    };
    // Eksik kol: geçici sıfır kol (doğru segmentin geometrisi değişmez); kullanılmazsa silinir → doğru→eğri dönüşümü
    const tmpIn = o.handles !== false && !P.in && (sp.closed || i > 0);
    const tmpOut = o.handles !== false && !P.out && (sp.closed || i < sp.points.length - 1);
    if (tmpIn) P.in = { dx: 0, dy: 0 };
    if (tmpOut) P.out = { dx: 0, dy: 0 };
    // Serbestlik dereceleri: çapa konumu, giriş kolu, çıkış kolu
    const dofs: { get: () => [number, number]; set: (x: number, y: number) => void; handle: boolean }[] = [
      { get: () => [P.x, P.y], set: (x, y) => { P.x = x; P.y = y; }, handle: false },
    ];
    if (o.handles !== false) {
      if (P.in) dofs.push({ get: () => [P.in!.dx, P.in!.dy], set: (x, y) => { P.in!.dx = x; P.in!.dy = y; }, handle: true });
      if (P.out) dofs.push({ get: () => [P.out!.dx, P.out!.dy], set: (x, y) => { P.out!.dx = x; P.out!.dy = y; }, handle: true });
    }
    let improved = false;
    for (const d of dofs) {
      const [ox, oy] = d.get();
      // Kutu: eski ve olası yeni konumların birleşimi (çizgi araması eksen başına ≤ 7 adım)
      const span = 7 * st;
      d.set(ox - span, oy - span); const wa = win(); d.set(ox + span, oy + span); const wb = win(); d.set(ox, oy);
      const box: [number, number, number, number] = [Math.min(wa[0], wb[0]), Math.min(wa[1], wb[1]), Math.max(wa[2], wb[2]), Math.max(wa[3], wb[3])];
      const oldBox = L.box;
      L.box = [Math.min(oldBox[0], box[0]), Math.min(oldBox[1], box[1]), Math.max(oldBox[2], box[2]), Math.max(oldBox[3], box[3])];
      let best = cost(box), bx = ox, by = oy;
      // Kol sıfırlama denemesi: spline'ın yuvarladığı sivri köşeyi geri kazanır
      if (d.handle && (ox || oy)) { d.set(0, 0); const e = cost(box); if (e < best - 1e-6) { best = e; bx = 0; by = 0; } }
      for (const [dx, dy] of [[st, 0], [-st, 0], [0, st], [0, -st]]) {
        d.set(bx + dx, by + dy);
        const e = cost(box);
        if (e < best - 1e-6) {
          best = e; bx += dx; by += dy;
          for (let k = 0; k < 6; k++) {
            d.set(bx + dx, by + dy);
            const e2 = cost(box);
            if (e2 < best - 1e-6) { best = e2; bx += dx; by += dy; } else break;
          }
        }
      }
      d.set(bx, by);
      if (bx !== ox || by !== oy) { moves++; improved = true; }
      refreshBox(L);
      L.box = [Math.min(L.box[0], oldBox[0]), Math.min(L.box[1], oldBox[1]), Math.max(L.box[2], oldBox[2]), Math.max(L.box[3], oldBox[3])];
    }
    if (tmpIn && P.in && !P.in.dx && !P.in.dy) delete P.in;
    if (tmpOut && P.out && !P.out.dx && !P.out.dy) delete P.out;
    subBox.delete(sp); dirty = null;
    return improved;
  };
  const clampBox = (b: Box): [number, number, number, number] => [Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])), Math.min(W, Math.ceil(b[2])), Math.min(H, Math.ceil(b[3]))];
  const hx = (c: number[]) => '#' + c.map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
  /** Düz dolgu/kontur rengi ve kontur genişliği: düğüm kutusunda koordinat inişi (ince çizginin rengi AA'dan kestirilir). */
  const paintPass = () => {
    for (const L of targets) {
      if (timeUp()) return;
      const s = L.n.style;
      const box = clampBox(L.box);
      if ((box[2] - box[0]) * (box[3] - box[1]) > 600_000) continue;
      let best = winErr(...box);
      for (const key of ['fill', 'stroke'] as const) {
        const v = s[key];
        if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) continue;
        if (key === 'stroke' && !(s.strokeWidth > 0)) continue;
        // Geniş düz dolgunun rengi kaynağın düz piksellerinden zaten kesin: yalnız ince şekillerde (ort. genişlik < 2 px)
        if (key === 'fill' && meanWidth(L.n, multiply(L.m, L.n.transform)) >= 2) continue;
        const rgb = [1, 3, 5].map((k) => parseInt(v.slice(k, k + 2), 16));
        for (const st of [16, 8, 4, 2, 1]) for (let it = 0; it < 6; it++) {
          let moved = false;
          for (let ch = 0; ch < 3; ch++) for (const sg of [1, -1]) {
            const c = [...rgb]; c[ch] = Math.max(0, Math.min(255, c[ch] + sg * st));
            if (c[ch] === rgb[ch]) continue;
            (s as any)[key] = hx(c);
            const e = winErr(...box);
            if (e < best - 1e-6) { best = e; rgb[ch] = c[ch]; moved = true; moves++; }
            (s as any)[key] = hx(rgb);
          }
          if (!moved) break;
        }
      }
      if (s.stroke !== 'none' && s.strokeWidth > 0) {
        const M = multiply(L.m, L.n.transform);
        for (const st of [0.2, 0.1, 0.05, 0.025].map((v) => v / sc(M))) for (let it = 0; it < 6; it++) {
          let moved = false;
          for (const sg of [1, -1]) {
            const ow = s.strokeWidth, nw = ow + sg * st;
            if (nw <= 0.05) continue;
            s.strokeWidth = Math.max(ow, nw); refreshBox(L);
            const bb = clampBox([Math.min(box[0], L.box[0]), Math.min(box[1], L.box[1]), Math.max(box[2], L.box[2]), Math.max(box[3], L.box[3])]);
            s.strokeWidth = ow; const e0 = winErr(...bb);
            s.strokeWidth = nw; const e = winErr(...bb);
            if (e < e0 - 1e-6) { moved = true; moves++; } else s.strokeWidth = ow;
            refreshBox(L);
          }
          if (!moved) break;
        }
        s.strokeWidth = Math.round(s.strokeWidth * 1000) / 1000;
      }
    }
  };
  /** Yüksek artık hatalı segmentleri ortadan böl (şekil birebir korunur; yeni çapa sonraki geçişte serbestlik verir). */
  const splitPass = (maxNew: number): number => {
    let added = 0;
    for (let ti = 0; ti < targets.length && added < maxNew; ti++) {
      const L = targets[ti];
      const M = multiply(L.m, L.n.transform);
      for (let si = 0; si < L.n.subpaths.length && added < maxNew; si++) {
        const sp = L.n.subpaths[si];
        const segs = sp.closed ? sp.points.length : sp.points.length - 1;
        const out: SubPath['points'] = [];
        const marks: number[] = [];
        for (let i = 0; i < sp.points.length; i++) {
          const P = sp.points[i];
          out.push(P);
          if (i >= segs || added >= maxNew || timeUp()) continue;
          const Q = sp.points[(i + 1) % sp.points.length];
          const p0 = apply(M, P.x, P.y), p3 = apply(M, Q.x, Q.y);
          const len = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
          if (len < 2.5) continue;
          const c1 = { x: P.x + (P.out?.dx ?? 0), y: P.y + (P.out?.dy ?? 0) }, c2 = { x: Q.x + (Q.in?.dx ?? 0), y: Q.y + (Q.in?.dy ?? 0) };
          const b = pxBox(M, [Math.min(P.x, Q.x, c1.x, c2.x), Math.min(P.y, Q.y, c1.y, c2.y), Math.max(P.x, Q.x, c1.x, c2.x), Math.max(P.y, Q.y, c1.y, c2.y)]);
          const wb = clampBox([b[0] - 1.5, b[1] - 1.5, b[2] + 1.5, b[3] + 1.5]);
          if ((wb[2] - wb[0]) * (wb[3] - wb[1]) <= 0) continue;
          // Kenar boyunca birim uzunluk başına hata (kenarın iki yanındaki ~3 px şerit)
          const e = winErr(...wb) / (9 * Math.max(len, 1));
          if (e < (L1 ? 30 : 30 * 30)) continue;
          // de Casteljau t = 0.5
          const m01 = { x: (P.x + c1.x) / 2, y: (P.y + c1.y) / 2 }, m12 = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 }, m23 = { x: (c2.x + Q.x) / 2, y: (c2.y + Q.y) / 2 };
          const a = { x: (m01.x + m12.x) / 2, y: (m01.y + m12.y) / 2 }, c = { x: (m12.x + m23.x) / 2, y: (m12.y + m23.y) / 2 };
          const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
          if (P.out || Q.in) {
            P.out = { dx: m01.x - P.x, dy: m01.y - P.y };
            Q.in = { dx: m23.x - Q.x, dy: m23.y - Q.y };
            out.push({ x: mid.x, y: mid.y, in: { dx: a.x - mid.x, dy: a.y - mid.y }, out: { dx: c.x - mid.x, dy: c.y - mid.y } });
          } else out.push({ x: mid.x, y: mid.y });
          marks.push(out.length - 1);
          added++;
        }
        if (marks.length) {
          sp.points = out; subBox.delete(sp);
          const act = new Uint8Array(out.length);
          for (const k of marks) { act[k] = 1; act[(k - 1 + out.length) % out.length] = 1; act[(k + 1) % out.length] = 1; }
          active[ti][si] = act;
        }
      }
    }
    return added;
  };
  const anchorPass = (step: number) => {
    for (let sweep = 0; sweep < 4; sweep++) {
      sweeps++;
      let changed = 0;
      for (let ti = 0; ti < targets.length; ti++) {
        const L = targets[ti];
        for (let si = 0; si < L.n.subpaths.length; si++) {
          const sp = L.n.subpaths[si];
          const act = active[ti][si];
          const n = sp.points.length;
          for (let i = 0; i < n; i++) {
            if (!act[i]) continue;
            if (timeUp()) return;
            act[i] = 0;
            if (optimizeAnchor(L, sp, i, step)) { changed++; act[(i - 1 + n) % n] = 1; act[(i + 1) % n] = 1; }
          }
        }
      }
      if (!changed) break;
    }
  };
  const resetActive = () => targets.forEach((L, ti) => L.n.subpaths.forEach((sp, si) => { active[ti][si] = new Uint8Array(sp.points.length).fill(1); }));
  let completed = 0;
  paintPass();
  for (const step of steps) {
    if (timeUp()) break;
    // Önceki dilimden devam: yarım kalan adımın etkin çapa bayrakları (şekil eşleşiyorsa) korunur
    const res = completed === 0 ? o.resume : undefined;
    if (res && res.length === active.length && res.every((a, ti) => a.length === active[ti].length && a.every((v, si) => v.length === active[ti][si].length))) res.forEach((a, ti) => a.forEach((v, si) => { active[ti][si] = Uint8Array.from(v); }));
    else resetActive();
    anchorPass(step);
    // Kaba adımlardan sonra: hâlâ hatalı segmentlere çapa ekle, aynı adımla yeniden oturt
    if (step >= 0.125 && o.split !== false && !timeUp()) {
      const added = splitPass(Math.max(8, Math.round(anchors * 0.25)));
      splits += added;
      if (added) anchorPass(step);
    }
    paintPass();
    if (!timeUp()) completed++;
  }
  // Kutuları sıkılaştır (bir sonraki çağrı için gerekmez), koordinatları yuvarla
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  for (const L of targets) for (const sp of L.n.subpaths) for (const p of sp.points) {
    p.x = r3(p.x); p.y = r3(p.y);
    if (p.in) { p.in.dx = r3(p.in.dx); p.in.dy = r3(p.in.dy); }
    if (p.out) { p.out.dx = r3(p.out.dx); p.out.dy = r3(p.out.dy); }
  }
  const after = total();
  const norm = (v: number) => (L1 ? v / N : Math.sqrt(v / (3 * N)));
  return { before: norm(before), after: norm(after), moves, sweeps, splits, ms: Date.now() - t0, anchors, completedSteps: completed, ...(completed < steps.length ? { resume: active.map((a) => a.map((v) => Array.from(v))) } : {}) };
}

/**
 * refineGroup'un bellek güvenli hâli: derlenmiş (dist) kurulumda iş ≤ `sliceMs`'lik dilimler hâlinde kısa ömürlü
 * worker'larda koşar (napi canvas okuma tamponları worker kapanınca serbest kalır; tepe bellek sınırlı kalır).
 * Kaynak (tsx/vitest) ortamında worker dosyası .ts olduğundan süreç içinde çalışır. `group` yerinde güncellenir.
 */
export async function refineGroupIsolated(group: GroupNode, ref: { rgba: Uint8ClampedArray; width: number; height: number }, background: string | null, o: RefineOptions & { sliceMs?: number } = {}): Promise<RefineReport> {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const url = new URL('./refine-worker.js', import.meta.url);
  let file: string | null = null;
  try { file = fileURLToPath(url); if (!existsSync(file)) file = null; } catch { file = null; }
  if (!file) return refineGroup(group, ref, background, o);
  const { Worker } = await import('node:worker_threads');
  const t0 = Date.now();
  const budget = o.budgetMs ?? 6000, slice = o.sliceMs ?? 2000;
  let steps = o.steps ?? REFINE_STEPS;
  let total: RefineReport | null = null;
  let cur = group;
  let resume: number[][][] | undefined;
  while (steps.length && Date.now() - t0 < budget) {
    const left = budget - (Date.now() - t0);
    let res: { group: GroupNode; report: RefineReport };
    try {
      res = await new Promise((resolve, reject) => {
        const w = new Worker(file!, { workerData: { group: cur, ref, background, opts: { ...o, steps, resume, budgetMs: Math.min(slice, left), maxReadBytes: o.maxReadBytes ?? 150e6 } } });
        w.once('message', (m) => { resolve(m); void w.terminate(); });
        w.once('error', reject);
        w.once('exit', (code) => { if (code !== 0) reject(new Error(`refine worker çıkış ${code}`)); });
      });
    } catch {
      // Worker kurulamadı (ör. kısıtlı ortam): kalan iş süreç içinde
      const rep = refineGroup(cur, ref, background, { ...o, steps, resume, budgetMs: left });
      res = { group: cur, report: rep };
    }
    cur = res.group;
    const r = res.report;
    const prev = total as RefineReport | null;
    total = prev ? { ...prev, after: r.after, moves: prev.moves + r.moves, sweeps: prev.sweeps + r.sweeps, splits: prev.splits + r.splits, completedSteps: prev.completedSteps + r.completedSteps } : r;
    steps = steps.slice(r.completedSteps);
    resume = r.resume;
    if (!r.moves && r.completedSteps === 0) break; // ilerleme yok
  }
  if (cur !== group) group.children = cur.children;
  const fin = total as RefineReport | null;
  return fin ? { ...fin, ms: Date.now() - t0 } : refineGroup(group, ref, background, { ...o, budgetMs: 0 });
}
