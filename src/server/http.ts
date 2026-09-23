import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VectorError } from '../common/errors.js';
import type { DocumentEngine, EngineEvent } from './engine.js';

export interface DocServerOptions {
  port: number;
  host?: string;
  /** Derlenmiş UI dosyalarının dizini (index.html, renderer.js). */
  uiDir?: string;
  /** Ek HTTP işleyici (ör. aynı portta MCP). true dönerse istek işlenmiş sayılır. */
  extra?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> | boolean;
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

export function sendJSON(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

export async function readBody(req: http.IncomingMessage, limit = 32 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new VectorError('INVALID_ARGUMENT', 'İstek gövdesi çok büyük');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** DNS-rebinding koruması: yalnız yerel Host başlıklarına izin ver (0.0.0.0'a bağlanıldıysa hepsi). */
function hostAllowed(req: http.IncomingMessage, bindHost: string): boolean {
  if (bindHost === '0.0.0.0' || bindHost === '::') return true;
  const h = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1', bindHost].includes(h);
}

export function errorBody(e: unknown) {
  if (e instanceof VectorError) return { status: e.status, body: { ok: false, error: e.toJSON() } };
  return { status: 500, body: { ok: false, error: { code: 'INTERNAL', message: (e as Error)?.message ?? String(e) } } };
}

export function createDocServer(engine: DocumentEngine, opts: DocServerOptions): http.Server {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? (() => {});
  const sseClients = new Set<http.ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(payload);
  };
  engine.subscribe((e: EngineEvent) => {
    if (e.type === 'change') broadcast('change', { version: e.version, label: e.label, agentId: e.agentId, document: e.document });
    else if (e.type === 'lock') broadcast('lock', e.lock);
    else broadcast('saved', { path: e.path, version: e.version });
  });
  const heartbeat = setInterval(() => { for (const c of sseClients) c.write(': ping\n\n'); }, 15_000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req, host)) { sendJSON(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Host başlığına izin verilmedi' } }); return; }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const agentHeader = (req.headers['x-agent-id'] as string | undefined)?.slice(0, 64);

      if (opts.extra && (await opts.extra(req, res))) return;

      if (url.pathname === '/api/health') { sendJSON(res, 200, { ok: true, version: engine.doc.version, clients: sseClients.size }); return; }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`retry: 1000\nevent: hello\ndata: ${JSON.stringify({ version: engine.doc.version, document: engine.doc, lock: engine.lockStatus() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (url.pathname === '/api/doc' && req.method === 'GET') { sendJSON(res, 200, { ok: true, result: engine.doc }); return; }
      if (url.pathname === '/api/info' && req.method === 'GET') { sendJSON(res, 200, { ok: true, result: engine.info() }); return; }

      const exp = /^\/api\/export\/(svg|png|pdf|json)$/.exec(url.pathname);
      if (exp && req.method === 'GET') {
        const format = exp[1] as 'svg' | 'png' | 'pdf' | 'json';
        const r = await engine.docExport({
          format, frameId: url.searchParams.get('frameId') ?? undefined,
          scale: url.searchParams.has('scale') ? Number(url.searchParams.get('scale')) : undefined,
        });
        const types = { svg: 'image/svg+xml', png: 'image/png', pdf: 'application/pdf', json: 'application/json' };
        res.writeHead(200, { 'content-type': types[format], 'cache-control': 'no-store' });
        res.end(r.data);
        return;
      }

      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        // CSRF koruması: basit (preflight'sız) tarayıcı isteklerini reddet
        if (!(req.headers['content-type'] ?? '').includes('application/json')) {
          sendJSON(res, 415, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Content-Type application/json olmalı' } });
          return;
        }
        const body = JSON.parse((await readBody(req)) || '{}');
        const agentId = String(body.agentId ?? agentHeader ?? 'anonymous').slice(0, 64);
        const t0 = Date.now();
        try {
          const result = await engine.call(String(body.method), body.params, { agentId });
          log(`${agentId} ${body.method}${body.params?.op ? ':' + body.params.op : ''} ✓ ${Date.now() - t0}ms v${engine.doc.version}`);
          sendJSON(res, 200, { ok: true, result });
        } catch (e) {
          const { status, body: eb } = errorBody(e);
          log(`${agentId} ${body.method} ✗ ${eb.error.code}: ${eb.error.message}`);
          sendJSON(res, status, eb);
        }
        return;
      }

      if (req.method === 'GET' && opts.uiDir) {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const abs = path.resolve(opts.uiDir, rel);
        if (abs.startsWith(path.resolve(opts.uiDir) + path.sep)) {
          try {
            const data = await fs.readFile(abs);
            res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
            res.end(data);
            return;
          } catch { /* 404'e düş */ }
        }
      }
      sendJSON(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
    } catch (e) {
      const { status, body } = errorBody(e);
      if (!res.headersSent) sendJSON(res, status, body);
      else res.end();
    }
  });
  server.on('close', () => { clearInterval(heartbeat); for (const c of sseClients) c.end(); });
  return server;
}

export function listen(server: http.Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    });
  });
}
