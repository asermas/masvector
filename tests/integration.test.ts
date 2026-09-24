import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { request as httpReq } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DocumentEngine } from '../src/server/engine.js';
import { createDocServer, listen } from '../src/server/http.js';
import { LocalBackend } from '../src/server/backend.js';
import { createMcpHttpHandler } from '../src/server/mcp/http-transport.js';
import { totalArea } from '../src/model/boolean.js';
import { nodePolygons } from '../src/math/geometry.js';
import { mustLocate, ancestorsMatrix, walk } from '../src/model/scene.js';
import { parseJSON } from '../src/serialization/json.js';

let engine: DocumentEngine, server: http.Server, base: string, workspace: string;
const mcp = { handler: null as any, closeAll: async () => {} };

beforeAll(async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), 'masvector-'));
  engine = new DocumentEngine({ workspace, autosave: 'auto.json' });
  const h = createMcpHttpHandler(new LocalBackend(engine));
  mcp.handler = h.handler; mcp.closeAll = h.closeAll;
  server = createDocServer(engine, { port: 0, extra: h.handler });
  const port = await listen(server, 0);
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => { await mcp.closeAll(); server.close(); await engine.flush(); });

async function agent(name: string) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name: tool, arguments: args });
    const t = r.content.find((c: any) => c.type === 'text')?.text;
    return { raw: r, isError: !!r.isError, json: t ? JSON.parse(t) : undefined };
  };
  return { client, call };
}

const areaOf = (id: string) => {
  const l = mustLocate(engine.doc, id);
  return totalArea(nodePolygons(l.node, ancestorsMatrix(l.ancestors)).polys);
};

describe('MCP HTTP — scriptli ajant uçtan uca çizim (temel iddia)', () => {
  it('tool listesi spec setini kapsar', async () => {
    const a = await agent('lister');
    const names = (await a.client.listTools()).tools.map((t) => t.name);
    for (const n of ['doc_create', 'doc_open', 'doc_save', 'doc_export', 'doc_import', 'node_add_path', 'node_add_rect', 'node_add_ellipse',
      'node_add_line', 'node_add_text', 'node_get', 'node_list', 'node_delete', 'node_move', 'node_transform', 'node_set_style',
      'node_edit_handles', 'boolean_union', 'boolean_subtract', 'boolean_intersect', 'boolean_exclude', 'group', 'ungroup', 'duplicate',
      'layer_create', 'layer_move_node', 'layer_toggle', 'layer_lock', 'snap_to_grid', 'add_guide', 'align_to', 'render_preview',
      'query_bbox', 'query_intersect']) expect(names).toContain(n);
    const res = (await a.client.listResources()).resources.map((r) => r.uri);
    expect(res).toEqual(expect.arrayContaining(['masvector://design.svg', 'masvector://document.json']));
    await a.client.close();
  });

  it('ajant: belge → katman → şekiller → boolean → stil → önizleme → export → kayıt', async () => {
    const a = await agent('painter');
    expect((await a.call('doc_create', { title: 'Test', width: 400, height: 300 })).isError).toBe(false);
    const layer = (await a.call('layer_create', { name: 'Şekiller' })).json.result;
    const r = await a.call('batch', {
      label: 'iki kare',
      ops: [
        { op: 'node_add_rect', args: { x: 0, y: 0, width: 50, height: 50, name: 'A', style: { fill: '#3366ff' } } },
        { op: 'node_add_rect', args: { x: 25, y: 25, width: 50, height: 50, name: 'B' } },
      ],
    });
    const [A, B] = r.json.results.map((x: any) => x.id);
    const u = await a.call('boolean_union', { ids: [A, B] });
    expect(u.isError).toBe(false);
    const uid = u.json.result.id;
    expect(u.json.result.bbox).toEqual({ x: 0, y: 0, width: 75, height: 75 });
    expect(areaOf(uid)).toBeCloseTo(4375, 3); // 2·2500 − 625
    expect(mustLocate(engine.doc, uid).parent?.id).toBe(layer.id);
    expect((mustLocate(engine.doc, uid).node as any).subpaths).toHaveLength(1); // tek parça

    await a.call('node_set_style', { ids: [uid], style: { fill: { type: 'linear', x1: 0, y1: 0, x2: 75, y2: 75, stops: [{ offset: 0, color: '#ff0080' }, { offset: 1, color: '#7928ca' }] }, stroke: '#111', strokeWidth: 2 } });
    await a.call('node_add_text', { x: 200, y: 150, content: 'MasVector', fontSize: 32, textAnchor: 'middle' });
    await a.call('node_add_path', { d: 'M300 250 Q350 200 390 250', style: { stroke: '#0a0', strokeWidth: 4 } });

    const prev = await a.call('render_preview', { maxSize: 400, grid: 50 });
    const img = prev.raw.content.find((c: any) => c.type === 'image');
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString()).toBe('PNG');

    const svg = await a.call('doc_export', { format: 'svg', path: 'out/design.svg' });
    expect(svg.raw.content[1].text).toContain('<linearGradient');
    expect(existsSync(path.join(workspace, 'out/design.svg'))).toBe(true);
    const pdf = await a.call('doc_export', { format: 'pdf', path: 'out/design.pdf' });
    expect(pdf.isError).toBe(false);
    expect(readFileSync(path.join(workspace, 'out/design.pdf')).subarray(0, 5).toString()).toBe('%PDF-');

    const saved = await a.call('doc_save', { path: 'final.json' });
    const disk = parseJSON(readFileSync(saved.json.path, 'utf8'));
    expect([...walk(disk.pages[0].frames[0].nodes)].map((w) => w.node.type)).toEqual(['group', 'path', 'text', 'path']);

    // Yol güvenliği: workspace dışına yazılamaz
    const bad = await a.call('doc_save', { path: '../escape.json' });
    expect(bad.isError).toBe(true);
    expect(bad.json.error.message).toMatch(/çalışma dizini/);

    // Resource okuma
    const rs: any = await a.client.readResource({ uri: 'masvector://design.svg' });
    expect(rs.contents[0].text).toContain('MasVector');
    await a.client.close();
  });

  it('hatalı argüman ajana isError + açıklama olarak döner, belge bozulmaz', async () => {
    const a = await agent('clumsy');
    const v0 = engine.doc.version;
    const r = await a.call('batch', { ops: [
      { op: 'node_add_rect', args: { x: 0, y: 0, width: 10, height: 10 } },
      { op: 'node_move', args: { ids: ['yok'], dx: 1 } },
    ] });
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe('NOT_FOUND');
    expect(r.json.error.message).toMatch(/batch\[1\]/);
    expect(engine.doc.version).toBe(v0); // atomik: ilk op da uygulanmadı
    await a.client.close();
  });
});

