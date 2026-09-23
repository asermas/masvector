#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LocalBackend, RemoteBackend, type Backend } from '../server/backend.js';
import { createMcpServer } from '../server/mcp/server.js';
import { createDocServer, listen } from '../server/http.js';
import { HELP_COMMON, UI_DIR, parseArgs, uiAvailable } from './args.js';
import { engineFromArgs } from './bootstrap.js';

// stdout MCP protokolüne ayrılmıştır — tüm loglar stderr'e.
const args = parseArgs();
const log = (m: string) => console.error(`[mcp-stdio] ${m}`);
if (args.help) {
  console.error(`masvector mcp-stdio — ajant başına izole MCP (stdio)

  --server URL     Paylaşılan Document Server'a bağlan (izolasyon yerine ortak belge)
  --agent-id ID    Kilit/geçmişte görünen ajant adı (varsayılan: istemci adı)
  --serve-ui PORT  Gömülü belgeyi canlı izlemek için UI/HTTP API'yi de bu portta aç${HELP_COMMON}`);
  process.exit(0);
}

let backend: Backend;
let flush = async () => {};
if (typeof args.server === 'string') backend = new RemoteBackend(args.server);
else {
  const engine = engineFromArgs(args, log);
  backend = new LocalBackend(engine);
  flush = () => engine.flush();
  if (args['serve-ui']) {
    const port = Number(args['serve-ui']);
    const srv = createDocServer(engine, { port, uiDir: uiAvailable() ? UI_DIR : undefined, log });
    const p = await listen(srv, port);
    log(`Canlı izleme: http://127.0.0.1:${p}/`);
  }
}

let clientName = 'agent';
const server = createMcpServer(backend, {
  agentId: () => (typeof args['agent-id'] === 'string' ? args['agent-id'] : `${clientName}#stdio`),
});
server.server.oninitialized = () => { clientName = server.server.getClientVersion()?.name ?? 'agent'; };
const transport = new StdioServerTransport();
transport.onclose = () => { void flush().then(() => process.exit(0)); };
await server.connect(transport);
process.stdin.on('end', () => { void flush().then(() => process.exit(0)); });
log(`hazır → ${backend.describe}`);
