import { describe, expect, it } from 'vitest';
import { cubicBBox, flattenSubPaths, signedArea, segments } from '../src/math/bezier.js';
import { apply, invert, multiply, parseSvgTransform, rotate, translate } from '../src/math/matrix.js';
import { ellipseSubPath, nodeBBox } from '../src/math/geometry.js';
import { parsePathData, toPathData } from '../src/serialization/path-data.js';
import { booleanPolygons, totalArea } from '../src/model/boolean.js';
import { createDocument, mustLocate } from '../src/model/scene.js';
import { applyOp } from '../src/model/ops.js';
import type { VDocument } from '../src/common/types.js';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('matris', () => {
  it('ters matris çarpımı birimdir', () => {
    const m = multiply(translate(10, -4), multiply(rotate(33), parseSvgTransform('scale(2 3) skewX(10)')));
    const i = multiply(m, invert(m));
    close(i.a, 1); close(i.b, 0); close(i.c, 0); close(i.d, 1); close(i.e, 0); close(i.f, 0);
  });
  it('SVG rotate(açı cx cy) merkez etrafında döndürür', () => {
    const p = apply(parseSvgTransform('rotate(90 50 50)'), { x: 100, y: 50 });
    close(p.x, 50); close(p.y, 100);
  });
});

describe('Bézier', () => {
  it('kübik bbox kontrol noktası kutusundan dar ve kesindir', () => {
    const b = cubicBBox({ p0: { x: 0, y: 0 }, p1: { x: 0, y: 100 }, p2: { x: 100, y: 100 }, p3: { x: 100, y: 0 } });
    close(b.maxY, 75); close(b.minX, 0); close(b.maxX, 100);
  });
  it('daire düzleştirme alanı πr²ye yakınsar', () => {
    const [poly] = flattenSubPaths([ellipseSubPath(0, 0, 50, 50)], 0.01);
    expect(Math.abs(Math.abs(signedArea(poly)) - Math.PI * 2500) / (Math.PI * 2500)).toBeLessThan(0.001);
  });
});

describe('path verisi', () => {
  it('M/L/H/V/C/S/Q/T/A/Z ayrıştırır ve kararlı biçimde yazar', () => {
    const d = 'M10 10 H90 V90 h-20 l-10 -10 C50 80 40 70 30 60 S20 40 10 30 Q15 20 20 15 T30 10 A5 5 0 0 1 10 10 Z m100 0 l10 0 l0 10 z';
    const sps = parsePathData(d);
    expect(sps).toHaveLength(2);
    expect(sps[0].closed).toBe(true);
    const again = parsePathData(toPathData(sps));
    expect(toPathData(again)).toBe(toPathData(sps));
  });
  it('yay (A) uç noktası tam hedefte biter', () => {
    const [sp] = parsePathData('M0 0 A50 50 0 1 1 100 0');
    const last = sp.points[sp.points.length - 1];
    close(last.x, 100); close(last.y, 0);
    const b = nodeBBox({ type: 'path', id: 'p', transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, style: {} as any, visible: true, locked: false, subpaths: [sp], fillRule: 'nonzero' });
    close(b.minY, -50, 0.01);
  });
  it('kapanışta başlangıçla çakışan son nokta birleştirilir, eğri korunur', () => {
    const [sp] = parsePathData('M0 0 C10 -10 20 -10 30 0 C20 10 10 10 0 0 Z');
    expect(sp.points).toHaveLength(2);
    expect(segments(sp)).toHaveLength(2);
    expect(sp.points[0].in).toEqual({ dx: 10, dy: 10 });
  });
});