describe('Çoklu ajan (Faz 5)', () => {
  it('kilit: B, A kilidi bırakana dek bekler ve sonra başarır; iki düzenleme de korunur', async () => {
    const A = await agent('alice'), B = await agent('bob');
    await A.call('doc_create', { width: 200, height: 200 });
    expect((await A.call('lock_acquire', { ttlMs: 10_000 })).json.held).toBe(true);
    const aRect = (await A.call('node_add_rect', { x: 0, y: 0, width: 20, height: 20, name: 'alice' })).json.result.id;
    const t0 = Date.now();
    const bPromise = B.call('node_add_ellipse', { x: 50, y: 50, width: 20, height: 20, name: 'bob' });
    setTimeout(() => { void A.call('lock_release'); }, 400);
    const bRes = await bPromise;
    expect(bRes.isError).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    const names = engine.nodeList({}).map((n: any) => n.name);
    expect(names).toEqual(expect.arrayContaining(['alice', 'bob']));
    expect(mustLocate(engine.doc, aRect)).toBeTruthy();
    await A.client.close(); await B.client.close();
  });

  it('kilit zaman aşımında LOCKED hatası ve ipucu döner', async () => {
    const A = await agent('holder'), B = await agent('waiter');
    await A.call('lock_acquire', { ttlMs: 60_000 });
    const r = await B.call('node_add_rect', { x: 0, y: 0, width: 1, height: 1 });
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe('LOCKED');
    expect(r.json.error.details.holder).toMatch(/^holder#/);
    await A.call('lock_release');
    await A.client.close(); await B.client.close();
  }, 15_000);

  it('art arda iki ajan: undo başkasının işini geri almaz; expectedVersion çakışması yakalanır', async () => {
    const A = await agent('ann'), B = await agent('ben');
    await A.call('doc_create', { width: 100, height: 100 });
    await A.call('node_add_rect', { x: 0, y: 0, width: 10, height: 10, name: 'ann-1' });
    const v = (await A.call('doc_info')).json.version;
    await B.call('node_add_rect', { x: 20, y: 0, width: 10, height: 10, name: 'ben-1' });
    const u = await A.call('undo');
    expect(u.isError).toBe(true);
    expect(u.json.error.code).toBe('CONFLICT');
    const stale = await A.call('node_add_rect', { x: 40, y: 0, width: 10, height: 10, expectedVersion: v });
    expect(stale.json.error.code).toBe('CONFLICT');
    expect((await B.call('undo')).isError).toBe(false);
    expect((await A.call('undo')).isError).toBe(false);
    expect(engine.nodeList({}).length).toBe(0);
    expect((await A.call('redo')).isError).toBe(false);
    expect(engine.nodeList({}).map((n: any) => n.name)).toEqual(['ann-1']);
    await A.client.close(); await B.client.close();
  });

  it('eşzamanlı 2×25 düzenleme kayıpsız uygulanır', async () => {
    const A = await agent('a'), B = await agent('b');
    await A.call('doc_create', { width: 500, height: 500 });
    const v0 = engine.doc.version;
    await Promise.all([A, B].flatMap((ag, k) => Array.from({ length: 25 }, (_, i) =>
      ag.call('node_add_rect', { x: i * 10, y: k * 100, width: 5, height: 5, name: `${k}-${i}` }))));
    expect(engine.nodeList({}).length).toBe(50);
    expect(engine.doc.version).toBe(v0 + 50);
    await A.client.close(); await B.client.close();
  });
});

describe('SSE ve REST', () => {
  it('UI istemcisi SSE ile canlı değişiklik alır', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const events: string[] = [];
    const reading = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/event: (\w+)/g)) events.push(m[1]);
        if (events.includes('change')) break;
      }
    })();
    await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'node_add_rect', params: { x: 1, y: 1, width: 2, height: 2 }, agentId: 'ui' }) });
    await reading;
    ctrl.abort();
    expect(events[0]).toBe('hello');
    expect(events).toContain('change');
  });

  it('CSRF: JSON olmayan içerik tipi reddedilir; yabancı Host reddedilir', async () => {
    const r1 = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"method":"doc_create"}' });
    expect(r1.status).toBe(415);
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(base);
      const req = httpReq({ host: u.hostname, port: u.port, path: '/api/info', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
  });

  it('otomatik kayıt diske düşer', async () => {
    await engine.flush();
    const disk = parseJSON(readFileSync(path.join(workspace, 'auto.json'), 'utf8'));
    expect(disk.version).toBe(engine.doc.version);
  });
});

