import type { VDocument } from '../../common/types.js';

export interface ChangeEvent { version: number; label: string; agentId: string; document: VDocument }
export interface LockInfo { held: boolean; agentId?: string; expiresInMs?: number }

export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

/** Document Server istemcisi: tüm değişiklikler RPC ile sunucuya gider; UI yalnız SSE'den gelen belgeyi çizer. */
export class DocClient {
  constructor(readonly base: string, readonly agentId = 'ui:insan') {}

  async rpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(new URL('/api/rpc', this.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-id': this.agentId },
      body: JSON.stringify({ method, params, agentId: this.agentId }),
    });
    const body = await res.json();
    if (!body.ok) throw new ApiError(body.error?.code ?? 'ERR', body.error?.message ?? `HTTP ${res.status}`, body.error?.details);
    return body.result as T;
  }

  op<T = any>(op: string, args: Record<string, unknown>) { return this.rpc<{ result: T; version: number }>('op', { op, args }); }

  connect(h: {
    hello: (doc: VDocument, lock: LockInfo) => void;
    change: (e: ChangeEvent) => void;
    lock: (l: LockInfo) => void;
    status: (connected: boolean) => void;
  }) {
    const es = new EventSource(new URL('/api/events', this.base));
    es.addEventListener('hello', (e) => { const d = JSON.parse((e as MessageEvent).data); h.status(true); h.hello(d.document, d.lock); });
    es.addEventListener('change', (e) => h.change(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('lock', (e) => h.lock(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => h.status(false);
    return () => es.close();
  }

  exportUrl(format: 'svg' | 'png' | 'pdf' | 'json', params: Record<string, string> = {}) {
    const u = new URL(`/api/export/${format}`, this.base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }
}
