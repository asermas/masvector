import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { VDocument, VNode } from '../common/types.js';
import { VectorError, invalid } from '../common/errors.js';
import { DOC_FILENAME, newId } from '../common/ids.js';
import { applyOp, frameBBox, summarize } from '../model/ops.js';
import { OP_NAMES } from '../model/schemas.js';
import { allNodes, containerChildren, createDocument, findFrame, mustLocate, walk, ancestorsMatrix } from '../model/scene.js';
import { parseJSON, serializeJSON } from '../serialization/json.js';
import { documentToSVG } from '../serialization/svg-export.js';
import { importSVG } from '../serialization/svg-import.js';
import { documentToPDF } from '../serialization/pdf-export.js';
import { renderPNG } from '../render/png.js';
import { intersectionArea } from '../model/boolean.js';
import { nodePolygons } from '../math/geometry.js';
import { bboxIntersects } from '../math/geometry.js';
import { isEmptyBBox, unionBBox } from '../math/bezier.js';
import { hitTest } from '../model/hit.js';

export interface CallContext { agentId: string }

interface HistoryEntry { before: string; after: string; label: string; agentId: string; version: number; at: number }

interface Lease { agentId: string; expiresAt: number; acquiredAt: number }

export type EngineEvent =
  | { type: 'change'; version: number; label: string; agentId: string; document: VDocument }
  | { type: 'lock'; lock: LockStatus }
  | { type: 'saved'; path: string; version: number };

export interface LockStatus { held: boolean; agentId?: string; expiresInMs?: number }

export interface EngineOptions {
  /** Göreli yolların çözüldüğü ve dışına çıkılamayan çalışma dizini. */
  workspace: string;
  /** Otomatik kayıt dosyası (workspace'e göreli). null = kapalı. */
  autosave?: string | null;
  historyLimit?: number;
  defaultLockTtlMs?: number;
  maxLockTtlMs?: number;
  allowAnyPath?: boolean;
}

/**
 * Document Server'ın çekirdeği. Tüm değişiklikler buradan geçer:
 * doğrulama → kilit kontrolü → sürüm kontrolü → atomik uygulama (hata = geri al) → geçmiş → yayın → kayıt.
 * Node.js tek iş parçacıklı olduğundan her `call` senkron kısımda bölünmez; kilit çok adımlı işler içindir.
 */
export class DocumentEngine {
  doc: VDocument;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private lease: Lease | null = null;
  private listeners = new Set<(e: EngineEvent) => void>();
  private saveChain: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  readonly opts: Required<EngineOptions>;
  readonly agents = new Map<string, { firstSeen: number; lastSeen: number; ops: number }>();

  constructor(opts: EngineOptions, doc?: VDocument) {
    this.opts = {
      autosave: DOC_FILENAME, historyLimit: 200, defaultLockTtlMs: 30_000, maxLockTtlMs: 5 * 60_000, allowAnyPath: false,
      ...opts,
    };
    this.doc = doc ?? createDocument();
  }

  // ———————————————————————— olaylar

  subscribe(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: EngineEvent) { for (const l of this.listeners) try { l(e); } catch { /* dinleyici hatası motoru bozmasın */ } }

  // ———————————————————————— kilit

  lockStatus(): LockStatus {
    this.expireLease();
    if (!this.lease) return { held: false };
    return { held: true, agentId: this.lease.agentId, expiresInMs: this.lease.expiresAt - Date.now() };
  }

  private expireLease() {
    if (this.lease && this.lease.expiresAt <= Date.now()) {
      this.lease = null;
      this.emit({ type: 'lock', lock: { held: false } });
    }
  }

  acquireLock(ctx: CallContext, ttlMs?: number): LockStatus {
    this.expireLease();
    const ttl = Math.min(Math.max(ttlMs ?? this.opts.defaultLockTtlMs, 100), this.opts.maxLockTtlMs);
    if (this.lease && this.lease.agentId !== ctx.agentId) throw this.lockedError();
    this.lease = { agentId: ctx.agentId, acquiredAt: this.lease?.acquiredAt ?? Date.now(), expiresAt: Date.now() + ttl };
    const st = this.lockStatus();
    this.emit({ type: 'lock', lock: st });
    return st;
  }

  releaseLock(ctx: CallContext): LockStatus {
    this.expireLease();
    if (this.lease && this.lease.agentId !== ctx.agentId) throw this.lockedError();
    this.lease = null;
    this.emit({ type: 'lock', lock: { held: false } });
    return { held: false };
  }