describe('MCP stdio', () => {
  it('stdio süreci paylaşılan Document Server belgesini düzenler', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/bin/mcp-stdio.ts'), '--server', base, '--agent-id', 'stdio-agent'],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'stdio-test', version: '1' });
    await client.connect(transport);
    const r: any = await client.callTool({ name: 'node_add_ellipse', arguments: { x: 0, y: 0, width: 30, height: 30, name: 'from-stdio' } });
    expect(r.isError).toBeFalsy();
    expect(engine.nodeList({ name: 'from-stdio' })).toHaveLength(1);
    expect(engine.info().history.lastAgent).toBe('stdio-agent');
    await client.close();
  }, 20_000);

  it('stdio izole kip: kendi belgesi', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'masvector-iso-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/bin/mcp-stdio.ts'), '--workspace', ws],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'iso', version: '1' });
    await client.connect(transport);
    await client.callTool({ name: 'node_add_rect', arguments: { x: 0, y: 0, width: 5, height: 5, name: 'isolated' } });
    const info: any = await client.callTool({ name: 'doc_save', arguments: {} });
    expect(JSON.parse(info.content[0].text).path).toBe(path.join(ws, 'masvector.document.json'));
    expect(engine.nodeList({ name: 'isolated' })).toHaveLength(0);
    await client.close();
  }, 20_000);
});

describe('MCP: PDF / görsel → vektör', () => {
  it('ajant PDF\'i ve görseli MCP üzerinden vektöre çevirir, fark haritasını görsel olarak alır', async () => {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(path.resolve('tests/fixtures/vector.pdf'), path.join(workspace, 'girdi.pdf'));
    copyFileSync(path.resolve('tests/fixtures/logo.png'), path.join(workspace, 'logo.png'));
    const a = await agent('vektorcu');
    const pdf = await a.call('pdf_import', { path: 'girdi.pdf' });
    expect(pdf.isError).toBe(false);
    expect(pdf.json.result.imported[0].kind).toBe('pdf-vector');
    expect(pdf.json.result.imported[0].fidelity.pctOff).toBeLessThan(0.25);
    const img = await a.call('vectorize_image', { path: 'logo.png' });
    expect(img.isError).toBe(false);
    expect(img.json.result.report.fidelity.pctOff).toBeLessThan(0.25);
    const cmp = await a.call('compare_reference', {});
    expect(cmp.isError).toBe(false);
    expect(cmp.raw.content.some((c: any) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    // Birleştirme kipi: mevcut belgeye yerleştir
    const merged = await a.call('vectorize_image', { path: 'logo.png', mode: 'merge', placement: { x: 10, y: 10, width: 300 } });
    // Zemin eklenmez (logo saydam yerleşir): içerik genişliği yerleşim genişliğini aşmaz
    expect(merged.json.result.bbox.width).toBeLessThanOrEqual(300.5);
    expect(merged.json.result.bbox.width).toBeGreaterThan(200);
    // doc_open da PDF'i tanır
    const opened = await a.call('doc_open', { path: 'girdi.pdf' });
    expect(opened.isError).toBe(false);
    await a.client.close();
  }, 180_000);
});

