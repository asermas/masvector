import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { importSVG } from '../src/serialization/svg-import.js';
import { frameToSVG } from '../src/serialization/svg-export.js';
import { documentToPDF } from '../src/serialization/pdf-export.js';
import { cleanupFrame } from '../src/serialization/cleanup.js';
import { combineMaskImages } from '../src/render/image-ops.js';
import { decodeImageBuffer } from '../src/render/png.js';
import { compareDocument } from '../src/vectorize/compare.js';
import { pdfToDoc, vectorizeImageToDoc } from '../src/vectorize/index.js';
import { popplerAvailable, popplerBin, popplerEnv } from '../src/vectorize/pdf.js';
import { traceImage } from '../src/vectorize/trace.js';
import { walk } from '../src/model/scene.js';
import type { PathNode, VDocument } from '../src/common/types.js';

const FX = path.resolve('tests/fixtures');
const hasPoppler = popplerAvailable();
const leaves = (doc: VDocument) => [...walk(doc.pages[0].frames[0].nodes)].map((w) => w.node);
const vectorPaths = (doc: VDocument) => leaves(doc).filter((n): n is PathNode => n.type === 'path');

describe.skipIf(!hasPoppler)('PDF → vektör', () => {
  it('vektör PDF: poppler render\'ıyla piksel uyumu mükemmel, yapı sadeleşir', async () => {
    const r = await pdfToDoc(path.join(FX, 'vector.pdf'));
    const rep = r.reports[0] as any;
    expect(rep.kind).toBe('pdf-vector');
    expect(rep.fidelity.pctOff).toBeLessThan(0.25);
    expect(rep.cleanup.nodesAfter).toBeLessThan(rep.cleanup.nodesBefore / 5);
    const nodes = leaves(r.doc);
    expect(nodes.some((n) => n.type === 'image')).toBe(true);                        // alfalı görsel korundu
    expect(nodes.some((n) => n.type === 'path' && typeof n.style.fill === 'object' && n.style.fill.type === 'radial')).toBe(true);
    expect(r.doc.pages[0].frames[0].background).toBe('#f7f5ed');                       // sayfa zemini frame arka planı oldu
  }, 60_000);

  it('taranmış PDF tespit edilir ve izlenir', async () => {
    const r = await pdfToDoc(path.join(FX, 'scanned.pdf'));
    const rep = r.reports[0] as any;
    expect(rep.kind).toBe('pdf-scanned');
    expect(rep.fidelity.pctOff).toBeLessThan(1);
    expect(rep.palette.length).toBeGreaterThanOrEqual(3);
  }, 60_000);
});

