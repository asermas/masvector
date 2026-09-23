import type { Frame, Matrix, Paint, Style, SubPath, VDocument, VNode } from '../common/types.js';
import { segments } from '../math/bezier.js';
import { nodeSubPaths } from '../math/geometry.js';
import { multiply } from '../math/matrix.js';
import { findFrame } from '../model/scene.js';
import { parseColor } from './color.js';

// Bağımlılıksız vektör PDF yazıcı: kübik Bézier'ler PDF'e doğrudan (c operatörü), gradyanlar
// gerçek PDF shading olarak, opaklık/karışım ExtGState ile. Metin standart 14 fonttan Helvetica.

const f = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(Math.round(n * 10000) / 10000));

const WIN_ANSI_FALLBACK: Record<string, string> = { 'ş': 's', 'Ş': 'S', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I' };

function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = WIN_ANSI_FALLBACK[ch] ?? ch;
    const code = c.codePointAt(0)!;
    if (c === '(' || c === ')' || c === '\\') out += '\\' + c;
    else if (code < 32) out += ' ';
    else if (code < 128) out += c;
    else if (code < 256) out += '\\' + code.toString(8).padStart(3, '0');
    else out += '?';
  }
  return `(${out})`;
}

const BLEND_PDF: Record<string, string> = {
  normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten',
  'color-dodge': 'ColorDodge', 'color-burn': 'ColorBurn', 'hard-light': 'HardLight', 'soft-light': 'SoftLight',
  difference: 'Difference', exclusion: 'Exclusion',
};

export function documentToPDF(doc: VDocument, frameId?: string): { pdf: Buffer; warnings: string[] } {
  const { frame } = findFrame(doc, frameId);
  const w = new PdfWriter(frame);
  return { pdf: w.build(), warnings: [...w.warnings] };
}

class PdfWriter {
  warnings = new Set<string>();
  private gs = new Map<string, string>();
  private shadings: string[] = [];
  private ops: string[] = [];
  private usesFont = new Set<string>();

  constructor(private frame: Frame) {}

  private extGState(fillA: number, strokeA: number, blend: string): string {
    const key = `${f(fillA)}|${f(strokeA)}|${blend}`;
    let name = this.gs.get(key);
    if (!name) { name = `GS${this.gs.size + 1}`; this.gs.set(key, name); }
    return name;
  }

  private color(p: string, op: 'rg' | 'RG'): number | null {
    const c = parseColor(p);
    if (!c) { this.warnings.add(`Tanınmayan renk "${p}" siyah alındı`); this.ops.push(`0 0 0 ${op}`); return 1; }
    this.ops.push(`${f(c[0])} ${f(c[1])} ${f(c[2])} ${op}`);
    return c[3];
  }

  private shading(p: Exclude<Paint, string>): string {
    const stops = [...p.stops].sort((a, b) => a.offset - b.offset);
    if (stops.some((s) => s.opacity !== undefined && s.opacity < 1)) this.warnings.add('PDF: gradyan durak opaklığı yok sayıldı');
    const rgb = (c: string) => (parseColor(c) ?? [0, 0, 0, 1]).slice(0, 3).map(f).join(' ');
    let fn: string;
    if (stops.length === 1) fn = `<< /FunctionType 2 /Domain [0 1] /C0 [${rgb(stops[0].color)}] /C1 [${rgb(stops[0].color)}] /N 1 >>`;
    else {
      const parts: string[] = [], bounds: string[] = [], encode: string[] = [];
      const s0 = stops[0].offset, s1 = stops[stops.length - 1].offset;
      for (let i = 0; i < stops.length - 1; i++) {
        parts.push(`<< /FunctionType 2 /Domain [0 1] /C0 [${rgb(stops[i].color)}] /C1 [${rgb(stops[i + 1].color)}] /N 1 >>`);
        if (i > 0) bounds.push(f(stops[i].offset));
        encode.push('0 1');
      }
      fn = `<< /FunctionType 3 /Domain [${f(s0)} ${f(s1 === s0 ? s0 + 1e-6 : s1)}] /Functions [${parts.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${encode.join(' ')}] >>`;
    }
    const coords = p.type === 'linear'
      ? `/ShadingType 2 /Coords [${f(p.x1)} ${f(p.y1)} ${f(p.x2)} ${f(p.y2)}]`
      : `/ShadingType 3 /Coords [${f(p.fx ?? p.cx)} ${f(p.fy ?? p.cy)} 0 ${f(p.cx)} ${f(p.cy)} ${f(p.r)}]`;
    const domain = stops.length > 1 ? `/Domain [${f(stops[0].offset)} ${f(stops[stops.length - 1].offset)}]` : '';
    this.shadings.push(`<< ${coords} /ColorSpace /DeviceRGB /Function ${fn} ${domain} /Extend [true true] >>`);
    return `Sh${this.shadings.length}`;
  }

