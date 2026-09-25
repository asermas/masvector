// Uç durum testleri: büyük belgeler, bozuk/dejenere geometri, geçersiz girdi, eşzamanlı ajanlar, bozuk dosyalar.
// Beklenti: hiçbir girdi motoru çökertmez; geçersiz girdi anlamlı hata verir ve belge tutarlı kalır.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DocumentEngine } from '../src/server/engine.js';
import { totalArea } from '../src/model/boolean.js';
import { nodePolygons } from '../src/math/geometry.js';
import { mustLocate, ancestorsMatrix, allNodes } from '../src/model/scene.js';
import { parseJSON, serializeJSON } from '../src/serialization/json.js';
import { vectorizeImageToDoc } from '../src/vectorize/index.js';
import { createCanvas } from '@napi-rs/canvas';

const newEngine = () => new DocumentEngine({ workspace: mkdtempSync(path.join(os.tmpdir(), 'mv-x-')) });
const A = { agentId: 'a' }, B = { agentId: 'b' };
const call = (e: DocumentEngine, m: string, p: any = {}, ctx = A) => e.call(m, p, ctx) as Promise<any>;
const op = (e: DocumentEngine, o: string, args: any, ctx = A) => call(e, 'op', { op: o, args }, ctx);
const area = (e: DocumentEngine, id: string) => { const l = mustLocate(e.doc, id); return totalArea(nodePolygons(l.node, ancestorsMatrix(l.ancestors)).polys); };
const rejects = async (p: Promise<unknown>, code?: RegExp) => {
  let err: any = null;
  try { await p; } catch (e) { err = e; }
  expect(err, 'hata bekleniyordu').not.toBeNull();
  if (code) expect(`${err.code} ${err.message}`).toMatch(code);
};

describe('uç durumlar — ölçek ve performans', () => {
  it('10 000 node tek batch: hızlı, tek undo adımı, geri alınınca belge boş', async () => {
    const e = newEngine();
    await call(e, 'doc_create', { title: 'büyük', width: 2000, height: 2000 });
    const ops = Array.from({ length: 10_000 }, (_, i) => ({ op: 'node_add_rect', args: { x: (i % 100) * 20, y: Math.floor(i / 100) * 20, width: 15, height: 15, style: { fill: `hsl(${i % 360} 70% 50%)` } } }));
    const t = Date.now();
    const r = await call(e, 'batch', { ops, label: '10k' });
    expect(Date.now() - t).toBeLessThan(15_000);
    expect(r.result).toHaveLength(10_000);
    expect(allNodes(e.doc).length).toBeGreaterThanOrEqual(10_000);
    const t2 = Date.now();
    const svg = (await call(e, 'doc_export', { format: 'svg' })).data as string;
    expect(svg.length).toBeGreaterThan(100_000);
    const png = await call(e, 'doc_export', { format: 'png' });
    expect(png.bytes).toBeGreaterThan(1000);
    expect(Date.now() - t2).toBeLessThan(20_000);
    await call(e, 'undo', { force: true });
    expect(allNodes(e.doc).length).toBeLessThan(10);
    await call(e, 'redo', { force: true });
    expect(allNodes(e.doc).length).toBeGreaterThanOrEqual(10_000);
  }, 60_000);

  it('JSON tur dönüşü: 10 000 noktalı path kayıpsız', () => {
    const e = newEngine();
    const pts = Array.from({ length: 10_000 }, (_, i) => ({ x: 500 + 400 * Math.cos(i / 1591.5), y: 500 + 400 * Math.sin(i / 1591.5) }));
    e.op(A, 'node_add_path', { subpaths: [{ closed: true, points: pts }] });
    const back = parseJSON(serializeJSON(e.doc));
    expect(serializeJSON(back)).toBe(serializeJSON(e.doc));
  });
});

