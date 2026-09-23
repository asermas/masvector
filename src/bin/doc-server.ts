#!/usr/bin/env node
import { DEFAULT_PORT } from '../common/ids.js';
import { createDocServer, listen } from '../server/http.js';
import { LocalBackend } from '../server/backend.js';
import { createMcpHttpHandler } from '../server/mcp/http-transport.js';
import { HELP_COMMON, UI_DIR, parseArgs, uiAvailable } from './args.js';
import { engineFromArgs, onShutdown } from './bootstrap.js';

const args = parseArgs();
if (args.help) {
  console.log(`masvector doc-server — belgenin tek doğruluk kaynağı (HTTP API + SSE + UI${' '}+ isteğe bağlı /mcp)

  --port N             (varsayılan ${DEFAULT_PORT})
  --host H             (varsayılan 127.0.0.1)
  --no-mcp             /mcp Streamable HTTP uç noktasını kapat${HELP_COMMON}`);
  process.exit(0);
}
const log = (m: string) => console.error(`[doc-server] ${m}`);
const engine = engineFromArgs(args, log);
const mcp = args.mcp === false ? null : createMcpHttpHandler(new LocalBackend(engine), { log });
const host = String(args.host ?? '127.0.0.1');
const server = createDocServer(engine, {
  port: Number(args.port ?? DEFAULT_PORT), host, uiDir: uiAvailable() ? UI_DIR : undefined, log, extra: mcp?.handler,
});
const port = await listen(server, Number(args.port ?? DEFAULT_PORT), host);
log(`http://${host}:${port}  (UI: ${uiAvailable() ? '/' : 'derlenmemiş — npm run build:ui'}, API: /api/rpc, SSE: /api/events${mcp ? ', MCP: /mcp' : ''})`);
onShutdown(async () => { log('kapanıyor, kaydediliyor…'); await mcp?.closeAll(); server.close(); await engine.flush(); });