  private path(sps: SubPath[]) {
    for (const sp of sps) {
      if (!sp.points.length) continue;
      this.ops.push(`${f(sp.points[0].x)} ${f(sp.points[0].y)} m`);
      for (const c of segments(sp)) {
        const straight = c.p1.x === c.p0.x && c.p1.y === c.p0.y && c.p2.x === c.p3.x && c.p2.y === c.p3.y;
        this.ops.push(straight ? `${f(c.p3.x)} ${f(c.p3.y)} l` : `${f(c.p1.x)} ${f(c.p1.y)} ${f(c.p2.x)} ${f(c.p2.y)} ${f(c.p3.x)} ${f(c.p3.y)} c`);
      }
      if (sp.closed) this.ops.push('h');
    }
  }

  private cm(m: Matrix) { this.ops.push(`${f(m.a)} ${f(m.b)} ${f(m.c)} ${f(m.d)} ${f(m.e)} ${f(m.f)} cm`); }

  private leaf(n: Exclude<VNode, { type: 'group' }>, m: Matrix, alpha: number) {
    const s: Style = n.style;
    if (s.filters.length) this.warnings.add('PDF: filtreler (blur/gölge) dışa aktarılmadı');
    const blend = BLEND_PDF[s.blendMode] ?? 'Normal';
    const fa = alpha * s.opacity * (s.fillOpacity ?? 1), sa = alpha * s.opacity * (s.strokeOpacity ?? 1);

    if (n.type === 'text') {
      if (typeof s.fill !== 'string') this.warnings.add('PDF: metin gradyanı düz renge indirildi');
      this.ops.push('q'); this.cm(m);
      const fillCol = typeof s.fill === 'string' ? s.fill : s.fill.stops[0]?.color ?? '#000';
      if (fillCol === 'none') { this.ops.push('Q'); return; }
      const bold = /bold|[6-9]00/.test(n.fontWeight ?? '');
      const font = bold ? 'F2' : 'F1';
      this.usesFont.add(font);
      const ca = this.color(fillCol, 'rg') ?? 1;
      this.ops.push(`/${this.extGState(fa * ca, sa, blend)} gs`);
      const width = estimate(n.content, n.fontSize, bold);
      const x = n.textAnchor === 'middle' ? n.x - width / 2 : n.textAnchor === 'end' ? n.x - width : n.x;
      if (/[^\x00-\xff]/.test(n.content.replace(/[şŞğĞıİ]/g, ''))) this.warnings.add('PDF: WinAnsi dışı karakterler "?" oldu');
      if (/[şŞğĞıİ]/.test(n.content)) this.warnings.add('PDF: ş/ğ/ı gibi Türkçe harfler standart fontta yok; en yakın ASCII harfle yazıldı (SVG/PNG export tam destekler)');
      // Sayfa y-aşağı çevrildiği için metni yeniden düzelt
      this.ops.push(`BT /${font} ${f(n.fontSize)} Tf 1 0 0 -1 ${f(x)} ${f(n.y)} Tm ${pdfString(n.content)} Tj ET`, 'Q');
      return;
    }

    const sps = nodeSubPaths(n);
    const even = n.type === 'path' && n.fillRule === 'evenodd';
    // Dolgu
    if (n.type !== 'line' && s.fill !== 'none') {
      this.ops.push('q'); this.cm(m);
      if (typeof s.fill === 'string') {
        const ca = this.color(s.fill, 'rg') ?? 1;
        this.ops.push(`/${this.extGState(fa * ca, sa, blend)} gs`);
        this.path(sps); this.ops.push(even ? 'f*' : 'f');
      } else {
        const sh = this.shading(s.fill);
        this.ops.push(`/${this.extGState(fa, sa, blend)} gs`);
        this.path(sps); this.ops.push(even ? 'W* n' : 'W n', `/${sh} sh`);
      }
      this.ops.push('Q');
    }
    // Kontur
    if (s.stroke !== 'none' && s.strokeWidth > 0) {
      this.ops.push('q'); this.cm(m);
      let ca = 1;
      if (typeof s.stroke === 'string') ca = this.color(s.stroke, 'RG') ?? 1;
      else { this.warnings.add('PDF: gradyan kontur ilk durak rengine indirildi'); ca = this.color(s.stroke.stops[0]?.color ?? '#000', 'RG') ?? 1; }
      this.ops.push(`/${this.extGState(fa, sa * ca, blend)} gs`);
      this.ops.push(`${f(s.strokeWidth)} w`, `${s.strokeLinecap === 'round' ? 1 : s.strokeLinecap === 'square' ? 2 : 0} J`,
        `${s.strokeLinejoin === 'round' ? 1 : s.strokeLinejoin === 'bevel' ? 2 : 0} j`);
      if (s.strokeDasharray?.length) this.ops.push(`[${s.strokeDasharray.map(f).join(' ')}] 0 d`);
      this.path(sps); this.ops.push('S', 'Q');
    }
  }

