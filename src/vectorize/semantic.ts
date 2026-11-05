// Anlamsal şekil çıkarımı: renk katmanı başına tek bileşik yol yerine nesneler.
//  1) Her renk yolunu bağlı bileşenlerine (dış hat + delikleri) ayır → ayrı şekiller.
//  2) Örtü (occlusion) farkında tamamlama: bir şeklin üstteki katmanlarca örtülen kısmı "serbest"tir. Şekil, görünen
//     kısmı birebir korunarak ve fazlası yalnız örtülü alana düşerek bir dikdörtgen/elipse tamamlanabiliyorsa o
//     ilkel şekle dönüşür (ör. Portekiz bayrağında arması delik açılmış yeşil şerit → tek dikdörtgen).
//  3) Tamamen örtülü delikler kapatılır (delikli kalkan → düz kalkan; mavi kalkancıklar üstte zaten çiziliyor).
// Görsel sonuç (1 px toleransla) değişmez; değişim ancak ölçütle doğrulanarak (traceBest) kabul edilir.
// Tüm maske işleri şekil kutusu çevresindeki pencerede yapılır (yüzlerce şekilde de hızlı).
import type { EllipseNode, GroupNode, PathNode, RectNode, SubPath, VNode } from '../common/types.js';
import { flattenSubPaths, signedArea, subpathsBBox } from '../math/bezier.js';
import { newId } from '../common/ids.js';

type Pt = { x: number; y: number };
type Poly = Pt[];
/** Pencere (maske koordinatında). */
interface Win { x0: number; y0: number; w: number; h: number }