  private lockedError() {
    const l = this.lease!;
    const wait = l.expiresAt - Date.now();
    return new VectorError('LOCKED', `Belge "${l.agentId}" tarafından kilitli; ~${Math.ceil(wait / 1000)} sn sonra yeniden deneyin`, {
      holder: l.agentId, retryAfterMs: Math.min(wait, 1000),
    });
  }

  private assertCanWrite(ctx: CallContext, expectedVersion?: number) {
    this.expireLease();
    if (this.lease && this.lease.agentId !== ctx.agentId) throw this.lockedError();
    if (expectedVersion !== undefined && expectedVersion !== this.doc.version)
      throw new VectorError('CONFLICT', `Sürüm çakışması: beklenen ${expectedVersion}, güncel ${this.doc.version}. Belgeyi yeniden okuyun.`, {
        currentVersion: this.doc.version,
      });
  }

  // ———————————————————————— değişiklik

  /** Bir değişikliği atomik uygula: fn hata atarsa belge önceki haline döner. */
  private mutate<T>(ctx: CallContext, label: string, fn: (doc: VDocument) => T, expectedVersion?: number): { result: T; version: number } {
    this.assertCanWrite(ctx, expectedVersion);
    const before = serializeJSON(this.doc, false);
    let result: T;
    try {
      result = fn(this.doc);
    } catch (e) {
      this.doc = parseJSON(before);
      throw e;
    }
    this.doc.version += 1;
    const after = serializeJSON(this.doc, false);
    this.undoStack.push({ before, after, label, agentId: ctx.agentId, version: this.doc.version, at: Date.now() });
    if (this.undoStack.length > this.opts.historyLimit) this.undoStack.shift();
    this.redoStack = [];
    this.touchAgent(ctx);
    this.changed(label, ctx.agentId);
    return { result, version: this.doc.version };
  }

  private touchAgent(ctx: CallContext) {
    const a = this.agents.get(ctx.agentId) ?? { firstSeen: Date.now(), lastSeen: 0, ops: 0 };
    a.lastSeen = Date.now(); a.ops++;
    this.agents.set(ctx.agentId, a);
  }

  private changed(label: string, agentId: string) {
    this.emit({ type: 'change', version: this.doc.version, label, agentId, document: this.doc });
    this.scheduleAutosave();
  }

  op(ctx: CallContext, op: string, args: unknown, expectedVersion?: number) {
    return this.mutate(ctx, op, (d) => applyOp(d, op, args), expectedVersion);
  }

  batch(ctx: CallContext, ops: { op: string; args?: unknown }[], expectedVersion?: number, label?: string) {
    if (!Array.isArray(ops) || !ops.length) throw invalid('batch: en az bir operasyon gerekli');
    return this.mutate(ctx, label ?? `batch(${ops.length})`, (d) => ops.map((o, i) => {
      try { return applyOp(d, o.op, o.args); }
      catch (e) {
        if (e instanceof VectorError) throw new VectorError(e.code, `batch[${i}] ${o.op}: ${e.message}`, e.details);
        throw e;
      }
    }), expectedVersion);
  }

  undo(ctx: CallContext, force = false) {
    this.assertCanWrite(ctx);
    const e = this.undoStack[this.undoStack.length - 1];
    if (!e) throw new VectorError('NOTHING_TO_UNDO', 'Geri alınacak değişiklik yok');
    if (e.agentId !== ctx.agentId && !force)
      throw new VectorError('CONFLICT', `Son değişiklik (${e.label}) "${e.agentId}" ajantına ait; başka ajantın işini geri almamak için reddedildi (force=true ile zorlanabilir)`, { owner: e.agentId });
    this.undoStack.pop();
    const version = this.doc.version + 1;
    this.doc = parseJSON(e.before);
    this.doc.version = version;
    this.redoStack.push(e);
    this.changed(`undo:${e.label}`, ctx.agentId);
    return { undone: e.label, version };
  }

  redo(ctx: CallContext, force = false) {
    this.assertCanWrite(ctx);
    const e = this.redoStack[this.redoStack.length - 1];
    if (!e) throw new VectorError('NOTHING_TO_UNDO', 'Yinelenecek değişiklik yok');
    if (e.agentId !== ctx.agentId && !force)
      throw new VectorError('CONFLICT', `Yinelenecek değişiklik "${e.agentId}" ajantına ait`, { owner: e.agentId });
    this.redoStack.pop();
    const version = this.doc.version + 1;
    this.doc = parseJSON(e.after);
    this.doc.version = version;
    this.undoStack.push({ ...e, version });
    this.changed(`redo:${e.label}`, ctx.agentId);
    return { redone: e.label, version };
  }