describe('SVG içe aktarma: kırpma, maske, görsel', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100">
    <defs><clipPath id="c"><circle cx="50" cy="50" r="40"/></clipPath>
      <pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="10" fill="#0a0"/></pattern></defs>
    <rect width="100" height="100" fill="#c00" clip-path="url(#c)"/>
    <rect x="110" y="10" width="80" height="80" fill="url(#p)"/>
  </svg>`;
  it('clip-path kırpma maskesine, desen karo gruplarına dönüşür; render doğru', () => {
    const r = importSVG(svg);
    const g = r.frame.nodes[0] as any;
    expect(g.type).toBe('group');
    expect(g.clip.subpaths).toHaveLength(1);
    const pat = r.frame.nodes[1] as any;
    expect(pat.clip).toBeTruthy();
    expect(r.warnings).toEqual([]);
    // Çıktıyı Chromium-benzeri referansla değil, geometrik beklentiyle doğrula
    const c = createCanvas(200, 100); const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 100);
    x.fillStyle = '#c00'; x.beginPath(); x.arc(50, 50, 40, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#0a0'; for (let i = 110; i < 190; i += 10) x.fillRect(i, 10, 5, 80);
    const ref = x.getImageData(0, 0, 200, 100).data;
    expect(compareDocument(r.doc, { rgba: ref, width: 200, height: 100 }).metrics.pctOff).toBeLessThan(0.5);
  });
  it('kırpma + görsel SVG ve PDF\'e yazılır, SVG geri okunur', () => {
    const r = importSVG(svg);
    const out = frameToSVG(r.frame);
    expect(out).toContain('<clipPath');
    const again = importSVG(out);
    expect((again.frame.nodes[0] as any).clip).toBeTruthy();
    const png = createCanvas(4, 4).toBuffer('image/png').toString('base64');
    r.frame.nodes.push({ type: 'image', id: 'im', transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, style: { fill: 'none', stroke: 'none', strokeWidth: 1, opacity: 1, blendMode: 'normal', filters: [] }, visible: true, locked: false, x: 0, y: 0, width: 4, height: 4, href: `data:image/png;base64,${png}` });
    const pdf = documentToPDF(r.doc).pdf.toString('latin1');
    expect(pdf).toMatch(/W n/);
    expect(pdf).toMatch(/\/XObject << \/Im1/);
  });
  it('temizlik görüntüyü değiştirmez', () => {
    if (!hasPoppler) return;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mv-'));
    const o = { env: popplerEnv(), windowsHide: true };
    execFileSync(popplerBin('pdftocairo'), ['-svg', path.join(FX, 'vector.pdf'), `${tmp}/v.svg`], o);
    execFileSync(popplerBin('pdftoppm'), ['-r', '72', '-png', '-singlefile', path.join(FX, 'vector.pdf'), `${tmp}/v`], o);
    const r = importSVG(readFileSync(`${tmp}/v.svg`, 'utf8'), { combineMask: combineMaskImages });
    const ref = decodeImageBuffer(readFileSync(`${tmp}/v.png`))!;
    const before = compareDocument(r.doc, ref).metrics.pctOff;
    cleanupFrame(r.frame);
    const after = compareDocument(r.doc, ref).metrics.pctOff;
    expect(Math.abs(after - before)).toBeLessThan(0.05);
  });
});

describe('raster izleme', () => {
  it('temiz logo: mükemmel sadakat, sivri üçgen 3 çapa, noktalar korunur, gizli geometri yok', async () => {
    const buf = readFileSync(path.join(FX, 'logo.png'));
    const r = await vectorizeImageToDoc(buf);
    expect(r.report.fidelity!.pctOff).toBeLessThan(0.25);
    const paths = vectorPaths(r.doc);
    const tri = paths.find((p) => p.style.fill === '#f3a619')!;
    expect(tri.subpaths).toHaveLength(1);
    expect(tri.subpaths[0].points.length).toBeLessThanOrEqual(4);
    const navy = paths.find((p) => p.style.fill === '#193373')!;
    expect(navy.subpaths.length).toBeGreaterThanOrEqual(10); // dikdörtgen + harfler + delikler + noktalar
    const red = paths.find((p) => p.style.fill === '#d91933')!;
    expect(red.subpaths).toHaveLength(2); // yalnız halka (dış + delik) — üst katmanların gizli kopyası yok
    expect(r.doc.pages[0].frames[0].background).toBe('#ffffff');
    const refLayer = r.doc.pages[0].frames[0].nodes[0] as any;
    expect(refLayer.locked && !refLayer.visible && refLayer.children[0].type === 'image').toBe(true);
  }, 60_000);

  it('JPEG gürültüsü ve küçük çözünürlük dayanıklılığı', async () => {
    const q = await vectorizeImageToDoc(readFileSync(path.join(FX, 'logo-q55.jpg')));
    expect(q.report.fidelity!.pctOff).toBeLessThan(0.5);
    const s = await vectorizeImageToDoc(readFileSync(path.join(FX, 'logo-small.jpg')));
    expect(s.report.fidelity!.pctOff).toBeLessThan(1.5);
    const ring = vectorPaths(s.doc).find((p) => /^#d[89]/.test(String(p.style.fill)))!;
    expect(ring.subpaths).toHaveLength(2); // halka deliği korunur
  }, 90_000);

  it('sabit palet birebir kullanılır; saydam alanlar boş kalır', async () => {
    const c = createCanvas(300, 200); const x = c.getContext('2d');
    x.fillStyle = '#e63946'; x.beginPath(); x.arc(100, 100, 70, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#1d3557'; x.fillRect(180, 40, 90, 120);
    const r = await traceImage(c.toBuffer('image/png'), { palette: ['#e63946', '#1d3557'] });
    expect(r.palette.map((p) => p.color).sort()).toEqual(['#1d3557', '#e63946']);
    expect(r.background).toBeNull();
    const doc = { id: 'd', title: 't', version: 0, pages: [{ id: 'p', name: 'p', guides: [], grid: { size: 8, enabled: false }, frames: [{ id: 'f', name: 'f', x: 0, y: 0, w: 300, h: 200, background: 'none', nodes: [r.group] }] }] } as VDocument;
    const m = compareDocument(doc, { rgba: x.getImageData(0, 0, 300, 200).data, width: 300, height: 200 }).metrics;
    expect(m.pctOff).toBeLessThan(0.5);
  }, 60_000);

  it('gradyanlı illüstrasyon: gradyanlar gerçek doğrusal/radyal gradyan olarak geri kazanılır', async () => {
    const r = await vectorizeImageToDoc(readFileSync(path.join(FX, 'illustration.png')));
    expect(r.report.fidelity!.pctOff).toBeLessThan(0.3);
    const grads = vectorPaths(r.doc).filter((p) => typeof p.style.fill !== 'string');
    expect(grads.some((p) => (p.style.fill as any).type === 'linear')).toBe(true);
    expect(grads.some((p) => (p.style.fill as any).type === 'radial')).toBe(true);
  }, 120_000);

  it('yarı saydam yumuşak gölge korunur (alfa gradyanı / fillOpacity)', async () => {
    const c = createCanvas(240, 240); const x = c.getContext('2d');
    x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 16; x.shadowOffsetY = 6;
    x.fillStyle = '#2a9d8f'; x.beginPath(); x.roundRect(40, 30, 160, 160, 28); x.fill();
    const buf = c.toBuffer('image/png');
    const r = await vectorizeImageToDoc(buf);
    const hasAlpha = vectorPaths(r.doc).some((p) => (p.style.fillOpacity ?? 1) < 1 || (p.style.opacity ?? 1) < 1 || (typeof p.style.fill !== 'string' && p.style.fill.stops.some((s) => (s.opacity ?? 1) < 1)));
    expect(hasAlpha).toBe(true);
    expect(r.report.fidelity!.pctOff).toBeLessThan(1);
  }, 120_000);
});

describe('v1.1 zor girdiler', () => {
  const doc1 = (r: { doc: VDocument }) => r.doc;
  it('1–2 px ince çizgiler kaybolmaz (ince yapı renkleri + çizgi benzeri piksel atama)', async () => {
    const c = createCanvas(600, 400); const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 400);
    x.strokeStyle = '#141414'; x.lineWidth = 12; x.beginPath(); x.moveTo(20, 380); x.lineTo(580, 20); x.stroke();
    x.lineWidth = 1; x.beginPath(); x.moveTo(20, 20); x.lineTo(580, 380); x.stroke();
    x.strokeStyle = '#c80000'; x.lineWidth = 1.5; x.beginPath(); x.arc(300, 200, 120, 0, Math.PI * 2); x.stroke();
    const r = await vectorizeImageToDoc(c.toBuffer('image/png'));
    const paths = vectorPaths(doc1(r));
    // kırmızı çember çizgisi ayrı renk olarak geri kazanılır; 1 px siyah çizgi silinmez
    expect(paths.some((p) => { const f = String(p.style.fill); return /^#[a-f0-9]{6}$/.test(f) && parseInt(f.slice(1, 3), 16) > 150 && parseInt(f.slice(3, 5), 16) < 90; })).toBe(true);
    expect(r.report.fidelity!.pctOff).toBeLessThan(1);
  }, 120_000);

  it('kaydırılmış yumuşak gölge: bulanık şekil kaymayla yerleşir, hale oluşmaz', async () => {
    const c = createCanvas(400, 300); const x = c.getContext('2d');
    x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = 30; x.shadowOffsetX = 18; x.shadowOffsetY = 26;
    x.fillStyle = '#ffffff'; x.beginPath(); x.roundRect(70, 50, 220, 160, 24); x.fill();
    const r = await vectorizeImageToDoc(c.toBuffer('image/png'));
    expect(r.report.fidelity!.pctOff).toBeLessThan(0.5);
    const blurred = vectorPaths(doc1(r)).filter((p) => p.style.filters.some((f) => f.type === 'blur'));
    expect(blurred.length).toBe(1);
  }, 120_000);

  it('dama / titreşim deseni ve 16 px ikon: piksel-birebir, anında', async () => {
    const c = createCanvas(64, 64); const x = c.getContext('2d');
    for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) { x.fillStyle = (i + j) % 2 ? '#000' : '#fff'; x.fillRect(i, j, 1, 1); }
    const t = Date.now();
    const r = await vectorizeImageToDoc(c.toBuffer('image/png'));
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r.report.fidelity!.pctOff).toBe(0);
    expect(r.report.warnings.join(' ')).toMatch(/piksel-birebir/);
    const s = createCanvas(16, 16); const y = s.getContext('2d');
    y.fillStyle = '#193373'; y.beginPath(); y.roundRect(1.5, 1.5, 13, 13, 3); y.fill(); y.fillStyle = '#d91933'; y.beginPath(); y.arc(8, 7, 3.3, 0, 7); y.fill();
    const q = await vectorizeImageToDoc(s.toBuffer('image/png'));
    expect(q.report.fidelity!.pctOff).toBeLessThan(0.5);
  }, 60_000);

  it('gürültülü logo: ölçüt kenar koruyan temizlenmiş kaynağa karşı, fotoğraf uyarısı yok', async () => {
    const c = createCanvas(300, 300); const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 300); x.fillStyle = '#193373'; x.fillRect(40, 40, 220, 220); x.fillStyle = '#d91933'; x.beginPath(); x.arc(150, 150, 70, 0, 7); x.fill();
    const d = x.getImageData(0, 0, 300, 300);
    let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < d.data.length; i += 4) for (let k = 0; k < 3; k++) d.data[i + k] = Math.max(0, Math.min(255, d.data[i + k] + (rnd() + rnd() + rnd() - 1.5) * 40));
    x.putImageData(d, 0, 0);
    const r = await vectorizeImageToDoc(c.toBuffer('image/png'));
    expect(r.report.fidelity!.pctOff).toBeLessThan(0.5);
    expect(r.report.warnings.join(' ')).not.toMatch(/Fotoğraf/);
    expect(vectorPaths(doc1(r)).length).toBeLessThanOrEqual(4);
  }, 120_000);
});