describe('uç durumlar — geometri', () => {
  it('boolean: çakışan kenarlar, iç içe, ayrık, tamamen aynı şekiller', async () => {
    const e = newEngine();
    const a = (await op(e, 'node_add_rect', { x: 0, y: 0, width: 100, height: 100 })).result.id;
    const b = (await op(e, 'node_add_rect', { x: 100, y: 0, width: 100, height: 100 })).result.id; // ortak kenar
    const u = (await op(e, 'boolean_union', { ids: [a, b] })).result.id;
    expect(area(e, u)).toBeCloseTo(20_000, 0);
    const c = (await op(e, 'node_add_rect', { x: 10, y: 10, width: 50, height: 50 })).result.id;
    const d = (await op(e, 'node_add_rect', { x: 10, y: 10, width: 50, height: 50 })).result.id; // birebir aynı
    // aynı iki şeklin XOR'u boş: anlamlı hata, belge değişmez
    const before = serializeJSON(e.doc);
    await rejects(op(e, 'boolean_exclude', { ids: [c, d] }), /boş/);
    expect(serializeJSON(e.doc)).toBe(before);
    const f = (await op(e, 'node_add_rect', { x: 1000, y: 1000, width: 5, height: 5 })).result.id;
    const g = (await op(e, 'node_add_rect', { x: 2000, y: 2000, width: 5, height: 5 })).result.id;
    await rejects(op(e, 'boolean_intersect', { ids: [f, g] }), /boş/);
    const h = (await op(e, 'node_add_rect', { x: 0, y: 0, width: 300, height: 300 })).result.id;
    const i = (await op(e, 'node_add_ellipse', { x: 100, y: 100, width: 100, height: 100 })).result.id;
    const s = (await op(e, 'boolean_subtract', { ids: [h, i] })).result.id;
    expect(Math.abs(area(e, s) / (90_000 - Math.PI * 2500) - 1)).toBeLessThan(5e-4); // Bézier çember yaklaşıklığı
  });

  it('boolean: kendi kendini kesen yol, sıfır alanlı şekil, dev ve minik koordinatlar', async () => {
    const e = newEngine();
    const bow = (await op(e, 'node_add_path', { subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }] }] })).result.id;
    const sq = (await op(e, 'node_add_rect', { x: 0, y: 0, width: 100, height: 100 })).result.id;
    const r1 = await op(e, 'boolean_intersect', { ids: [bow, sq] });
    expect(r1.result.id).toBeTruthy();
    const zero = (await op(e, 'node_add_rect', { x: 10, y: 10, width: 0, height: 50 })).result.id;
    const sq2 = (await op(e, 'node_add_rect', { x: 0, y: 0, width: 100, height: 100 })).result.id;
    const r2 = await op(e, 'boolean_union', { ids: [zero, sq2] }).catch((err) => ({ err }));
    if (!('err' in r2)) expect(area(e, r2.result.id)).toBeCloseTo(10_000, 0);
    const big1 = (await op(e, 'node_add_rect', { x: -1e6, y: -1e6, width: 2e6, height: 2e6 })).result.id;
    const big2 = (await op(e, 'node_add_ellipse', { x: -5e5, y: -5e5, width: 1e6, height: 1e6 })).result.id;
    const r3 = (await op(e, 'boolean_subtract', { ids: [big1, big2] })).result.id;
    expect(area(e, r3) / 4e12).toBeCloseTo(1 - Math.PI / 16, 2);
    const t1 = (await op(e, 'node_add_rect', { x: 0, y: 0, width: 0.01, height: 0.01 })).result.id;
    const t2 = (await op(e, 'node_add_rect', { x: 0.005, y: 0, width: 0.01, height: 0.01 })).result.id;
    const r4 = (await op(e, 'boolean_union', { ids: [t1, t2] })).result.id;
    expect(area(e, r4)).toBeCloseTo(0.00015, 6);
  });

  it('dejenere dönüşümler ve yollar: sıfır ölçek, NaN/Infinity reddi, tek noktalı yol, sıfır uzunluklu çizgi', async () => {
    const e = newEngine();
    const r = (await op(e, 'node_add_rect', { x: 0, y: 0, width: 10, height: 10 })).result.id;
    await op(e, 'node_transform', { ids: [r], scale: 0 }).catch(() => {});
    await rejects(op(e, 'node_move', { ids: [r], dx: Number.NaN }), /INVALID|geçersiz/i);
    await rejects(op(e, 'node_add_rect', { x: Infinity, y: 0, width: 1, height: 1 }), /INVALID|geçersiz/i);
    await rejects(op(e, 'node_add_rect', { x: 0, y: 0, width: -5, height: 1 }), /INVALID|geçersiz/i);
    const dot = (await op(e, 'node_add_path', { subpaths: [{ closed: false, points: [{ x: 5, y: 5 }] }] })).result.id;
    const line0 = (await op(e, 'node_add_line', { x1: 3, y1: 3, x2: 3, y2: 3, style: { stroke: '#000', strokeWidth: 2 } })).result.id;
    await op(e, 'path_outline_stroke', { id: line0 }).catch(() => {});
    await op(e, 'path_offset', { ids: [r], delta: -100 }).catch(() => {});
    await op(e, 'path_simplify', { ids: [dot] }).catch(() => {});
    // tüm bunlardan sonra render ve dışa aktarma çalışır
    expect((await call(e, 'render_preview', {})).png.length).toBeGreaterThan(100);
    for (const format of ['svg', 'pdf', 'png', 'json']) expect((await call(e, 'doc_export', { format })).bytes).toBeGreaterThan(0);
  });

  it('Türkçe/emoji/kontrol karakterli metin ve adlar dışa aktarılır, SVG geçerli kalır', async () => {
    const e = newEngine();
    await op(e, 'node_add_text', { x: 10, y: 50, content: 'Çağrı ÖĞÜŞİı <&> "tırnak" 🚀 \u0007', fontSize: 24, name: 'ad </svg><script>' });
    const svg = (await call(e, 'doc_export', { format: 'svg' })).data as string;
    expect(svg).not.toMatch(/<script>/);
    expect(svg).toContain('Çağrı');
    expect(svg).not.toMatch(/\u0007/);
    expect((await call(e, 'doc_export', { format: 'pdf' })).bytes).toBeGreaterThan(0);
  });
});

