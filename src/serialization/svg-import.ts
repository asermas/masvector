import type { BlendMode, Filter, Frame, GroupNode, Matrix, Paint, Style, SubPath, VDocument, VNode } from '../common/types.js';
import { defaultStyle, newId } from '../common/ids.js';
import { VectorError } from '../common/errors.js';
import { invert, multiply, parseSvgTransform, scale, translate } from '../math/matrix.js';
import { subpathsBBox, transformSubPath } from '../math/bezier.js';
import { parseColor } from './color.js';
import { nodeSubPaths } from '../math/geometry.js';
import { parsePathData } from './path-data.js';
import { parseXml, textContent, type XmlElement } from './xml.js';
import { createDocument } from '../model/scene.js';

/** Kalıtılan sunum özellikleri (SVG'de CSS kalıtımıyla aşağı iner). */
interface Inherited {
  fill: string; stroke: string; strokeWidth: number;
  fillOpacity: number; strokeOpacity: number;
  linecap?: string; linejoin?: string; dash?: number[];
  fillRule: 'nonzero' | 'evenodd';
  fontSize: number; fontFamily: string; fontWeight?: string; textAnchor?: string; color: string;
}

const ROOT_INHERIT: Inherited = {
  fill: '#000000', stroke: 'none', strokeWidth: 1, fillOpacity: 1, strokeOpacity: 1,
  fillRule: 'nonzero', fontSize: 16, fontFamily: 'sans-serif', color: '#000000',
};

interface CssRule { sel: string; decls: Record<string, string>; spec: number }

const invertSafe = (m: Matrix): Matrix => { try { return invert(m); } catch { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; } };

