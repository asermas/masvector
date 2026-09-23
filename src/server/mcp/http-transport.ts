import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Backend } from '../backend.js';
import { createMcpServer } from './server.js';
import { readBody, sendJSON } from '../http.js';

interface Session { transport: StreamableHTTPServerTransport; server: McpServer; agentId: string }

/**
 * MCP Streamable HTTP uç noktası (/mcp). Her MCP oturumu ayrı bir ajan kimliği alır
 * (`<istemci-adı>#<oturum>`); hepsi aynı Document Server belgesini düzenler.
 */
export function createMcpHttpHandler(backend: Backend, opts: { path?: string; lockWaitMs?: number; log?: (m: string) => void } = {}) {
  const mount = opts.path ?? '/mcp';
  const sessions = new Map<string, Session>();
  const log = opts.log ?? (() => {});

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== mount) return false;
    const sid = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      const raw = await readBody(req);
      let body: unknown;
      try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); return true; }
      let s = sid ? sessions.get(sid) : undefined;
      if (!s) {
        const isInit = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
        if (sid || !isInit) {
          sendJSON(res, sid ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sid ? 'Oturum bulunamadı' : 'Oturum yok: önce initialize gönderin' }, id: null });
          return true;
        }
        const session: Partial<Session> = {};
        const clientName = (Array.isArray(body) ? body.find((m) => isInitializeRequest(m)) : body as any)?.params?.clientInfo?.name ?? 'agent';
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            session.agentId = `${String(clientName).replace(/[^\w.-]/g, '_').slice(0, 32)}#${id.slice(0, 6)}`;
            sessions.set(id, session as Session);
            log(`MCP oturumu açıldı: ${session.agentId}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) { sessions.delete(transport.sessionId); log(`MCP oturumu kapandı: ${session.agentId}`); }
        };
        const server = createMcpServer(backend, { agentId: () => session.agentId ?? 'agent', lockWaitMs: opts.lockWaitMs });
        Object.assign(session, { transport, server });
        await server.connect(transport);
        s = session as Session;
      }
      await s.transport.handleRequest(req, res, body);
      return true;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const s = sid ? sessions.get(sid) : undefined;
      if (!s) { sendJSON(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Geçersiz veya eksik mcp-session-id' }, id: null }); return true; }
      await s.transport.handleRequest(req, res);
      return true;
    }
    res.writeHead(405).end();
    return true;
  };

  return { handler, sessions, async closeAll() { for (const s of sessions.values()) await s.transport.close(); } };
}
