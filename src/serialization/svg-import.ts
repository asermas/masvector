import type { BlendMode, Filter, Frame, GroupNode, Paint, Style, SubPath, VDocument, VNode } from '../common/types.js';
import { defaultStyle, newId } from '../common/ids.js';
import { VectorError } from '../common/errors.js';
import { multiply, parseSvgTransform, scale, translate } from '../math/matrix.js';
import { subpathsBBox } from '../math/bezier.js';
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

export function importSVG(svg: string, opts: { title?: string } = {}): ImportResult {
  let root: XmlElement;
  try { root = parseXml(svg); } catch (e) { throw new VectorError('INVALID_ARGUMENT', (e as Error).message); }
  if (root.name !== 'svg') throw new VectorError('INVALID_ARGUMENT', `Kök eleman <svg> değil: <${root.name}>`);
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };

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
        color: p['stop-color'] ?? '#000000',
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
    const col = (v: string) => (v === 'currentColor' ? h.color : v);
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
        out.push({ type: 'drop-shadow', dx: num(c.attrs.dx, 2), dy: num(c.attrs.dy, 2), blur: num(c.attrs.stdDeviation, 2) * 2, color: c.attrs['flood-color'] ?? '#000000' });
      else warn(`Desteklenmeyen filtre birimi: <${c.name}>`);
    }
    return out;
  }

  const SKIP = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'filter', 'symbol', 'clipPath', 'mask', 'pattern', 'marker']);

  function convert(el: XmlElement, parent: Inherited, depth: number): VNode | null {
    if (SKIP.has(el.name)) {
      if (['clipPath', 'mask', 'pattern', 'marker'].includes(el.name)) warn(`<${el.name}> desteklenmiyor; tanım yok sayıldı`);
      return null;
    }
    if (depth > 64) { warn('Çok derin iç içe yapı kesildi'); return null; }
    const p = props(el);
    if (p['clip-path'] || p.mask) warn('clip-path/mask öznitelikleri yok sayıldı');
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
      case 'image': case 'foreignObject':
        warn(`<${el.name}> (raster/HTML) desteklenmiyor; atlandı`);
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
