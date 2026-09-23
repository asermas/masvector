#!/usr/bin/env node
import http from 'node:http';
import { DEFAULT_PORT } from '../common/ids.js';
import { RemoteBackend } from '../server/backend.js';
import { createMcpHttpHandler } from '../server/mcp/http-transport.js';
import { listen, sendJSON } from '../server/http.js';
import { parseArgs } from './args.js';

// İki kip:
//  - varsayılan: doc-server'ı /mcp ile birlikte başlatır (tek komut, çoklu ajan tek belge)
//  - --server URL: uzaktaki Document Server'a bağlanan ayrı bir MCP HTTP ağ geçidi
const args = parseArgs();
if (args.help) {
  console.log(`masvector mcp-http — MCP Streamable HTTP (birden çok ajan tek belge)

  --server URL   Var olan Document Server'a bağlan (ör. http://127.0.0.1:${DEFAULT_PORT}); yoksa gömülü doc-server başlar
  --port N       Ağ geçidi portu (--server ile; varsayılan ${DEFAULT_PORT + 1})
  (diğer seçenekler: doc-server --help)`);
  process.exit(0);
}

if (typeof args.server !== 'string') {
  await import('./doc-server.js');
} else {
  const log = (m: string) => console.error(`[mcp-http] ${m}`);
  const backend = new RemoteBackend(args.server);
  await backend.call('lock_status', {}, 'probe').catch((e) => { log(`Uyarı: ${e.message}`); });
  const mcp = createMcpHttpHandler(backend, { log });
  const server = http.createServer(async (req, res) => {
    try { if (!(await mcp.handler(req, res))) sendJSON(res, 404, { error: 'MCP uç noktası: /mcp' }); }
    catch (e) { if (!res.headersSent) sendJSON(res, 500, { error: (e as Error).message }); }
  });
  const host = String(args.host ?? '127.0.0.1');
  const port = await listen(server, Number(args.port ?? DEFAULT_PORT + 1), host);
  log(`MCP: http://${host}:${port}/mcp → ${backend.describe}`);
}