/** Tarama dönüşümü: poligonları (çift-tek kuralı) piksel merkezinden örnekleyerek pencere maskesine çiz. */
function rasterize(polys: Poly[], win: Win, into: Uint8Array | Int16Array, val = 1, s = 1) {
  const xs: number[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (const p of polys) for (const q of p) { if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
  const y0 = Math.max(win.y0, Math.floor(minY * s)), y1 = Math.min(win.y0 + win.h - 1, Math.ceil(maxY * s));
  for (let y = y0; y <= y1; y++) {
    const cy = (y + 0.5) / s;
    xs.length = 0;
    for (const p of polys) for (let i = 0, n = p.length; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      if ((a.y <= cy) !== (b.y <= cy)) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((a, b) => a - b);
    const row = (y - win.y0) * win.w - win.x0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(win.x0, Math.ceil(xs[i] * s - 0.5)), xb = Math.min(win.x0 + win.w - 1, Math.floor(xs[i + 1] * s - 0.5));
      for (let x = xa; x <= xb; x++) into[row + x] = val;
    }
  }
}

/** r px (kare) genişletme / aşındırma — ayrılabilir; pencere dışı = 0. */
function morph(m: Uint8Array, W: number, H: number, r: number, dilate: boolean): Uint8Array {
  if (r <= 0) return m;
  const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = dilate ? 0 : 1;
    for (let d = -r; d <= r; d++) { const xx = x + d; const q = xx < 0 || xx >= W ? 0 : m[y * W + xx]; if (dilate ? q : !q) { v = dilate ? 1 : 0; break; } }
    t[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = dilate ? 0 : 1;
    for (let d = -r; d <= r; d++) { const yy = y + d; const q = yy < 0 || yy >= H ? 0 : t[yy * W + x]; if (dilate ? q : !q) { v = dilate ? 1 : 0; break; } }
    o[y * W + x] = v;
  }
  return o;
}

/** Bileşik yolu bileşenlere ayır: her dış hat + doğrudan içindeki delikler (içerme derinliğine göre). */
export function splitComponents(sps: SubPath[]): SubPath[][] {
  const closed = sps.filter((s) => s.closed && s.points.length >= 2);
  if (closed.length <= 1) return closed.length ? [closed] : [];
  const polys = closed.map((s) => flattenSubPaths([s], 0.5)[0]);
  const boxes = closed.map((s) => subpathsBBox([s]));
  const inside = (i: number, j: number) => {
    const a = boxes[i], b = boxes[j];
    if (a.minX < b.minX - 1e-6 || a.maxX > b.maxX + 1e-6 || a.minY < b.minY - 1e-6 || a.maxY > b.maxY + 1e-6) return false;
    const p = polys[i][0], P = polys[j];
    let c = false;
    for (let k = 0, n = P.length; k < n; k++) { const u = P[k], v = P[(k + 1) % n]; if ((u.y > p.y) !== (v.y > p.y) && p.x < u.x + ((p.y - u.y) / (v.y - u.y)) * (v.x - u.x)) c = !c; }
    return c;
  };
  const depth = closed.map(() => 0), parent = closed.map(() => -1);
  const area = polys.map((p) => Math.abs(signedArea(p)));
  for (let i = 0; i < closed.length; i++) {
    let best = -1;
    for (let j = 0; j < closed.length; j++) if (i !== j && area[j] > area[i] && inside(i, j)) { depth[i]++; if (best < 0 || area[j] < area[best]) best = j; }
    parent[i] = best;
  }
  const groups = new Map<number, SubPath[]>();
  for (let i = 0; i < closed.length; i++) {
    if (depth[i] % 2 === 0) { if (!groups.has(i)) groups.set(i, []); groups.get(i)!.unshift(closed[i]); }
    else { const p = parent[i]; if (!groups.has(p)) groups.set(p, []); groups.get(p)!.push(closed[i]); }
  }
  return [...groups.values()];
}

/** Cebirsel elips uydurma (eksen hizalı): A x² + C y² + D x + E y = 1, en küçük kareler. */
function fitEllipseAA(pts: Pt[]): { cx: number; cy: number; rx: number; ry: number; rms: number } | null {
  if (pts.length < 8) return null;
  let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= pts.length; my /= pts.length;
  const M = Array.from({ length: 4 }, () => new Float64Array(4)), v = new Float64Array(4);
  for (const p of pts) {
    const x = p.x - mx, y = p.y - my, row = [x * x, y * y, x, y];
    for (let i = 0; i < 4; i++) { v[i] += row[i]; for (let j = 0; j < 4; j++) M[i][j] += row[i] * row[j]; }
  }
  const s = solve(M, v); if (!s) return null;
  const [A, C, D, E] = s;
  if (!(A > 0 && C > 0)) return null;
  const cx = -D / (2 * A), cy = -E / (2 * C);
  const F = 1 + A * cx * cx + C * cy * cy;
  const rx = Math.sqrt(F / A), ry = Math.sqrt(F / C);
  if (!isFinite(rx) || !isFinite(ry)) return null;
  // Geometrik artık (yaklaşık): merkezden ışın boyunca elipse uzaklık
  let e2 = 0;
  for (const p of pts) {
    const dx = p.x - mx - cx, dy = p.y - my - cy, rr = Math.hypot(dx, dy);
    if (rr < 1e-9) { e2 += Math.min(rx, ry) ** 2; continue; }
    const re = 1 / Math.sqrt((dx / rr / rx) ** 2 + (dy / rr / ry) ** 2);
    e2 += (rr - re) ** 2;
  }
  return { cx: cx + mx, cy: cy + my, rx, ry, rms: Math.sqrt(e2 / pts.length) };
}
function solve(M: Float64Array[], v: Float64Array): number[] | null {
  const n = v.length, a = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]; }
  }
  return a.map((r, i) => r[n] / r[i]);
}

export interface SemanticReport { components: number; rects: number; ellipses: number; holesClosed: number }

/**
 * Grup çocuklarını anlamsal şekillere dönüştür (yeni grup döner; giriş değişmez). W×H: çerçeve boyutu (px).
 */