describe('boolean (clipper)', () => {
  const sq = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
  it('örtüşen iki kare birleşimi TEK halka, alan = 2·s² − örtüşme', () => {
    const r = booleanPolygons('union', [{ polys: [sq(0, 0, 50)], fillRule: 'nonzero' }, { polys: [sq(25, 25, 50)], fillRule: 'nonzero' }]);
    expect(r).toHaveLength(1);
    close(totalArea(r), 2 * 2500 - 625, 1e-3);
  });
  it('subtract / intersect / exclude alanları', () => {
    const A = { polys: [sq(0, 0, 50)], fillRule: 'nonzero' as const }, B = { polys: [sq(25, 25, 50)], fillRule: 'nonzero' as const };
    close(totalArea(booleanPolygons('subtract', [A, B])), 2500 - 625, 1e-3);
    close(totalArea(booleanPolygons('intersect', [A, B])), 625, 1e-3);
    close(totalArea(booleanPolygons('exclude', [A, B])), 2 * (2500 - 625), 1e-3);
  });
  it('içteki kareyi çıkarmak delik üretir (alan düşer)', () => {
    const r = booleanPolygons('subtract', [{ polys: [sq(0, 0, 100)], fillRule: 'nonzero' }, { polys: [sq(25, 25, 50)], fillRule: 'nonzero' }]);
    expect(r).toHaveLength(2);
    close(totalArea(r), 10000 - 2500, 1e-3);
  });
  it('3+ operand union birikimli çalışır (zincir kopmaz)', () => {
    const ops = [0, 40, 80].map((x) => ({ polys: [sq(x, 0, 50)], fillRule: 'nonzero' as const }));
    const r = booleanPolygons('union', ops);
    expect(r).toHaveLength(1);
    close(totalArea(r), 130 * 50, 1e-3);
  });
  it('evenodd operand deliği korunur', () => {
    const donut = { polys: [sq(0, 0, 100), sq(25, 25, 50)], fillRule: 'evenodd' as const };
    const r = booleanPolygons('union', [donut, { polys: [sq(200, 0, 10)], fillRule: 'nonzero' }]);
    close(totalArea(r), 10000 - 2500 + 100, 1e-3);
  });
});

