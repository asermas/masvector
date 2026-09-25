import type { Filter, Frame, Paint, Style, SubPath, VDocument, VNode } from '../common/types.js';
import { toSvgTransform } from '../math/matrix.js';
import { toPathData } from './path-data.js';

// XML 1.0'da yasak karakterler (sekme/satır sonu dışındaki kontrol karakterleri, eşlenmemiş vekil yarımlar) atılır:
// aksi hâlde dışa aktarılan SVG geçersiz XML olur ve tarayıcılar/editörler dosyayı açmaz.
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const esc = (s: string) => s.replace(XML_INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 1000) / 1000);

class Defs {
  items: string[] = [];
  private k = 0;
  id(prefix: string) { return `${prefix}${++this.k}`; }
  paint(p: Paint): string {
    if (typeof p === 'string') return p;
    const id = this.id(p.type === 'linear' ? 'lg' : 'rg');
    const stops = p.stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${esc(s.color)}"${s.opacity !== undefined ? ` stop-opacity="${n(s.opacity)}"` : ''}/>`).join('');
    if (p.type === 'linear')
      this.items.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}">${stops}</linearGradient>`);
    else
      this.items.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}"${p.fx !== undefined ? ` fx="${n(p.fx)}"` : ''}${p.fy !== undefined ? ` fy="${n(p.fy)}"` : ''}>${stops}</radialGradient>`);
    return `url(#${id})`;
  }
  clip(sps: SubPath[], rule: string): string {
    const id = this.id('cp');
    this.items.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${toPathData(sps)}"${rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
    return `url(#${id})`;
  }
  filter(fs: Filter[]): string {
    const id = this.id('fx');
    const prim = fs.map((f) => f.type === 'blur'
      ? `<feGaussianBlur stdDeviation="${n(f.radius / 2)}"/>`
      : `<feDropShadow dx="${n(f.dx)}" dy="${n(f.dy)}" stdDeviation="${n(f.blur / 2)}" flood-color="${esc(f.color)}"/>`).join('');
    this.items.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${prim}</filter>`);
    return `url(#${id})`;
  }
}

function styleAttrs(s: Style, defs: Defs, isGroup: boolean): string {
  const a: string[] = [];
  if (!isGroup) {
    a.push(`fill="${esc(defs.paint(s.fill))}"`);
    if (s.stroke !== 'none') {
      a.push(`stroke="${esc(defs.paint(s.stroke))}"`, `stroke-width="${n(s.strokeWidth)}"`);
      if (s.strokeLinecap) a.push(`stroke-linecap="${s.strokeLinecap}"`);
      if (s.strokeLinejoin) a.push(`stroke-linejoin="${s.strokeLinejoin}"`);
      if (s.strokeDasharray?.length) a.push(`stroke-dasharray="${s.strokeDasharray.map(n).join(' ')}"`);
      if (s.strokeOpacity !== undefined && s.strokeOpacity !== 1) a.push(`stroke-opacity="${n(s.strokeOpacity)}"`);
    }
    if (s.fillOpacity !== undefined && s.fillOpacity !== 1) a.push(`fill-opacity="${n(s.fillOpacity)}"`);
  }
  if (s.opacity !== 1) a.push(`opacity="${n(s.opacity)}"`);
  if (s.blendMode !== 'normal') a.push(`style="mix-blend-mode:${s.blendMode}"`);
  if (s.filters.length) a.push(`filter="${defs.filter(s.filters)}"`);
  return a.join(' ');
}

