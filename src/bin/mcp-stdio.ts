#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LocalBackend, RemoteBackend, type Backend } from '../server/backend.js';
import { createMcpServer } from '../server/mcp/server.js';
import { createDocServer, listen } from '../server/http.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP_COMMON, UI_DIR, parseArgs, uiAvailable } from './args.js';
import { engineFromArgs } from './bootstrap.js';

// stdout MCP protokolüne ayrılmıştır — tüm loglar stderr'e.
const args = parseArgs();
const log = (m: string) => console.error(`[mcp-stdio] ${m}`);
if (args.help) {
  console.error(`masvector mcp-stdio — ajant başına izole MCP (stdio)

  --server URL     Paylaşılan Document Server'a bağlan (izolasyon yerine ortak belge)
  --ensure-server  (--server ile) Sunucu kapalıysa arka planda başlat (masaüstü uygulaması kapalıyken de çalışır)
  --agent-id ID    Kilit/geçmişte görünen ajant adı (varsayılan: istemci adı)
  --serve-ui PORT  Gömülü belgeyi canlı izlemek için UI/HTTP API'yi de bu portta aç${HELP_COMMON}`);
  process.exit(0);
}

let backend: Backend;
let flush = async () => {};
if (typeof args.server === 'string') {
  if (args['ensure-server']) await ensureServer(args.server);
  backend = new RemoteBackend(args.server);
}
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

/** Paylaşılan Document Server ayakta değilse ayrık (detached) bir süreç olarak başlat ve hazır olmasını bekle. */
async function ensureServer(url: string) {
  const ok = async () => { try { return (await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; } };
  if (await ok()) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, 'doc-server.js');
  const workspace = typeof args.workspace === 'string' ? args.workspace : path.join(os.homedir(), 'MasVector');
  mkdirSync(workspace, { recursive: true });
  const script = existsSync(js) ? [js] : ['--import', 'tsx', path.join(here, 'doc-server.ts')];
  const child = spawn(process.execPath, [...script, '--port', new URL(url).port || '7878', '--workspace', workspace, '--allow-any-path'], {
    // Paketli uygulamada process.execPath MasVector(.exe)'dir; ELECTRON_RUN_AS_NODE onu düz Node olarak çalıştırır
    cwd: path.resolve(here, '..', '..'), detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  for (let i = 0; i < 80; i++) { if (await ok()) { log(`Document Server başlatıldı: ${url}`); return; } await new Promise((r) => setTimeout(r, 150)); }
  log(`Uyarı: Document Server başlatılamadı (${url})`);
}