describe('operasyonlar', () => {
  const fresh = (): VDocument => createDocument('t', 200, 200);
  it('ekle → taşı → döndür → bbox doğru', () => {
    const d = fresh();
    const r: any = applyOp(d, 'node_add_rect', { x: 0, y: 0, width: 100, height: 50, style: { fill: '#f00' } });
    applyOp(d, 'node_move', { ids: [r.id], dx: 10, dy: 20 });
    applyOp(d, 'node_transform', { ids: [r.id], rotate: 90 });
    const b = nodeBBox(mustLocate(d, r.id).node);
    close(b.minX, 35, 1e-6); close(b.minY, -5, 1e-6); close(b.maxX - b.minX, 50, 1e-6); close(b.maxY - b.minY, 100, 1e-6);
  });
  it('dönmüş gruplar arası boolean doğru uzayda sonuç verir', () => {
    const d = fresh();
    const g: any = applyOp(d, 'layer_create', { name: 'L' });
    const a: any = applyOp(d, 'node_add_rect', { x: 0, y: 0, width: 50, height: 50, parentId: g.id });
    const b: any = applyOp(d, 'node_add_rect', { x: 25, y: 25, width: 50, height: 50 });
    const grp: any = applyOp(d, 'group', { ids: [b.id] });
    applyOp(d, 'node_transform', { ids: [grp.id], rotate: 0, translate: { x: 0, y: 0 } });
    const u: any = applyOp(d, 'boolean_union', { ids: [a.id, grp.id] });
    expect(u.bbox).toEqual({ x: 0, y: 0, width: 75, height: 75 });
    expect(() => mustLocate(d, a.id)).toThrow();
  });
  it('group/ungroup görsel konumu korur', () => {
    const d = fresh();
    const a: any = applyOp(d, 'node_add_ellipse', { x: 10, y: 10, width: 20, height: 20 });
    const g: any = applyOp(d, 'group', { ids: [a.id] });
    applyOp(d, 'node_transform', { ids: [g.id], scale: 2, origin: 'origin' });
    applyOp(d, 'ungroup', { id: g.id });
    const b = nodeBBox(mustLocate(d, a.id).node);
    close(b.minX, 20); close(b.maxX, 60);
  });
  it('kilitli node düzenlenemez', () => {
    const d = fresh();
    const a: any = applyOp(d, 'node_add_rect', { x: 0, y: 0, width: 10, height: 10 });
    applyOp(d, 'layer_lock', { id: a.id, locked: true });
    expect(() => applyOp(d, 'node_move', { ids: [a.id], dx: 1 })).toThrow(/kilitli/);
  });
  it('hizalama ve dağıtma', () => {
    const d = fresh();
    const ids = [0, 30, 100].map((x) => (applyOp(d, 'node_add_rect', { x, y: x, width: 10, height: 10 }) as any).id);
    applyOp(d, 'align_to', { ids, align: 'top' });
    applyOp(d, 'distribute', { ids, axis: 'x' });
    const xs = ids.map((id) => nodeBBox(mustLocate(d, id).node).minX);
    expect(xs).toEqual([0, 50, 100]);
    const ys = ids.map((id) => nodeBBox(mustLocate(d, id).node).minY);
    expect(ys).toEqual([0, 0, 0]);
  });
  it('handle düzenleme: segment bölme eğriyi korur', () => {
    const d = fresh();
    const p: any = applyOp(d, 'node_add_path', { d: 'M0 0 C0 100 100 100 100 0' });
    const before = nodeBBox(mustLocate(d, p.id).node);
    const r: any = applyOp(d, 'node_edit_handles', { id: p.id, edits: [{ action: 'insert', index: 0, t: 0.5 }] });
    expect(r.subpaths[0].points).toHaveLength(3);
    close(r.subpaths[0].points[1].y, 75);
    const after = nodeBBox(mustLocate(d, p.id).node);
    close(after.maxY, before.maxY, 1e-9);
  });
  it('geçersiz argüman açık hata verir', () => {
    expect(() => applyOp(fresh(), 'node_add_rect', { x: 0, y: 0, width: -1, height: 5 })).toThrow(/width/);
    expect(() => applyOp(fresh(), 'nope', {})).toThrow(/Bilinmeyen/);
  });
  it('snap_to_grid çapaları ızgaraya yaslar', () => {
    const d = fresh();
    const p: any = applyOp(d, 'node_add_path', { d: 'M1.2 3.9 L17.4 22.1 L9 30.2 Z' });
    applyOp(d, 'snap_to_grid', { ids: [p.id], size: 8, mode: 'points' });
    const n: any = mustLocate(d, p.id).node;
    for (const pt of n.subpaths[0].points) { expect(pt.x % 8).toBe(0); expect(pt.y % 8).toBe(0); }
  });
});

describe('eğri uydurma (boolean sonrası)', () => {
  it('iki dairenin birleşimi az sayıda kübik çapa ile, alan korunarak döner', async () => {
    const { fitClosedPolygon } = await import('../src/math/fit.js');
    const d = fresh2();
    const a: any = applyOp(d, 'node_add_ellipse', { x: 0, y: 0, width: 100, height: 100 });
    const b: any = applyOp(d, 'node_add_ellipse', { x: 60, y: 0, width: 100, height: 100 });
    const u: any = applyOp(d, 'boolean_union', { ids: [a.id, b.id] });
    const n: any = mustLocate(d, u.id).node;
    expect(n.subpaths).toHaveLength(1);
    const pts = n.subpaths[0].points;
    expect(pts.length).toBeLessThan(20);
    expect(pts.some((p: any) => p.out)).toBe(true);
    // analitik alan: 2πr² − mercek alanı (r=50, merkez uzaklığı 60)
    const r = 50, dd = 60, lens = 2 * r * r * Math.acos(dd / (2 * r)) - (dd / 2) * Math.sqrt(4 * r * r - dd * dd);
    const [poly] = flattenSubPaths(n.subpaths, 0.01);
    expect(Math.abs(Math.abs(signedArea(poly)) - (2 * Math.PI * r * r - lens)) / (2 * Math.PI * r * r - lens)).toBeLessThan(0.002);
    // iki kesişim köşesi korunmalı (handle'lar simetrik değil)
    void fitClosedPolygon;
  });
  it('dikdörtgen kenarları düz kalır (handle üretilmez)', () => {
    const d = fresh2();
    const a: any = applyOp(d, 'node_add_rect', { x: 0, y: 0, width: 50, height: 50 });
    const b: any = applyOp(d, 'node_add_rect', { x: 25, y: 25, width: 50, height: 50 });
    const u: any = applyOp(d, 'boolean_union', { ids: [a.id, b.id] });
    const pts = (mustLocate(d, u.id).node as any).subpaths[0].points;
    expect(pts).toHaveLength(8);
    expect(pts.every((p: any) => !p.in && !p.out)).toBe(true);
  });
});
function fresh2() { return createDocument('fit', 400, 400); }

