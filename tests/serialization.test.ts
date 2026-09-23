import { describe, expect, it } from 'vitest';
import { importSVG } from '../src/serialization/svg-import.js';
import { documentToSVG } from '../src/serialization/svg-export.js';
import { parseJSON, serializeJSON } from '../src/serialization/json.js';
import { documentToPDF } from '../src/serialization/pdf-export.js';
import { renderPNG } from '../src/render/png.js';
import { nodeBBox } from '../src/math/geometry.js';
import { walk } from '../src/model/scene.js';
import type { VDocument, VNode } from '../src/common/types.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const COMPLEX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="300" viewBox="0 0 400 300">
  <!-- yorum -->
  <style>.accent { fill: #ff6600; stroke: #222; stroke-width: 3 } #special { opacity: 0.5 }</style>
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00f"/><stop offset="100%" stop-color="#0ff"/></linearGradient>
    <radialGradient id="g2" cx="50" cy="50" r="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black" stop-opacity="0.5"/></radialGradient>
    <linearGradient id="g3" xlink:href="#g1" x2="0" y2="1"/>
    <path id="tri" d="M0 0 L20 0 L10 15 Z"/>
    <filter id="sh"><feDropShadow dx="2" dy="3" stdDeviation="2" flood-color="#000"/></filter>
  </defs>
  <g id="layer1" transform="translate(10 20) rotate(15)" fill="green" stroke-width="2">
    <rect id="r1" x="0" y="0" width="80" height="40" rx="6" fill="url(#g1)"/>
    <circle cx="120" cy="20" r="18" class="accent"/>
    <ellipse id="special" cx="200" cy="30" rx="30" ry="12" style="fill:rgb(10,20,30);stroke:none"/>
    <path d="M10 80 c 20 -30 40 -30 60 0 s 40 30 60 0 q 20 -20 40 0 t 40 0 a 20 10 30 0 1 30 20 z" fill-rule="evenodd"/>
    <g opacity="0.7"><polygon points="250,80 280,110 220,110"/><polyline points="0,150 30,130 60,150" fill="none" stroke="#333"/></g>
  </g>
  <line x1="0" y1="290" x2="400" y2="290" stroke="currentColor" color="#abc" stroke-dasharray="4 2"/>
  <text x="200" y="250" font-size="24" font-family="Inter" text-anchor="middle" fill="#111">Merhaba &amp; <tspan>Dünya</tspan></text>
  <use xlink:href="#tri" x="300" y="200" fill="url(#g3)"/>
  <circle cx="50" cy="50" r="40" fill="url(#g2)" filter="url(#sh)"/>
</svg>`;

function signature(doc: VDocument) {
  const f = doc.pages[0].frames[0];
  const out: unknown[] = [];
  for (const w of walk(f.nodes)) {
    const n = w.node as VNode;
    const b = n.type === 'group' ? null : nodeBBox(n);
    out.push({
      type: n.type, visible: n.visible,
      fill: typeof n.style.fill === 'string' ? n.style.fill : n.style.fill.type,
      stroke: typeof n.style.stroke === 'string' ? n.style.stroke : 'grad',
      op: +n.style.opacity.toFixed(4),
      bbox: b && [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 100) / 100),
      t: [n.transform.a, n.transform.b, n.transform.c, n.transform.d, n.transform.e, n.transform.f].map((v) => Math.round(v * 1e4) / 1e4),
    });
  }
  return out;
}

describe('SVG içe/dışa aktarma', () => {
  it('karmaşık SVG → doc → SVG → doc round-trip eşdeğer', () => {
    const a = importSVG(COMPLEX);
    const svg1 = documentToSVG(a.doc);
    const b = importSVG(svg1);
    expect(signature(b.doc)).toEqual(signature(a.doc));
    // ikinci tur metin olarak da kararlı olmalı
    expect(documentToSVG(b.doc).replace(/(lg|rg|fx)\d+/g, 'X')).toBe(svg1.replace(/(lg|rg|fx)\d+/g, 'X'));
    expect(b.warnings).toEqual([]);
  });

  it('stil kalıtımı, CSS sınıfları, gradyan href, use, currentColor çözülür', () => {
    const { doc, warnings } = importSVG(COMPLEX);
    const nodes = [...walk(doc.pages[0].frames[0].nodes)].map((w) => w.node);
    const byId = (id: string) => nodes.find((n) => n.id === id)!;
    const circle = nodes.find((n) => n.type === 'ellipse' && n.style.fill === '#ff6600')!;
    expect(circle.style.stroke).toBe('#222222');
    expect(circle.style.strokeWidth).toBe(3);
    expect(byId('special').style.opacity).toBe(0.5);
    expect(byId('special').style.fill).toBe('#0a141e');
    const r1 = byId('r1');
    expect(typeof r1.style.fill).toBe('object');
    expect((r1.style.fill as any).x2).toBeCloseTo(80); // objectBoundingBox → userSpace
    const poly = nodes.find((n) => n.type === 'path' && (n as any).subpaths[0].points.length === 3 && (n as any).subpaths[0].closed && n.style.fill === '#008000')!;
    expect(poly).toBeTruthy(); // grup fill kalıtımı
    const line = nodes.find((n) => n.type === 'line')!;
    expect(line.style.stroke).toBe('#aabbcc');
    expect(line.style.strokeDasharray).toEqual([4, 2]);
    const text = nodes.find((n) => n.type === 'text') as any;
    expect(text.content).toBe('Merhaba & Dünya');
    expect(text.textAnchor).toBe('middle');
    const use = nodes.find((n) => n.type === 'group' && n.transform.e === 300)! as any;
    expect(use.children[0].type).toBe('path');
    expect((use.children[0].style.fill as any).y2).toBeCloseTo(15);
    const sh = nodes.find((n) => n.style.filters.length)!;
    expect(sh.style.filters[0]).toEqual({ type: 'drop-shadow', dx: 2, dy: 3, blur: 4, color: '#000000' });
    expect(warnings.some((w) => w.includes('tspan'))).toBe(true);
  });

  it('viewBox ölçeği gruba sarılır', () => {
    const { doc } = importSVG('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 100 100"><rect x="10" y="10" width="10" height="10"/></svg>');
    const g = doc.pages[0].frames[0].nodes[0] as any;
    expect(g.type).toBe('group');
    const b = nodeBBox(g);
    expect([b.minX, b.maxX]).toEqual([20, 40]);
  });

  it('bozuk XML anlamlı hata verir', () => {
    expect(() => importSVG('<svg><rect></svg>')).toThrow(/XML/);
    expect(() => importSVG('<html/>')).toThrow(/svg/);
  });
});

describe('JSON', () => {
  it('serialize → parse birebir', () => {
    const { doc } = importSVG(COMPLEX);
    expect(parseJSON(serializeJSON(doc))).toEqual(doc);
  });
  it('geçersiz belgeyi reddeder', () => {
    expect(() => parseJSON('{"x":1}')).toThrow(/MasVector/);
  });
});

describe('PNG / PDF', () => {
  it('PNG doğru boyutta ve beklenen piksel renginde', async () => {
    const { doc } = importSVG('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect x="0" y="0" width="50" height="50" fill="#ff0000"/><rect x="50" y="0" width="50" height="50" fill="#0000ff" opacity="0.5"/></svg>');
    doc.pages[0].frames[0].background = '#ffffff';
    const r = renderPNG(doc, { scale: 2 });
    expect([r.width, r.height]).toEqual([200, 100]);
    const img = await loadImage(r.png);
    const c = createCanvas(200, 100); const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    expect([...ctx.getImageData(50, 50, 1, 1).data]).toEqual([255, 0, 0, 255]);
    const [rr, gg, bb] = ctx.getImageData(150, 50, 1, 1).data;
    expect(rr).toBeGreaterThan(120); expect(gg).toBeGreaterThan(120); expect(bb).toBe(255);
  });

  it('PDF geçerli yapıda ve vektör operatörleri içerir', () => {
    const { doc } = importSVG(COMPLEX);
    const { pdf } = documentToPDF(doc);
    const s = pdf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toMatch(/ c\n/); // kübik Bézier
    expect(s).toMatch(/\/ShadingType 2/);
    expect(s).toMatch(/\/Helvetica/);
    // xref ofsetleri gerçekten nesnelere işaret etmeli
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    const offs = [...s.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});