function nodeToSvg(node: VNode, defs: Defs, indent: string, skipHidden = false): string {
  if (!node.visible && (node.type !== 'group' || skipHidden)) return '';
  const t = toSvgTransform(node.transform);
  const common = [`id="${esc(node.id)}"`];
  if (node.name) common.push(`data-name="${esc(node.name)}"`);
  if (t) common.push(`transform="${t}"`);
  if (!node.visible) common.push('display="none"');
  if (node.locked) common.push('data-locked="true"');
  const st = styleAttrs(node.style, defs, node.type === 'group');
  const attrs = (extra: string) => [...common, extra, st].filter(Boolean).join(' ');
  switch (node.type) {
    case 'path':
      return `${indent}<path ${attrs(`d="${toPathData(node.subpaths)}"${node.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}`)}/>`;
    case 'rect':
      return `${indent}<rect ${attrs(`x="${n(node.x)}" y="${n(node.y)}" width="${n(node.width)}" height="${n(node.height)}"${node.rx ? ` rx="${n(node.rx)}"` : ''}${node.ry ? ` ry="${n(node.ry)}"` : ''}`)}/>`;
    case 'ellipse': {
      const rx = node.width / 2, ry = node.height / 2;
      return `${indent}<ellipse ${attrs(`cx="${n(node.x + rx)}" cy="${n(node.y + ry)}" rx="${n(rx)}" ry="${n(ry)}"`)}/>`;
    }
    case 'line':
      return `${indent}<line ${attrs(`x1="${n(node.x1)}" y1="${n(node.y1)}" x2="${n(node.x2)}" y2="${n(node.y2)}"`)}/>`;
    case 'text':
      return `${indent}<text ${attrs(`x="${n(node.x)}" y="${n(node.y)}" font-size="${n(node.fontSize)}" font-family="${esc(node.fontFamily)}"${node.fontWeight ? ` font-weight="${esc(node.fontWeight)}"` : ''}${node.textAnchor && node.textAnchor !== 'start' ? ` text-anchor="${node.textAnchor}"` : ''}`)}>${esc(node.content)}</text>`;
    case 'image':
      return `${indent}<image ${attrs(`x="${n(node.x)}" y="${n(node.y)}" width="${n(node.width)}" height="${n(node.height)}" preserveAspectRatio="none" xlink:href="${esc(node.href)}"`)}/>`;
    case 'group': {
      const kids = node.children.map((c) => nodeToSvg(c, defs, indent + '  ', skipHidden)).filter(Boolean).join('\n');
      const extra = [node.isLayer ? 'data-layer="true"' : '', node.clip ? `clip-path="${defs.clip(node.clip.subpaths, node.clip.rule)}"` : ''].filter(Boolean).join(' ');
      return `${indent}<g ${attrs(extra)}>${kids ? `\n${kids}\n${indent}` : ''}</g>`;
    }
  }
}

/** Tek frame'i bağımsız SVG olarak dışa aktar (frame kendi koordinat sisteminde, 0,0 sol-üst). */
export function frameToSVG(frame: Frame, opts: { background?: boolean; skipHidden?: boolean } = {}): string {
  const defs = new Defs();
  const body = frame.nodes.map((c) => nodeToSvg(c, defs, '  ', opts.skipHidden)).filter(Boolean).join('\n');
  const bg = opts.background !== false && frame.background && frame.background !== 'none'
    ? `  <rect data-frame-background="true" x="0" y="0" width="${n(frame.w)}" height="${n(frame.h)}" fill="${esc(frame.background)}"/>\n` : '';
  const d = defs.items.length ? `  <defs>\n    ${defs.items.join('\n    ')}\n  </defs>\n` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(frame.w)}" height="${n(frame.h)}" viewBox="0 0 ${n(frame.w)} ${n(frame.h)}" data-frame-id="${esc(frame.id)}" data-frame-name="${esc(frame.name)}">\n${d}${bg}${body}\n</svg>\n`;
}

/** Belgeyi SVG'ye aktar: varsayılan olarak ilk sayfanın ilk frame'i (ya da frameId). */
export function documentToSVG(doc: VDocument, frameId?: string, opts: { background?: boolean; skipHidden?: boolean } = {}): string {
  for (const p of doc.pages) for (const f of p.frames) if (!frameId || f.id === frameId) return frameToSVG(f, opts);
  throw new Error(`Frame bulunamadı: ${frameId}`);
}