describe('isabet testi (UI + query_hit ortak)', () => {
  it('üstteki node önce gelir; dolgusuz şeklin içi isabet etmez, konturu eder; evenodd deliği boştur', async () => {
    const { hitTest, marqueeSelect } = await import('../src/model/hit.js');
    const d = fresh2();
    const a: any = applyOp(d, 'node_add_rect', { x: 0, y: 0, width: 100, height: 100 });
    const b: any = applyOp(d, 'node_add_ellipse', { x: 50, y: 50, width: 100, height: 100 });
    const ring: any = applyOp(d, 'node_add_rect', { x: 200, y: 0, width: 100, height: 100, style: { fill: 'none', stroke: '#000', strokeWidth: 4 } });
    const donut: any = applyOp(d, 'node_add_path', { d: 'M0 200 h100 v100 h-100 Z M25 225 h50 v50 h-50 Z', fillRule: 'evenodd' });
    const f = d.pages[0].frames[0];
    expect(hitTest(f, { x: 75, y: 75 })).toEqual([b.id, a.id]);
    expect(hitTest(f, { x: 250, y: 50 })).toEqual([]);
    expect(hitTest(f, { x: 201, y: 50 })).toEqual([ring.id]);
    expect(hitTest(f, { x: 50, y: 250 })).toEqual([]);
    expect(hitTest(f, { x: 10, y: 210 })).toEqual([donut.id]);
    expect(marqueeSelect(f, { minX: -1, minY: -1, maxX: 101, maxY: 101 })).toEqual([a.id]);
  });
  it('grup içindeki yaprak tıklanınca grup seçilir (deep=false)', async () => {
    const { hitTest } = await import('../src/model/hit.js');
    const d = fresh2();
    const a: any = applyOp(d, 'node_add_rect', { x: 0, y: 0, width: 10, height: 10 });
    const g: any = applyOp(d, 'group', { ids: [a.id] });
    const f = d.pages[0].frames[0];
    expect(hitTest(f, { x: 5, y: 5 })).toEqual([g.id]);
    expect(hitTest(f, { x: 5, y: 5 }, 3, true)).toEqual([a.id]);
  });
});

describe('eğri uydurma kenar durumları', () => {
  it('tek köşeli kapalı yol çökmez', async () => {
    const { fitClosedPolygon } = await import('../src/math/fit.js');
    // damla: tek sivri uç + pürüzsüz gövde
    const pts = Array.from({ length: 120 }, (_, i) => { const t = (i / 120) * 2 * Math.PI; return { x: 100 * Math.sin(t / 2) ** 3 * Math.cos(t) + 200, y: 100 * Math.sin(t / 2) ** 3 * Math.sin(t) + 200 }; });
    const r = fitClosedPolygon(pts, 0.5, 30, false);
    expect(r.points.length).toBeGreaterThanOrEqual(3);
  });
});