  // ———————————————————————— belge yaşam döngüsü

  resolvePath(p: string): string {
    const abs = path.resolve(this.opts.workspace, p);
    const rel = path.relative(this.opts.workspace, abs);
    if (!this.opts.allowAnyPath && (rel.startsWith('..') || path.isAbsolute(rel)))
      throw new VectorError('INVALID_ARGUMENT', `Yol çalışma dizini dışında: ${p} (workspace: ${this.opts.workspace})`);
    return abs;
  }

  docCreate(ctx: CallContext, a: { title?: string; width?: number; height?: number } = {}, expectedVersion?: number) {
    return this.mutate(ctx, 'doc_create', () => {
      const v = this.doc.version;
      this.doc = createDocument(a.title ?? 'Adsız', a.width ?? 1024, a.height ?? 768);
      this.doc.version = v;
      return this.info();
    }, expectedVersion);
  }

  async docOpen(ctx: CallContext, p: string) {
    const abs = this.resolvePath(p);
    let text: string;
    try { text = await fs.readFile(abs, 'utf8'); } catch (e) { throw new VectorError('IO', `Okunamadı: ${abs} (${(e as Error).message})`); }
    const isSvg = abs.toLowerCase().endsWith('.svg') || text.trimStart().startsWith('<');
    let warnings: string[] = [];
    const loaded = isSvg ? (() => { const r = importSVG(text, { title: path.basename(abs) }); warnings = r.warnings; return r.doc; })() : parseJSON(text);
    return this.mutate(ctx, 'doc_open', () => {
      const v = this.doc.version;
      this.doc = loaded;
      this.doc.version = v;
      return { path: abs, warnings, ...this.info() };
    });
  }