describe('uç durumlar — eşzamanlılık ve kilitler', () => {
  it('iyimser eşzamanlılık: eski sürümle yazan ajan CONFLICT alır, belge bozulmaz', async () => {
    const e = newEngine();
    const v0 = e.doc.version;
    await op(e, 'node_add_rect', { x: 0, y: 0, width: 1, height: 1 }, A);
    await rejects(call(e, 'op', { op: 'node_add_rect', args: { x: 0, y: 0, width: 1, height: 1 }, expectedVersion: v0 }, B), /CONFLICT/);
    expect(allNodes(e.doc).filter((n) => n.type === 'rect')).toHaveLength(1);
  });

  it('kilit: başka ajan yazamaz, kilit bırakılınca yazar; 50 paralel ajan tutarlı sürüm üretir', async () => {
    const e = newEngine();
    await call(e, 'lock_acquire', { ttlMs: 5000 }, A);
    await rejects(op(e, 'node_add_rect', { x: 0, y: 0, width: 1, height: 1 }, B), /LOCK/);
    await call(e, 'lock_release', {}, A);
    const v = e.doc.version;
    await Promise.all(Array.from({ length: 50 }, (_, i) => op(e, 'node_add_ellipse', { x: i, y: i, width: 3, height: 3 }, { agentId: `p${i}` })));
    expect(e.doc.version).toBe(v + 50);
    expect(allNodes(e.doc).filter((n) => n.type === 'ellipse')).toHaveLength(50);
  });

  it('batch ortasında hata: hiçbir işlem uygulanmaz (atomik)', async () => {
    const e = newEngine();
    const before = serializeJSON(e.doc);
    await rejects(call(e, 'batch', { ops: [
      { op: 'node_add_rect', args: { x: 0, y: 0, width: 1, height: 1 } },
      { op: 'node_delete', args: { ids: ['yok-boyle-bir-node'] } },
    ] }));
    expect(serializeJSON(e.doc)).toBe(before);
  });
});

describe('uç durumlar — bozuk dosyalar ve içe aktarma', () => {
  it('bozuk / düşmanca SVG çökertmez; script ve dış kaynak içe alınmaz', async () => {
    const e = newEngine();
    for (const content of [
      '', '<svg', 'bu svg değil', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 10 NaN Z"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 C 1 1"/><rect width="-5" height="x"/></svg>',
      `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(2000)}<rect width="1" height="1"/>${'</g>'.repeat(2000)}</svg>`,
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="http://evil.example/x.png" width="10" height="10"/><rect width="5" height="5"/></svg>',
    ]) {
      await call(e, 'doc_import', { format: 'svg', content }).catch(() => {});
    }
    const svg = (await call(e, 'doc_export', { format: 'svg' })).data as string;
    expect(svg).not.toMatch(/<script|evil\.example|passwd/);
  }, 30_000);

  it('bozuk JSON belge reddedilir, mevcut belge korunur', async () => {
    const e = newEngine();
    await op(e, 'node_add_rect', { x: 0, y: 0, width: 1, height: 1 });
    const before = serializeJSON(e.doc);
    for (const content of ['{', '{"pages": 5}', 'null', '[]']) await call(e, 'doc_import', { format: 'json', content }).catch(() => {});
    expect(serializeJSON(e.doc)).toBe(before);
  });

  it('çalışma dizini dışına yazma/okuma engellenir', async () => {
    const e = newEngine();
    await rejects(call(e, 'doc_export', { format: 'svg', path: path.join(os.tmpdir(), '..', 'mv-disari.svg') }));
    await rejects(call(e, 'doc_open', { path: '../../../../Windows/win.ini' }));
  });

  it('vektörleştirme: bozuk/boş görsel anlamlı hata, dev görsel sınırı', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'mv-v-'));
    const e = new DocumentEngine({ workspace: ws });
    writeFileSync(path.join(ws, 'bos.png'), Buffer.alloc(0));
    writeFileSync(path.join(ws, 'cop.png'), Buffer.from('bu bir png değil'));
    await rejects(call(e, 'vectorize_image', { path: 'bos.png' }), /çözülemedi|INVALID/i);
    await rejects(call(e, 'vectorize_image', { path: 'cop.png' }), /çözülemedi|INVALID/i);
    await rejects(call(e, 'vectorize_image', { path: 'yok.png' }), /IO|Okunamadı|NOT_FOUND/i);
    // tek piksel ve tamamen saydam görsel çökertmez
    const one = createCanvas(1, 1); one.getContext('2d').fillRect(0, 0, 1, 1);
    const r = await vectorizeImageToDoc(one.toBuffer('image/png'));
    expect(r.report.fidelity!.pctOff).toBe(0);
    const clear = await vectorizeImageToDoc(createCanvas(40, 30).toBuffer('image/png'));
    expect(clear.report.warnings.join(' ')).not.toMatch(/Fotoğraf/);
  }, 60_000);
});