export function semanticShapes(group: GroupNode, W: number, H: number): { group: GroupNode; report: SemanticReport } {
  const rep: SemanticReport = { components: 0, rects: 0, ellipses: 0, holesClosed: 0 };
  const ss = Math.max(1, Math.min(4, Math.floor(Math.sqrt(4e6 / Math.max(1, W * H))))); // örnekleme ölçeği
  const MW = W * ss, MH = H * ss;
  const full: Win = { x0: 0, y0: 0, w: MW, h: MH };
  const kids = group.children;
  // top[q]: q'yu örten en üstteki opak dolgu düğümünün sırası + 1. "i'nin üstündekilerce örtülü" ⇔ top[q] > i + 1
  const top = new Int16Array(MW * MH);
  kids.forEach((n, i) => {
    if (n.type === 'path' && n.style.fill !== 'none' && !n.style.filters?.length && (n.style.opacity ?? 1) >= 0.999 && (n.style.fillOpacity ?? 1) >= 0.999)
      rasterize(flattenSubPaths(n.subpaths, 0.3 / ss), full, top, i + 1, ss);
  });
  const out: VNode[] = [];
  kids.forEach((n, i) => {
    if (n.type !== 'path' || n.style.fill === 'none' || n.style.filters?.length || n.subpaths.some((s) => !s.closed)) { out.push(n); return; }
    const comps = splitComponents(n.subpaths);
    if (!comps.length) { out.push(n); return; }
    const color = typeof n.style.fill === 'string' ? n.style.fill : '';
    const name = (kind: string) => `${kind} ${color}`.trim();
    comps.forEach((sps, ci) => {
      rep.components++;
      const base = { id: newId('path'), transform: n.transform, style: structuredClone(n.style), visible: true, locked: false };
      const outer = sps[0];
      const b = subpathsBBox([outer]);
      const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
      const freeName = name(comps.length > 1 ? `Şekil ${ci + 1}` : 'Şekil');
      if (!(bw > 0 && bh > 0)) { out.push({ ...base, type: 'path', name: freeName, subpaths: sps, fillRule: n.fillRule } as PathNode); return; }
      const mkWin = (x0: number, y0: number, x1: number, y1: number): Win => {
        const a = Math.max(0, Math.floor(x0 * ss) - 3 * ss - 2), c = Math.max(0, Math.floor(y0 * ss) - 3 * ss - 2);
        const bx = Math.min(MW, Math.ceil(x1 * ss) + 3 * ss + 2), by = Math.min(MH, Math.ceil(y1 * ss) + 3 * ss + 2);
        return { x0: a, y0: c, w: Math.max(1, bx - a), h: Math.max(1, by - c) };
      };
      const ctx = (win: Win) => {
        const own = new Uint8Array(win.w * win.h);
        rasterize(flattenSubPaths(sps, 0.3 / ss), win, own, 1, ss);
        const ab = new Uint8Array(win.w * win.h);
        for (let y = 0; y < win.h; y++) for (let x = 0; x < win.w; x++) ab[y * win.w + x] = top[(y + win.y0) * MW + x + win.x0] > i + 1 ? 1 : 0;
        // Örtü: üstteki katmanların 1 px aşındırılmışı (tamamlama görünür kenar yaratmasın)
        return { own, ab, occ: morph(ab, win.w, win.h, ss, false), ownIn: morph(own, win.w, win.h, ss, false), ownD: morph(own, win.w, win.h, ss, true) };
      };
      // Aday maskesi c: (c \ own) ⊆ occ (1 px kenar şeridi hariç) ve (own \ c) ≈ ∅ (1 px kenar hariç)
      const fits = (win: Win, k: ReturnType<typeof ctx>, cand: Uint8Array) => {
        const candD = morph(cand, win.w, win.h, ss, true);
        let bad = 0, ownN = 0;
        for (let q = 0; q < cand.length; q++) {
          ownN += k.own[q];
          if (cand[q] && !k.ownD[q] && !k.occ[q]) bad++;
          if (k.ownIn[q] && !candD[q]) bad++;
        }
        return ownN > 0 && bad <= Math.max(2, ownN * 0.0005);
      };
      const win = mkWin(b.minX, b.minY, b.maxX, b.maxY);
      const k = ctx(win);
      // 1) Dikdörtgen (eksen hizalı) — kutu, görünen kenarlardan zaten alt piksel hassas
      if (bw >= 2 && bh >= 2) {
        const c = new Uint8Array(win.w * win.h);
        rasterize([[{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]], win, c, 1, ss);
        if (fits(win, k, c)) {
          rep.rects++;
          out.push({ ...base, type: 'rect', name: name('Dikdörtgen'), x: r3(b.minX), y: r3(b.minY), width: r3(bw), height: r3(bh) } as RectNode);
          return;
        }
      }
      // 2) Elips: görünen (örtü komşusu olmayan) sınır noktalarına uydur
      if (bw >= 4 && bh >= 4) {
        const pts: Pt[] = [];
        const [poly] = flattenSubPaths([outer], 0.2);
        const near = morph(k.ab, win.w, win.h, 2 * ss, true);
        for (const p of poly) {
          const x = Math.floor(p.x * ss) - win.x0, y = Math.floor(p.y * ss) - win.y0;
          if (x < 0 || y < 0 || x >= win.w || y >= win.h || !near[y * win.w + x]) pts.push(p);
        }
        const e = pts.length >= 0.25 * poly.length ? fitEllipseAA(pts) : null;
        if (e && e.rms < 0.35 && e.rx < 2 * W && e.ry < 2 * H) {
          const w2 = mkWin(Math.min(b.minX, e.cx - e.rx), Math.min(b.minY, e.cy - e.ry), Math.max(b.maxX, e.cx + e.rx), Math.max(b.maxY, e.cy + e.ry));
          const k2 = w2.w === win.w && w2.h === win.h && w2.x0 === win.x0 && w2.y0 === win.y0 ? k : ctx(w2);
          const c = new Uint8Array(w2.w * w2.h);
          const N = Math.max(32, Math.ceil(Math.PI * Math.max(e.rx, e.ry) * ss));
          rasterize([Array.from({ length: N }, (_, q) => ({ x: e.cx + e.rx * Math.cos((2 * Math.PI * q) / N), y: e.cy + e.ry * Math.sin((2 * Math.PI * q) / N) }))], w2, c, 1, ss);
          if (fits(w2, k2, c)) {
            rep.ellipses++;
            const circle = Math.abs(e.rx - e.ry) < 0.02 * Math.max(e.rx, e.ry);
            const rx = circle ? (e.rx + e.ry) / 2 : e.rx, ry = circle ? rx : e.ry;
            out.push({ ...base, type: 'ellipse', name: name(circle ? 'Daire' : 'Elips'), x: r3(e.cx - rx), y: r3(e.cy - ry), width: r3(2 * rx), height: r3(2 * ry) } as EllipseNode);
            return;
          }
        }
      }
      // 3) Serbest şekil: tamamen örtülü delikleri kapat
      const kept: SubPath[] = [outer];
      for (const hole of sps.slice(1)) {
        const hb = subpathsBBox([hole]);
        const hw = mkWin(hb.minX, hb.minY, hb.maxX, hb.maxY);
        const hm = new Uint8Array(hw.w * hw.h);
        rasterize(flattenSubPaths([hole], 0.3 / ss), hw, hm, 1, ss);
        const hIn = morph(hm, hw.w, hw.h, ss, false);
        let vis = 0, tot = 0;
        for (let y = 0; y < hw.h; y++) for (let x = 0; x < hw.w; x++) {
          if (!hIn[y * hw.w + x]) continue;
          tot++;
          if (top[(y + hw.y0) * MW + x + hw.x0] <= i + 1) vis++;
        }
        if (tot > 0 && vis === 0) rep.holesClosed++; else kept.push(hole);
      }
      out.push({ ...base, type: 'path', name: freeName, subpaths: kept, fillRule: n.fillRule } as PathNode);
    });
  });
  return { group: { ...group, children: out }, report: rep };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