  async docSave(p?: string): Promise<{ path: string; version: number; bytes: number }> {
    const target = p ?? this.opts.autosave;
    if (!target) throw invalid('Kayıt yolu verilmedi ve otomatik kayıt kapalı');
    const abs = this.resolvePath(target);
    const version = this.doc.version;
    const lower = abs.toLowerCase();
    let data: string | Buffer;
    if (lower.endsWith('.svg')) data = documentToSVG(this.doc);
    else if (lower.endsWith('.png')) data = renderPNG(this.doc, { scale: 2 }).png;
    else if (lower.endsWith('.pdf')) data = documentToPDF(this.doc).pdf;
    else data = serializeJSON(this.doc);
    // Atomik yazım: geçici dosya + rename; eşzamanlı kayıtlar sıraya alınır.
    const job = this.saveChain.then(async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, abs);
    });
    this.saveChain = job.catch(() => undefined);
    try { await job; } catch (e) { throw new VectorError('IO', `Yazılamadı: ${abs} (${(e as Error).message})`); }
    this.emit({ type: 'saved', path: abs, version });
    return { path: abs, version, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length };
  }

  private scheduleAutosave() {
    if (!this.opts.autosave) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.docSave().catch(() => undefined); }, 150);
    this.saveTimer.unref?.();
  }

  /** Bekleyen otomatik kaydı hemen yaz (kapanışta). */
  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; await this.docSave().catch(() => undefined); }
    await this.saveChain;
  }

  docImport(ctx: CallContext, a: { format: 'svg' | 'json'; content: string; mode?: 'replace' | 'merge'; parentId?: string; name?: string }) {
    if (a.format === 'json') {
      const d = parseJSON(a.content);
      if (a.mode === 'merge') throw invalid('JSON içe aktarma yalnız replace modunda');
      return this.mutate(ctx, 'doc_import', () => { const v = this.doc.version; this.doc = d; this.doc.version = v; return this.info(); });
    }
    const r = importSVG(a.content);
    if (a.mode !== 'merge') {
      return this.mutate(ctx, 'doc_import', () => {
        const v = this.doc.version; this.doc = r.doc; this.doc.version = v;
        return { warnings: r.warnings, ...this.info() };
      });
    }
    return this.mutate(ctx, 'doc_import(merge)', (d) => {
      const target = a.parentId ? containerChildren(d, a.parentId) : { list: findFrame(d).frame.nodes };
      const g: VNode = {
        type: 'group', id: newId('group'), name: a.name ?? 'İçe aktarılan', transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        style: { fill: 'none', stroke: 'none', strokeWidth: 1, opacity: 1, blendMode: 'normal', filters: [] },
        visible: true, locked: false, children: r.frame.nodes,
      };
      // Çakışan id'leri yenile
      const existing = new Set(allNodes(d).map((n) => n.id));
      for (const w of walk([g])) if (existing.has(w.node.id)) w.node.id = newId(w.node.type);
      target.list.push(g);
      return { warnings: r.warnings, ...summarize(d, g.id) };
    });
  }

  async docExport(a: { format: 'svg' | 'png' | 'pdf' | 'json'; path?: string; frameId?: string; scale?: number; background?: boolean }) {
    let data: string | Buffer, warnings: string[] = [];
    switch (a.format) {
      case 'svg': data = documentToSVG(this.doc, a.frameId, { background: a.background }); break;
      case 'json': data = serializeJSON(this.doc); break;
      case 'png': data = renderPNG(this.doc, { frameId: a.frameId, scale: a.scale ?? 2, background: a.background }).png; break;
      case 'pdf': { const r = documentToPDF(this.doc, a.frameId); data = r.pdf; warnings = r.warnings; break; }
      default: throw invalid(`Bilinmeyen biçim: ${String(a.format)}`);
    }
    let written: string | undefined;
    if (a.path) {
      written = this.resolvePath(a.path);
      await fs.mkdir(path.dirname(written), { recursive: true });
      await fs.writeFile(written, data);
    }
    return { data, path: written, warnings, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length };
  }

  // ———————————————————————— sorgular (salt okunur)

  info() {
    const d = this.doc;
    return {
      id: d.id, title: d.title, version: d.version,
      pages: d.pages.map((p) => ({
        id: p.id, name: p.name, grid: p.grid, guides: p.guides,
        frames: p.frames.map((f) => ({
          id: f.id, name: f.name, x: f.x, y: f.y, w: f.w, h: f.h, background: f.background,
          layers: f.nodes.filter((n) => n.type === 'group' && n.isLayer).map((l) => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked, count: (l as any).children.length })),
          nodeCount: [...walk(f.nodes)].length,
        })),
      })),
      lock: this.lockStatus(),
      history: { undo: this.undoStack.length, redo: this.redoStack.length, last: this.undoStack.at(-1)?.label ?? null, lastAgent: this.undoStack.at(-1)?.agentId ?? null },
    };
  }

  nodeGet(id: string) {
    const l = mustLocate(this.doc, id);
    return { node: l.node, parentId: l.parent?.id ?? l.frame.id, frameId: l.frame.id, index: l.index, ...summarize(this.doc, id) };
  }

  nodeList(a: { parentId?: string; type?: string; recursive?: boolean; name?: string } = {}) {
    const c = containerChildren(this.doc, a.parentId);
    const out: unknown[] = [];
    const visit = (nodes: VNode[], depth: number, parentId: string) => {
      nodes.forEach((n, i) => {
        const matchType = !a.type || n.type === a.type;
        const matchName = !a.name || (n.name ?? '').toLowerCase().includes(a.name.toLowerCase());
        if (matchType && matchName) {
          const s = summarize(this.doc, n.id);
          out.push({ ...s, parentId, index: i, depth, visible: n.visible, locked: n.locked, ...(n.type === 'group' ? { isLayer: !!n.isLayer, children: n.children.length } : {}),
            fill: n.type !== 'group' ? n.style.fill : undefined });
        }
        if (n.type === 'group' && a.recursive !== false) visit(n.children, depth + 1, n.id);
      });
    };
    visit(c.list, 0, c.group?.id ?? c.frame.id);
    return out;
  }

  queryBBox(a: { ids?: string[]; withStroke?: boolean } = {}) {
    const ids = a.ids?.length ? a.ids : findFrame(this.doc).frame.nodes.map((n) => n.id);
    let total = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const items = ids.map((id) => {
      const b = frameBBox(mustLocate(this.doc, id), a.withStroke);
      if (!isEmptyBBox(b)) total = unionBBox(total, b);
      return { id, bbox: isEmptyBBox(b) ? null : rect(b) };
    });
    return { items, union: isEmptyBBox(total) ? null : rect(total) };
  }

  /** Geometrik kesişim: bbox önelemesi + gerçek poligon kesişim alanı. */
  queryIntersect(a: { ids?: string[]; id?: string }) {
    const doc = this.doc;
    const pool = a.ids?.length ? a.ids : allNodes(doc).filter((n) => n.type !== 'group').map((n) => n.id);
    const targets = a.id ? [a.id] : pool;
    const pairs: { a: string; b: string; area: number; touching: boolean }[] = [];
    const operand = (id: string) => {
      const l = mustLocate(doc, id);
      const { polys, closed } = nodePolygons(l.node, ancestorsMatrix(l.ancestors));
      return { l, polys, closed, bbox: frameBBox(l, true) };
    };
    const cache = new Map<string, ReturnType<typeof operand>>();
    const get = (id: string) => { let o = cache.get(id); if (!o) { o = operand(id); cache.set(id, o); } return o; };
    for (const x of targets) for (const y of pool) {
      if (x === y || (!a.id && x > y)) continue;
      const A = get(x), B = get(y);
      if (isEmptyBBox(A.bbox) || isEmptyBBox(B.bbox) || !bboxIntersects(A.bbox, B.bbox)) continue;
      const ca = A.polys.filter((_, i) => A.closed[i]), cb = B.polys.filter((_, i) => B.closed[i]);
      const area = ca.length && cb.length ? intersectionArea({ polys: ca, fillRule: 'nonzero' }, { polys: cb, fillRule: 'nonzero' }) : 0;
      pairs.push({ a: x, b: y, area: Math.round(area * 1000) / 1000, touching: area === 0 });
    }
    return { pairs };
  }

  /** Noktadaki node'lar (üstten alta; deep=true gruplar yerine yaprakları döner). */
  queryHit(a: { x: number; y: number; tolerance?: number; deep?: boolean; frameId?: string }) {
    const all = hitTest(findFrame(this.doc, a.frameId).frame, { x: a.x, y: a.y }, a.tolerance ?? 3, a.deep ?? true);
    return { top: all[0] ?? null, all };
  }

  renderPreview(a: { frameId?: string; maxSize?: number; scale?: number; region?: { x: number; y: number; width: number; height: number }; grid?: number } = {}) {
    return renderPNG(this.doc, { maxSize: a.scale ? undefined : a.maxSize ?? 768, ...a });
  }

  // ———————————————————————— tek RPC yüzeyi

  /** Uzak (HTTP) ve yerel istemcilerin ortak giriş noktası. */
  async call(method: string, params: any, ctx: CallContext): Promise<unknown> {
    const p = params ?? {};
    switch (method) {
      case 'op': return this.op(ctx, p.op, p.args, p.expectedVersion);
      case 'batch': return this.batch(ctx, p.ops, p.expectedVersion, p.label);
      case 'undo': return this.undo(ctx, !!p.force);
      case 'redo': return this.redo(ctx, !!p.force);
      case 'lock_acquire': return this.acquireLock(ctx, p.ttlMs);
      case 'lock_release': return this.releaseLock(ctx);
      case 'lock_status': return this.lockStatus();
      case 'doc_create': return this.docCreate(ctx, p, p.expectedVersion);
      case 'doc_open': return this.docOpen(ctx, p.path);
      case 'doc_save': return this.docSave(p.path);
      case 'doc_import': {
        let content: string = p.content;
        if (!content && p.path) content = await fs.readFile(this.resolvePath(p.path), 'utf8');
        if (!content) throw invalid('doc_import: content veya path gerekli');
        const format = p.format ?? (content.trimStart().startsWith('<') ? 'svg' : 'json');
        return this.docImport(ctx, { ...p, format, content });
      }
      case 'doc_export': {
        const r = await this.docExport(p);
        return { ...r, data: typeof r.data === 'string' ? r.data : r.data.toString('base64'), encoding: typeof r.data === 'string' ? 'utf8' : 'base64' };
      }
      case 'doc_get': return this.doc;
      case 'doc_info': return this.info();
      case 'node_get': return this.nodeGet(p.id);
      case 'node_list': return this.nodeList(p);
      case 'query_bbox': return this.queryBBox(p);
      case 'query_intersect': return this.queryIntersect(p);
      case 'query_hit': return this.queryHit(p);
      case 'render_preview': {
        const r = this.renderPreview(p);
        return { png: r.png.toString('base64'), width: r.width, height: r.height, scale: r.scale };
      }
      default:
        if ((OP_NAMES as string[]).includes(method)) return this.op(ctx, method, p, p.expectedVersion);
        throw invalid(`Bilinmeyen metot: ${method}`);
    }
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const rect = (b: { minX: number; minY: number; maxX: number; maxY: number }) => ({ x: r3(b.minX), y: r3(b.minY), width: r3(b.maxX - b.minX), height: r3(b.maxY - b.minY) });