  private node(n: VNode, parent: Matrix, alpha: number) {
    if (!n.visible) return;
    const m = multiply(parent, n.transform);
    if (n.type === 'group') {
      if (n.style.blendMode !== 'normal' || n.style.filters.length) this.warnings.add('PDF: grup karışım/filtresi yapraklara uygulanmadı');
      for (const c of n.children) this.node(c, m, alpha * n.style.opacity);
    } else this.leaf(n, m, alpha);
  }

  build(): Buffer {
    const { w, h } = this.frame;
    // y-aşağı belge koordinatını PDF'in y-yukarı sistemine çevir
    this.ops.push(`1 0 0 -1 0 ${f(h)} cm`);
    if (this.frame.background && this.frame.background !== 'none') {
      this.color(this.frame.background, 'rg');
      this.ops.push(`0 0 ${f(w)} ${f(h)} re f`);
    }
    const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    for (const n of this.frame.nodes) this.node(n, I, 1);

    const content = this.ops.join('\n');
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const catalog = add('');
    const pages = add('');
    const page = add('');
    const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const gsEntries = [...this.gs.entries()].map(([key, name]) => {
      const [fa, sa, bm] = key.split('|');
      return `/${name} ${add(`<< /Type /ExtGState /ca ${fa} /CA ${sa} /BM /${bm} >>`)} 0 R`;
    });
    const shEntries = this.shadings.map((s, i) => `/Sh${i + 1} ${add(s)} 0 R`);
    const fontEntries: string[] = [];
    if (this.usesFont.has('F1')) fontEntries.push(`/F1 ${add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')} 0 R`);
    if (this.usesFont.has('F2')) fontEntries.push(`/F2 ${add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')} 0 R`);
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
    objs[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
    objs[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${f(w)} ${f(h)}] /Contents ${stream} 0 R ` +
      `/Resources << /ExtGState << ${gsEntries.join(' ')} >> /Shading << ${shEntries.join(' ')} >> /Font << ${fontEntries.join(' ')} >> >> >>`;

    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

/** Helvetica ortalama genişlikleri (1000 birim/em) ile yaklaşık metin genişliği. */
function estimate(s: string, size: number, bold: boolean): number {
  let w = 0;
  for (const ch of s) w += ' .,:;!|il\'"'.includes(ch) ? 278 : 'mwMW@'.includes(ch) ? 833 : ch >= 'A' && ch <= 'Z' ? 667 : 556;
  return (w * (bold ? 1.05 : 1) * size) / 1000;
}