/** rgb(%…) / hsl() / adlı renkleri kayıpsız #rrggbb(aa)'ya normalleştir; tanınmayanı olduğu gibi bırak. */
export function normColor(v: string): string {
  const t = v.trim();
  if (t === 'none' || t.startsWith('url(') || t === 'transparent') return t === 'transparent' ? 'none' : t;
  const c = parseColor(t);
  if (!c) return t;
  const h = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}${c[3] < 1 ? h(c[3]) : ''}`;
}

/** Gömülü PNG/JPEG/GIF/WebP boyutunu başlıktan oku (çözmeden). */
export function imageDims(href: string): { w: number; h: number } | null {
  const m = /^data:[^;,]+;base64,(.*)$/s.exec(href);
  if (!m) return null;
  const b = Buffer.from(m[1].slice(0, 80000), 'base64');
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const f = b.toString('latin1', 12, 16);
    if (f === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (f === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (f === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1];
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

export interface ImportResult { doc: VDocument; frame: Frame; warnings: string[] }

const num = (v: string | undefined, d = 0) => {
  if (v === undefined) return d;
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : d;
};

function parseStyleAttr(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const part of s.split(';')) {
    const k = part.indexOf(':');
    if (k > 0) out[part.slice(0, k).trim()] = part.slice(k + 1).replace(/!important/, '').trim();
  }
  return out;
}

function parseCss(src: string): CssRule[] {
  const rules: CssRule[] = [];
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const decls = parseStyleAttr(m[2]);
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!/^([a-zA-Z]+)?(\.[\w-]+|#[\w-]+)?$/.test(sel)) continue; // yalnız basit seçiciler
      const spec = sel.startsWith('#') ? 100 : sel.includes('.') ? 10 : 1;
      rules.push({ sel, decls, spec });
    }
  }
  return rules.sort((a, b) => a.spec - b.spec);
}

function matches(sel: string, el: XmlElement): boolean {
  const m = /^([a-zA-Z]+)?(?:\.([\w-]+)|#([\w-]+))?$/.exec(sel)!;
  if (m[1] && m[1] !== el.name) return false;
  if (m[2] && !(el.attrs.class ?? '').split(/\s+/).includes(m[2])) return false;
  if (m[3] && el.attrs.id !== m[3]) return false;
  return true;
}

export interface ImportOptions {
  title?: string;
  /** Harici `href` (dosya yolu/URL) → data URI. Verilmezse yalnız gömülü görseller alınır. */
  resolveHref?: (href: string) => string | null;
  /** İçerik görseli + maske görseli → alfa birleştirilmiş data URI (pdftocairo yumuşak maskeleri). */
  combineMask?: (contentHref: string, maskHref: string) => string | null;
}

export function importSVG(svg: string, opts: ImportOptions = {}): ImportResult {
  let root: XmlElement;
  try { root = parseXml(svg); } catch (e) { throw new VectorError('INVALID_ARGUMENT', (e as Error).message); }
  if (root.name !== 'svg') throw new VectorError('INVALID_ARGUMENT', `Kök eleman <svg> değil: <${root.name}>`);
  const warnings: string[] = [];
  const warned = new Set<string>();
  let quiet = 0;
  const warn = (w: string) => { if (!quiet && !warned.has(w)) { warned.add(w); warnings.push(w); } };

  // id → eleman dizini ve <style> kuralları
  const byId = new Map<string, XmlElement>();
  const css: CssRule[] = [];
  (function index(el: XmlElement) {
    if (el.attrs.id) byId.set(el.attrs.id, el);
    if (el.name === 'style') css.push(...parseCss(textContent(el)));
    for (const c of el.children) if (typeof c !== 'string') index(c);
  })(root);

  const vb = root.attrs.viewBox?.split(/[\s,]+/).map(Number);
  const width = num(root.attrs.width, vb?.[2] ?? 800);
  const height = num(root.attrs.height, vb?.[3] ?? 600);
  const doc = createDocument(opts.title ?? (root.attrs['data-frame-name'] || 'İçe aktarılan SVG'), width, height);
  const frame = doc.pages[0].frames[0];
  frame.w = width; frame.h = height;
  if (root.attrs['data-frame-name']) frame.name = root.attrs['data-frame-name'];
  if (root.attrs['data-frame-id']) frame.id = root.attrs['data-frame-id'];
  frame.background = 'none';

  const props = (el: XmlElement): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of css) if (matches(r.sel, el)) Object.assign(out, r.decls);
    for (const [k, v] of Object.entries(el.attrs)) if (k !== 'style') out[k] = v;
    Object.assign(out, parseStyleAttr(el.attrs.style)); // satır içi stil en yüksek öncelik
    return out;
  };

  const usedIds = new Set<string>();
  const mkId = (el: XmlElement, type: string) => {
    const want = el.attrs.id;
    if (want && !usedIds.has(want)) { usedIds.add(want); return want; }
    return newId(type);
  };

  function resolveGradient(ref: string, bboxOf: () => SubPath[]): Paint | undefined {
    const id = /url\(\s*['"]?#([^)'"]+)['"]?\s*\)/.exec(ref)?.[1];
    const el = id ? byId.get(id) : undefined;
    if (el?.name === 'pattern') return undefined; // desenler convert() içinde kırpma+karo olarak uygulanır
    if (!el || (el.name !== 'linearGradient' && el.name !== 'radialGradient')) { warn(`Desteklenmeyen boya referansı: ${ref}`); return undefined; }
    // href zinciri: stoplar ve öznitelikler miras alınır
    const chain: XmlElement[] = [];
    for (let cur: XmlElement | undefined = el; cur && chain.length < 10; ) {
      chain.push(cur);
      const h: string | undefined = cur.attrs.href ?? cur.attrs['xlink:href'];
      cur = h?.startsWith('#') ? byId.get(h.slice(1)) : undefined;
    }
    const attr = (k: string) => chain.find((c) => c.attrs[k] !== undefined)?.attrs[k];
    const stopsEl = chain.find((c) => c.children.some((x) => typeof x !== 'string' && x.name === 'stop'));
    const stops = (stopsEl?.children ?? []).filter((x): x is XmlElement => typeof x !== 'string' && x.name === 'stop').map((s) => {
      const p = props(s);
      const off = p.offset ?? '0';
      return {
        offset: Math.min(1, Math.max(0, off.endsWith('%') ? num(off) / 100 : num(off))),
        color: normColor(p['stop-color'] ?? '#000000'),
        ...(p['stop-opacity'] !== undefined ? { opacity: num(p['stop-opacity'], 1) } : {}),
      };
    });
    if (!stops.length) return 'none';
    const userSpace = attr('gradientUnits') === 'userSpaceOnUse';
    const b = userSpace ? null : subpathsBBox(bboxOf());
    const gt = parseSvgTransform(attr('gradientTransform'));
    const pct = (v: string | undefined, d: number, axis: 'x' | 'y' | 'r') => {
      let x = v === undefined ? d : v.endsWith('%') ? num(v) / 100 : num(v);
      if (b) {
        const w = b.maxX - b.minX, h = b.maxY - b.minY;
        x = axis === 'x' ? b.minX + x * w : axis === 'y' ? b.minY + x * h : x * Math.sqrt((w * w + h * h) / 2);
      } else if (v?.endsWith('%')) warn('userSpaceOnUse gradyanda yüzde koordinat yaklaşık alındı');
      return x;
    };
    const tp = (x: number, y: number) => ({ x: gt.a * x + gt.c * y + gt.e, y: gt.b * x + gt.d * y + gt.f });
    if (el.name === 'linearGradient') {
      const p1 = tp(pct(attr('x1'), 0, 'x'), pct(attr('y1'), 0, 'y'));
      const p2 = tp(pct(attr('x2'), 1, 'x'), pct(attr('y2'), 0, 'y'));
      return { type: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stops };
    }
    const c = tp(pct(attr('cx'), 0.5, 'x'), pct(attr('cy'), 0.5, 'y'));
    const sc = Math.sqrt(Math.abs(gt.a * gt.d - gt.b * gt.c)) || 1;
    const out: Extract<Paint, { type: 'radial' }> = { type: 'radial', cx: c.x, cy: c.y, r: pct(attr('r'), 0.5, 'r') * sc, stops };
    if (attr('fx') !== undefined || attr('fy') !== undefined) {
      const f = tp(pct(attr('fx'), 0.5, 'x'), pct(attr('fy'), 0.5, 'y'));
      out.fx = f.x; out.fy = f.y;
    }
    return out;
  }

  function inherit(p: Record<string, string>, parent: Inherited): Inherited {
    const h = { ...parent };
    if (p.color) h.color = p.color;
    const col = (v: string) => normColor(v === 'currentColor' ? h.color : v);
    if (p.fill !== undefined) h.fill = col(p.fill);
    if (p.stroke !== undefined) h.stroke = col(p.stroke);
    if (p['stroke-width'] !== undefined) h.strokeWidth = num(p['stroke-width'], 1);
    if (p['fill-opacity'] !== undefined) h.fillOpacity = num(p['fill-opacity'], 1);
    if (p['stroke-opacity'] !== undefined) h.strokeOpacity = num(p['stroke-opacity'], 1);
    if (p['stroke-linecap']) h.linecap = p['stroke-linecap'];
    if (p['stroke-linejoin']) h.linejoin = p['stroke-linejoin'];
    if (p['stroke-dasharray']) h.dash = p['stroke-dasharray'] === 'none' ? undefined : p['stroke-dasharray'].split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (p['fill-rule']) h.fillRule = p['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
    if (p['font-size']) h.fontSize = num(p['font-size'], h.fontSize);
    if (p['font-family']) h.fontFamily = p['font-family'];
    if (p['font-weight']) h.fontWeight = p['font-weight'];
    if (p['text-anchor']) h.textAnchor = p['text-anchor'];
    if (p.font) {
      const fm = /(\d+(?:\.\d+)?)px\s+(.+)$/.exec(p.font);
      if (fm) { h.fontSize = +fm[1]; h.fontFamily = fm[2]; }
    }
    return h;
  }

  function mkStyle(p: Record<string, string>, h: Inherited, geom: () => SubPath[], isGroup: boolean): Style {
    const paint = (v: string): Paint => (v.startsWith('url(') ? resolveGradient(v, geom) ?? 'none' : v);
    const s = defaultStyle({
      fill: isGroup ? 'none' : paint(h.fill),
      stroke: isGroup ? 'none' : paint(h.stroke),
      strokeWidth: h.strokeWidth,
      opacity: num(p.opacity, 1),
    });
    if (!isGroup) {
      if (h.fillOpacity !== 1) s.fillOpacity = h.fillOpacity;
      if (h.strokeOpacity !== 1) s.strokeOpacity = h.strokeOpacity;
      if (h.linecap) s.strokeLinecap = h.linecap as Style['strokeLinecap'];
      if (h.linejoin && ['miter', 'round', 'bevel'].includes(h.linejoin)) s.strokeLinejoin = h.linejoin as Style['strokeLinejoin'];
      if (h.dash?.length) s.strokeDasharray = h.dash;
    }
    if (p['mix-blend-mode']) s.blendMode = p['mix-blend-mode'] as BlendMode;
    if (p.filter && p.filter !== 'none') {
      const fs = resolveFilter(p.filter);
      if (fs.length) s.filters = fs;
    }
    return s;
  }

  function resolveFilter(ref: string): Filter[] {
    const id = /#([^)'"]+)/.exec(ref)?.[1];
    const el = id ? byId.get(id) : undefined;
    const out: Filter[] = [];
    for (const c of el?.children ?? []) {
      if (typeof c === 'string') continue;
      if (c.name === 'feGaussianBlur') out.push({ type: 'blur', radius: num(c.attrs.stdDeviation) * 2 });
      else if (c.name === 'feDropShadow')
        out.push({ type: 'drop-shadow', dx: num(c.attrs.dx, 2), dy: num(c.attrs.dy, 2), blur: num(c.attrs.stdDeviation, 2) * 2, color: normColor(c.attrs['flood-color'] ?? '#000000') });
      else warn(`Desteklenmeyen filtre birimi: <${c.name}>`);
    }
    return out;
  }

  const SKIP = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'filter', 'symbol', 'clipPath', 'mask', 'pattern', 'marker']);

  /** Elemanı çevir; ardından clip-path / mask / desen dolgusu uygula. */
  function convert(el: XmlElement, parent: Inherited, depth: number): VNode | null {
    if (SKIP.has(el.name)) {
      if (el.name === 'marker') warn('<marker> desteklenmiyor; tanım yok sayıldı');
      return null;
    }
    if (depth > 128) { warn('Çok derin iç içe yapı kesildi'); return null; }
    const p = props(el);
    let node = convertRaw(el, parent, depth, p);
    if (!node) return null;
    const h = inherit(p, parent);
    for (const which of ['fill', 'stroke'] as const) {
      const ref = h[which];
      if (ref.startsWith('url(') && node.type !== 'group' && refTarget(ref)?.name === 'pattern') node = applyPattern(node, which, refTarget(ref)!, h, depth) ?? node;
    }
    if (p.mask && p.mask !== 'none') node = applyMask(node, p.mask) ?? node;
    if (p['clip-path'] && p['clip-path'] !== 'none') node = applyClip(node, p['clip-path'], depth);
    return node;
  }

  function refTarget(ref: string): XmlElement | undefined {
    const id = /url\(\s*['"]?#([^)'"]+)['"]?\s*\)/.exec(ref)?.[1];
    return id ? byId.get(id) : undefined;
  }

  /** Bir alt ağacın tüm yapraklarını, verilen matrisle, kübik alt yollar olarak topla (kırpma geometrisi için). */
  function leafSubPaths(n: VNode, m: Matrix, out: SubPath[] = []): SubPath[] {
    const mm = multiply(m, n.transform);
    if (n.type === 'group') { for (const c of n.children) leafSubPaths(c, mm, out); return out; }
    if (n.type === 'text') { warn('Kırpma yolunda metin: sınır kutusu kullanıldı'); }
    for (const sp of nodeSubPaths(n)) out.push(transformSubPath(sp, mm));
    return out;
  }

  function applyClip(node: VNode, ref: string, depth: number): VNode {
    const cp = refTarget(ref);
    if (!cp || cp.name !== 'clipPath') { warn(`clip-path hedefi bulunamadı: ${ref}`); return node; }
    let rule: 'nonzero' | 'evenodd' = 'nonzero';
    const subpaths: SubPath[] = [];
    const cpm = parseSvgTransform(cp.attrs.transform);
    for (const c of cp.children) {
      if (typeof c === 'string') continue;
      const cprops = props(c);
      if (cprops['clip-rule'] === 'evenodd' || cp.attrs['clip-rule'] === 'evenodd') rule = 'evenodd';
      const cn = convertRaw(c, ROOT_INHERIT, depth + 1, cprops);
      if (cn) leafSubPaths(cn, cpm, subpaths);
    }
    if (cp.attrs['clip-path']) warn('İç içe clipPath tanımı yaklaşık uygulandı');
    if (cp.attrs.clipPathUnits === 'objectBoundingBox') {
      const b = subpathsBBox(leafSubPaths(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }).map((sp) => transformSubPath(sp, invertSafe(node.transform))));
      const m = { a: b.maxX - b.minX, b: 0, c: 0, d: b.maxY - b.minY, e: b.minX, f: b.minY };
      for (let i = 0; i < subpaths.length; i++) subpaths[i] = transformSubPath(subpaths[i], m);
    }
    if (!subpaths.length) {
      // Boş kırpma → hiçbir şey görünmez
      return { ...node, visible: false } as VNode;
    }
    const clip = { subpaths, rule };
    if (node.type === 'group' && !node.clip) { node.clip = clip; return node; }
    // Yaprak (veya zaten kırpılmış grup): dönüşümü taşıyan yeni grupla sar; kırpma, elemanın kullanıcı uzayındadır
    const inner = { ...node, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } } as VNode;
    return {
      type: 'group', id: newId('clipgroup'), transform: node.transform, visible: node.visible, locked: false,
      style: defaultStyle({ fill: 'none' }), children: [inner], clip,
    };
  }

  /** pdftocairo'nun alfa maskesi kalıbı: maske içeriği bir görselse (aynı yerleşimde) tek RGBA görsele birleştir. */
  function applyMask(node: VNode, ref: string): VNode | null {
    const mk = refTarget(ref);
    if (!mk || mk.name !== 'mask') { warn(`mask hedefi bulunamadı: ${ref}`); return null; }
    quiet++;
    const maskNodes = kids(mk, ROOT_INHERIT, 1);
    quiet--;
    const findImage = (n: VNode, m: Matrix): { img: Extract<VNode, { type: 'image' }>; m: Matrix } | null => {
      const mm = multiply(m, n.transform);
      if (n.type === 'image') return { img: n, m: mm };
      if (n.type === 'group' && n.children.length === 1) return findImage(n.children[0], mm);
      return null;
    };
    const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const mi = maskNodes.length === 1 ? findImage(maskNodes[0], I) : null;
    const ci = node.type === 'group' ? findImage({ ...node, transform: I } as VNode, I) : node.type === 'image' ? { img: node, m: I } : null;
    if (mi && ci && Math.abs(mi.m.a - ci.m.a) + Math.abs(mi.m.d - ci.m.d) + Math.abs(mi.m.e - ci.m.e) + Math.abs(mi.m.f - ci.m.f) < 1e-3 &&
        mi.img.x === ci.img.x && mi.img.y === ci.img.y && opts.combineMask) {
      const merged = opts.combineMask(ci.img.href, mi.img.href);
      if (merged) { ci.img.href = merged; return node; }
    }
    // Düz maske (tek renkli dolu şekil) → opaklık çarpanı
    if (maskNodes.length === 1 && maskNodes[0].type !== 'group' && maskNodes[0].type !== 'image' && typeof maskNodes[0].style.fill === 'string') {
      const c = parseColor(maskNodes[0].style.fill);
      if (c) { node.style.opacity *= (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) * c[3] * (maskNodes[0].style.fillOpacity ?? 1); return node; }
    }
    warn('Karmaşık yumuşak maske (mask) desteklenmiyor; içerik maskesiz aktarıldı');
    return null;
  }

  /** Desen dolgusu: şekli kırpma olarak kullanan grup + döşenmiş desen içeriği. */
  function applyPattern(node: VNode, which: 'fill' | 'stroke', pat: XmlElement, h: Inherited, depth: number): VNode | null {
    if (which === 'stroke') { warn('Desenli kontur desteklenmiyor; kontur kaldırıldı'); node.style.stroke = 'none'; return node; }
    // href zinciri (içerik ve öznitelik mirası)
    const chain: XmlElement[] = [];
    for (let cur: XmlElement | undefined = pat; cur && chain.length < 10; ) {
      chain.push(cur);
      const hr: string | undefined = cur.attrs.href ?? cur.attrs['xlink:href'];
      cur = hr?.startsWith('#') ? byId.get(hr.slice(1)) : undefined;
    }
    const attr = (k: string) => chain.find((c) => c.attrs[k] !== undefined)?.attrs[k];
    const contentEl = chain.find((c) => c.children.some((x) => typeof x !== 'string')) ?? pat;
    const local = nodeSubPaths(node);
    const bb = subpathsBBox(local);
    const bw = bb.maxX - bb.minX, bh = bb.maxY - bb.minY;
    const userUnits = attr('patternUnits') === 'userSpaceOnUse';
    const pv = (k: string, d: number, span: number, org: number) => {
      const v = attr(k);
      const x = v === undefined ? d : v.endsWith('%') ? num(v) / 100 : num(v);
      return userUnits ? x : org + x * span;
    };
    const px = pv('x', 0, bw, bb.minX), py = pv('y', 0, bh, bb.minY);
    const pw = userUnits ? num(attr('width')) : num(attr('width')) * bw, ph = userUnits ? num(attr('height')) : num(attr('height')) * bh;
    if (!(pw > 0 && ph > 0)) { warn('Boyutsuz desen atlandı'); return null; }
    const ptm = parseSvgTransform(attr('patternTransform'));
    let contentM: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const vb = attr('viewBox')?.split(/[\s,]+/).map(Number);
    if (vb?.length === 4) contentM = multiply(scale(pw / vb[2], ph / vb[3]), translate(-vb[0], -vb[1]));
    else if (attr('patternContentUnits') === 'objectBoundingBox') contentM = { a: bw, b: 0, c: 0, d: bh, e: 0, f: 0 };
    const tileNodes = kids(contentEl, h, depth + 1);
    if (!tileNodes.length) return null;
    // Şeklin bbox'ını desen uzayına taşıyıp kaç karo gerektiğini bul
    const inv = invertSafe(ptm);
    const corners = [[bb.minX, bb.minY], [bb.maxX, bb.minY], [bb.maxX, bb.maxY], [bb.minX, bb.maxY]].map(([x, y]) => ({ x: inv.a * x + inv.c * y + inv.e, y: inv.b * x + inv.d * y + inv.f }));
    const ix0 = Math.floor((Math.min(...corners.map((c) => c.x)) - px) / pw), ix1 = Math.ceil((Math.max(...corners.map((c) => c.x)) - px) / pw);
    const iy0 = Math.floor((Math.min(...corners.map((c) => c.y)) - py) / ph), iy1 = Math.ceil((Math.max(...corners.map((c) => c.y)) - py) / ph);
    const count = (ix1 - ix0) * (iy1 - iy0);
    const tiles: VNode[] = [];
    if (count > 400) { warn(`Desen ${count} karo gerektiriyor; ilk 400 karo çizildi`); }
    outer: for (let iy = iy0; iy < iy1; iy++) for (let ix = ix0; ix < ix1; ix++) {
      if (tiles.length >= 400) break outer;
      const tm = multiply(translate(px + ix * pw, py + iy * ph), contentM);
      const tileClip = { subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: pw, y: 0 }, { x: pw, y: ph }, { x: 0, y: ph }] }], rule: 'nonzero' as const };
      tiles.push({
        type: 'group', id: newId('tile'), transform: translate(px + ix * pw, py + iy * ph), visible: true, locked: false, style: defaultStyle({ fill: 'none' }),
        clip: tileClip,
        children: [{ type: 'group', id: newId('group'), transform: multiply(invertSafe(translate(px + ix * pw, py + iy * ph)), tm), visible: true, locked: false, style: defaultStyle({ fill: 'none' }), children: structuredClone(tileNodes).map(reId) }],
      });
    }
    const patternGroup: VNode = {
      type: 'group', id: newId('pattern'), name: 'Desen', transform: ptm, visible: true, locked: false, style: defaultStyle({ fill: 'none' }), children: tiles,
    };
    const shapeStroke = node.style.stroke !== 'none' ? ({ ...structuredClone(node), id: newId(node.type), style: { ...node.style, fill: 'none' } } as VNode) : null;
    const fillOpacity = (node.style.fillOpacity ?? 1) * node.style.opacity;
    const g: VNode = {
      type: 'group', id: newId('clipgroup'), name: node.name, transform: node.transform, visible: node.visible, locked: false,
      style: defaultStyle({ fill: 'none', opacity: fillOpacity }),
      clip: { subpaths: structuredClone(local), rule: node.type === 'path' ? node.fillRule : 'nonzero' },
      children: [patternGroup],
    };
    if (!shapeStroke) return g;
    shapeStroke.transform = node.transform;
    return { type: 'group', id: newId('group'), transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, visible: node.visible, locked: false, style: defaultStyle({ fill: 'none' }), children: [g, shapeStroke] };
  }

  function reId(n: VNode): VNode {
    n.id = newId(n.type);
    if (n.type === 'group') n.children.forEach(reId);
    return n;
  }

  function convertRaw(el: XmlElement, parent: Inherited, depth: number, p: Record<string, string>): VNode | null {
    if (SKIP.has(el.name)) return null;
    const h = inherit(p, parent);
    let transform = parseSvgTransform(p.transform);
    const visible = p.display !== 'none' && p.visibility !== 'hidden';
    const baseOf = (type: string) => ({
      id: mkId(el, type), name: el.attrs['data-name'] ?? undefined, transform, visible,
      locked: el.attrs['data-locked'] === 'true',
    });

    switch (el.name) {
      case 'svg': case 'g': case 'a': case 'switch': {
        if (el.name === 'svg') {
          // iç içe svg: x,y + viewBox ölçeği
          const vbx = el.attrs.viewBox?.split(/[\s,]+/).map(Number);
          let m = translate(num(el.attrs.x), num(el.attrs.y));
          if (vbx?.length === 4 && el.attrs.width && el.attrs.height)
            m = multiply(m, multiply(scale(num(el.attrs.width) / vbx[2], num(el.attrs.height) / vbx[3]), translate(-vbx[0], -vbx[1])));
          transform = multiply(transform, m);
        }
        const children = kids(el, h, depth);
        const g: GroupNode = { type: 'group', ...baseOf('group'), transform, style: mkStyle(p, h, () => [], true), children };
        if (el.attrs['data-layer'] === 'true') g.isLayer = true;
        return g;
      }
      case 'use': {
        const href = el.attrs.href ?? el.attrs['xlink:href'];
        const target = href?.startsWith('#') ? byId.get(href.slice(1)) : undefined;
        if (!target) { warn(`<use> hedefi bulunamadı: ${href}`); return null; }
        const inner = target.name === 'symbol' ? { ...target, name: 'g' } : target;
        const c = convert({ ...inner, attrs: { ...inner.attrs, id: '' } }, h, depth + 1);
        if (!c) return null;
        const g: GroupNode = {
          type: 'group', ...baseOf('group'),
          transform: multiply(transform, translate(num(el.attrs.x), num(el.attrs.y))),
          style: mkStyle(p, h, () => [], true), children: [c],
        };
        return g;
      }
      case 'path': {
        if (!p.d) return null;
        let subpaths: SubPath[];
        try { subpaths = parsePathData(p.d); } catch (e) { warn(`Bozuk path atlandı: ${(e as Error).message}`); return null; }
        if (!subpaths.length) return null;
        return { type: 'path', ...baseOf('path'), style: mkStyle(p, h, () => subpaths, false), subpaths, fillRule: h.fillRule };
      }
      case 'polyline': case 'polygon': {
        const nums = (p.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
        if (pts.length < 2) return null;
        const subpaths = [{ closed: el.name === 'polygon', points: pts }];
        return { type: 'path', ...baseOf('path'), style: mkStyle(p, h, () => subpaths, false), subpaths, fillRule: h.fillRule };
      }
      case 'rect': {
        const n: VNode = {
          type: 'rect', ...baseOf('rect'), style: defaultStyle(),
          x: num(p.x), y: num(p.y), width: num(p.width), height: num(p.height),
        };
        const rx = p.rx !== undefined ? num(p.rx) : undefined, ry = p.ry !== undefined ? num(p.ry) : undefined;
        if (rx || ry) { n.rx = rx ?? ry; n.ry = ry ?? rx; }
        n.style = mkStyle(p, h, () => nodeSubPaths(n), false);
        return n;
      }
      case 'circle': case 'ellipse': {
        const rx = el.name === 'circle' ? num(p.r) : num(p.rx), ry = el.name === 'circle' ? num(p.r) : num(p.ry, rx);
        const n: VNode = { type: 'ellipse', ...baseOf('ellipse'), style: defaultStyle(), x: num(p.cx) - rx, y: num(p.cy) - ry, width: 2 * rx, height: 2 * ry };
        n.style = mkStyle(p, h, () => nodeSubPaths(n), false);
        return n;
      }
      case 'line': {
        const n: VNode = { type: 'line', ...baseOf('line'), style: defaultStyle(), x1: num(p.x1), y1: num(p.y1), x2: num(p.x2), y2: num(p.y2) };
        n.style = mkStyle(p, h, () => nodeSubPaths(n), false);
        return n;
      }
      case 'text': {
        const content = textContent(el).replace(/\s+/g, ' ').trim();
        if (!content) return null;
        if (el.children.some((c) => typeof c !== 'string')) warn('<tspan> konumlandırması tek satır metne indirgendi');
        const n: VNode = {
          type: 'text', ...baseOf('text'), style: defaultStyle(), x: num(p.x), y: num(p.y), content,
          fontSize: h.fontSize, fontFamily: h.fontFamily.replace(/^['"]|['"]$/g, ''),
          ...(h.fontWeight ? { fontWeight: h.fontWeight } : {}),
          ...(h.textAnchor === 'middle' || h.textAnchor === 'end' ? { textAnchor: h.textAnchor } : {}),
        };
        n.style = mkStyle(p, h, () => nodeSubPaths(n), false);
        return n;
      }
      case 'image': {
        let href = el.attrs.href ?? el.attrs['xlink:href'] ?? '';
        if (!href.startsWith('data:')) {
          const resolved = opts.resolveHref?.(href);
          if (!resolved) { warn(`Harici görsel bağlantısı çözülemedi: ${href.slice(0, 80)}`); return null; }
          href = resolved;
        }
        const dims = imageDims(href);
        let x = num(p.x), y = num(p.y), w = p.width !== undefined ? num(p.width) : dims?.w ?? 0, hh = p.height !== undefined ? num(p.height) : dims?.h ?? 0;
        if (!(w > 0 && hh > 0)) { warn('Boyutu belirlenemeyen görsel atlandı'); return null; }
        // preserveAspectRatio (varsayılan xMidYMid meet): içsel en-boy oranına sığdır
        const par = (p.preserveAspectRatio ?? 'xMidYMid meet').trim();
        if (dims && !par.startsWith('none')) {
          const [align, mode = 'meet'] = par.split(/\s+/);
          const sx = w / dims.w, sy = hh / dims.h;
          const k = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
          const nw = dims.w * k, nh = dims.h * k;
          const ax = align.includes('xMid') ? 0.5 : align.includes('xMax') ? 1 : 0, ay = align.includes('YMid') ? 0.5 : align.includes('YMax') ? 1 : 0;
          if (mode === 'slice') warn('preserveAspectRatio slice kırpması yaklaşık uygulandı');
          x += (w - nw) * ax; y += (hh - nh) * ay; w = nw; hh = nh;
        }
        return { type: 'image', ...baseOf('image'), style: defaultStyle({ fill: 'none', opacity: num(p.opacity, 1) }), x, y, width: w, height: hh, href };
      }
      case 'foreignObject':
        warn('<foreignObject> (HTML) desteklenmiyor; atlandı');
        return null;
      default:
        warn(`Bilinmeyen eleman <${el.name}> atlandı`);
        return null;
    }
  }

  function kids(el: XmlElement, h: Inherited, depth: number): VNode[] {
    const out: VNode[] = [];
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (c.attrs['data-frame-background'] === 'true') { frame.background = c.attrs.fill ?? '#ffffff'; continue; }
      const n = convert(c, h, depth + 1);
      if (n) out.push(n);
    }
    return out;
  }

  const rootProps = props(root);
  const rootInh = inherit(rootProps, ROOT_INHERIT);
  let nodes = kids(root, rootInh, 0);
  // viewBox ofseti/ölçeği varsa kök içeriği bir gruba sar
  if (vb?.length === 4 && (vb[0] !== 0 || vb[1] !== 0 || Math.abs(vb[2] - width) > 1e-9 || Math.abs(vb[3] - height) > 1e-9)) {
    const m = multiply(scale(width / vb[2], height / vb[3]), translate(-vb[0], -vb[1]));
    nodes = [{
      type: 'group', id: newId('group'), name: 'viewBox', transform: m, style: defaultStyle({ fill: 'none' }),
      visible: true, locked: false, children: nodes,
    }];
  }
  frame.nodes = nodes;
  return { doc, frame, warnings };
}
