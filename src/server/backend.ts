import { VectorError, type ErrorCode } from '../common/errors.js';
import type { DocumentEngine } from './engine.js';

/** MCP katmanının konuştuğu soyutlama: süreç içi motor ya da uzak Document Server. */
export interface Backend {
  call(method: string, params: unknown, agentId: string): Promise<any>;
  readonly kind: 'local' | 'remote';
  readonly describe: string;
}

export class LocalBackend implements Backend {
  readonly kind = 'local';
  constructor(readonly engine: DocumentEngine) {}
  get describe() { return `süreç içi belge (workspace: ${this.engine.opts.workspace})`; }
  call(method: string, params: unknown, agentId: string) { return this.engine.call(method, params, { agentId }); }
}

export class RemoteBackend implements Backend {
  readonly kind = 'remote';
  constructor(readonly baseUrl: string) {}
  get describe() { return `Document Server ${this.baseUrl}`; }
  async call(method: string, params: unknown, agentId: string) {
    let res: Response;
    try {
      res = await fetch(new URL('/api/rpc', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-id': agentId },
        body: JSON.stringify({ method, params, agentId }),
      });
    } catch (e) {
      throw new VectorError('IO', `Document Server'a ulaşılamadı (${this.baseUrl}): ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => ({ ok: false, error: { code: 'IO', message: `HTTP ${res.status}` } }))) as any;
    if (!body.ok) throw new VectorError((body.error?.code ?? 'IO') as ErrorCode, body.error?.message ?? 'Bilinmeyen hata', body.error?.details);
    return body.result;
  }
}
