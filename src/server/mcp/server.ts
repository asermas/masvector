import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VectorError } from '../../common/errors.js';
import { OP_SCHEMAS, type OpName } from '../../model/schemas.js';
import type { Backend } from '../backend.js';
import { AGENT_GUIDE, OP_DESCRIPTIONS } from './descriptions.js';

export interface McpOptions {
  /** Bu MCP oturumunun Document Server'daki kimliği (kilit ve geçmiş sahipliği). */
  agentId: string | (() => string);
  /** LOCKED alındığında otomatik yeniden deneme süresi (ms). 0 = kapalı. */
  lockWaitMs?: number;
  name?: string;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean; structuredContent?: Record<string, unknown> };

const text = (v: unknown): Content => ({ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * MCP sunucusu — tüm mantık Backend'de (Document Server). Bu katman yalnız:
 * tool/resource/prompt tanımı, hata→isError dönüşümü, kilit bekleme ve görsel içerik paketleme yapar.
 */
export function createMcpServer(backend: Backend, opts: McpOptions): McpServer {
  const server = new McpServer(
    { name: opts.name ?? 'masvector', version: '1.0.0' },
    { instructions: AGENT_GUIDE, capabilities: { logging: {} } },
  );
  const agent = () => (typeof opts.agentId === 'function' ? opts.agentId() : opts.agentId);
  const lockWait = opts.lockWaitMs ?? 5000;

  /** Kilit çakışmasında kısa üstel geri çekilmeyle yeniden dene; sonra hatayı ajana ilet. */
  async function call(method: string, params: unknown): Promise<any> {
    const deadline = Date.now() + lockWait;
    let delay = 50;
    for (;;) {
      try { return await backend.call(method, params, agent()); }
      catch (e) {
        if (e instanceof VectorError && e.code === 'LOCKED' && Date.now() + delay < deadline) {
          await sleep(delay); delay = Math.min(delay * 2, 800); continue;
        }
        throw e;
      }
    }
  }

  function wrap(fn: (args: any) => Promise<ToolResult>) {
    return async (args: any): Promise<ToolResult> => {
      try { return await fn(args ?? {}); }
      catch (e) {
        const err = e instanceof VectorError ? e.toJSON() : { code: 'INTERNAL', message: (e as Error)?.message ?? String(e) };
        const hint = err.code === 'LOCKED' ? ' → Kilit sahibi bitirene dek bekleyip yeniden deneyin.'
          : err.code === 'CONFLICT' ? ' → doc_info ile güncel sürümü okuyun, sonra tekrar deneyin.' : '';
        return { content: [text({ error: err, hint: hint || undefined })], isError: true };
      }
    };
  }

  const reg = (name: string, description: string, shape: Record<string, z.ZodType> | undefined, fn: (a: any) => Promise<ToolResult>, annotations?: Record<string, boolean>) =>
    (server.registerTool as any)(name, { description, inputSchema: shape, annotations }, wrap(fn));

  const expected = { expectedVersion: z.number().int().optional().describe('İyimser eşzamanlılık: belge sürümü bu değilse CONFLICT döner') };

  // ——— Düzenleme operasyonları (şemalar model katmanından)
  for (const name of Object.keys(OP_SCHEMAS) as OpName[]) {
    const schema = OP_SCHEMAS[name];
    const idAlias: Record<string, z.ZodType> = 'ids' in schema.shape && !('id' in schema.shape) ? { ids: (schema.shape as any).ids.optional(), id: z.string().optional().describe('Tek node için ids yerine kısayol (ids ya da id gerekli)') } : {};
    reg(name, OP_DESCRIPTIONS[name], { ...schema.shape, ...idAlias, ...expected }, async (a) => {
      const { expectedVersion, ...args } = a;
      const r = await call('op', { op: name, args, expectedVersion });
      return { content: [text({ version: r.version, result: r.result })] };
    }, { readOnlyHint: false, destructiveHint: name === 'node_delete' || name.startsWith('boolean_') });
  }

  reg('batch', 'Birden çok düzenleme operasyonunu TEK atomik adımda uygula (biri başarısız olursa hiçbiri uygulanmaz; tek undo adımı). Karmaşık çizimler için tercih edin. ops: [{op:"node_add_rect", args:{...}}, ...]', {
    ops: z.array(z.object({ op: z.enum(Object.keys(OP_SCHEMAS) as [OpName, ...OpName[]]), args: z.record(z.string(), z.any()) })).min(1),
    label: z.string().optional().describe('Geçmişte görünecek ad'),
    ...expected,
  }, async (a) => {
    const r = await call('batch', a);
    return { content: [text({ version: r.version, results: r.result })] };
  });

  // ——— Belge
  reg('doc_create', 'Yeni boş belge oluştur (mevcut belgenin yerini alır; undo ile geri alınabilir).', {
    title: z.string().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(), ...expected,
  }, async (a) => ({ content: [text(await call('doc_create', a))] }));
  reg('doc_open', 'Diskten .json (MasVector), .svg, .pdf (vektör içe aktarma) veya görsel (vektörleştirme) aç. Yol, sunucunun çalışma dizinine görelidir.', { path: z.string() },
    async (a) => ({ content: [text(await call('doc_open', a))] }));
  reg('doc_save', 'Belgeyi diske kaydet. Uzantıya göre biçim: .json (varsayılan, kayıpsız), .svg, .png, .pdf. Yol verilmezse otomatik kayıt dosyası.', { path: z.string().optional() },
    async (a) => ({ content: [text(await call('doc_save', a))] }));
  reg('doc_import', 'SVG veya JSON içe aktar. mode="replace" belgeyi değiştirir; mode="merge" SVG içeriğini yeni bir grup olarak ekler (ikon/logo yerleştirmek için).', {
    content: z.string().optional().describe('SVG/JSON metni'), path: z.string().optional().describe('veya dosya yolu'),
    format: z.enum(['svg', 'json']).optional(), mode: z.enum(['replace', 'merge']).optional(),
    parentId: z.string().optional(), name: z.string().optional(),
  }, async (a) => ({ content: [text(await call('doc_import', a))] }));
  reg('doc_export', 'Dışa aktar: svg (metin döner), png (görsel döner), pdf (vektör), json. path verilirse dosyaya da yazar.', {
    format: z.enum(['svg', 'png', 'pdf', 'json']), path: z.string().optional(), frameId: z.string().optional(),
    scale: z.number().positive().max(16).optional().describe('PNG ölçeği (varsayılan 2)'), background: z.boolean().optional(),
    includeHidden: z.boolean().optional().describe('SVG: gizli katmanları (ör. Referans) dahil et (varsayılan true)'),
  }, async (a) => {
    const r = await call('doc_export', a);
    const meta = { format: a.format, path: r.path, bytes: r.bytes, warnings: r.warnings?.length ? r.warnings : undefined };
    if (a.format === 'png') return { content: [{ type: 'image', data: r.data, mimeType: 'image/png' }, text(meta)] };
    if (a.format === 'pdf') return { content: [text({ ...meta, note: r.path ? undefined : 'PDF ikili; dosyaya yazmak için path verin', base64Length: r.data.length })] };
    return { content: [text(meta), text(r.data)] };
  }, { readOnlyHint: true });
  reg('doc_info', 'Belge özeti: sürüm, sayfalar, frame\'ler, katmanlar, kılavuzlar, kilit durumu, geçmiş.', {},
    async () => ({ content: [text(await call('doc_info', {}))] }), { readOnlyHint: true });

  // ——— Vektörleştirme (PDF / görsel → vektör)
  const traceShape = {
    preset: z.enum(['auto', 'logo', 'illustration', 'lineart', 'photo']).optional().describe('auto: görsel türü kendiliğinden sınıflandırılır'),
    colors: z.number().int().min(1).max(256).optional().describe('Tam renk sayısı (yoksa otomatik)'),
    maxColors: z.number().int().min(2).max(256).optional(),
    palette: z.array(z.string()).optional().describe('Sabit palet (#rrggbb) — kurumsal renklerle birebir eşleşme'),
    detail: z.number().min(0).max(1).optional().describe('0..1 yüksek = daha çok ayrıntı (küçük parçalar korunur)'),
    smoothness: z.number().min(0).max(1).optional().describe('0..1 yüksek = daha pürüzsüz eğri, daha az çapa'),
    background: z.enum(['auto', 'keep', 'remove']).optional().describe('auto: düz arka plan frame arka planı olur'),
    method: z.enum(['overlap', 'stacked', 'abutting']).optional().describe('overlap (önerilen): bağımsız şekiller, boşluksuz'),
    refine: z.boolean().optional().describe('Kalite hedefi tutmazsa ayarları kendisi sıkılaştırır (varsayılan true)'),
  };
  reg('vectorize_image', 'Raster görseli (PNG/JPEG/WebP/GIF/BMP/TIFF) profesyonel vektöre çevir: OKLab renk nicemleme, renk başına bağımsız şekil, pürüzsüz Bézier, sivri köşe onarımı. Sonuç kaynakla piksel piksel doğrulanır (report.fidelity: pctOff < %0.25 mükemmel, < %1 çok iyi). mode=replace TÜM belgeyi yeni belgeyle değiştirir (önceki frame ve id\'ler kaybolur; gizli+kilitli "Referans" katmanı + "Vektör" katmanı); mode=merge mevcut belgeye grup olarak yerleştirir (parentId ile hedef, placement ile konum/boyut). Mod verilmez ve parentId/placement varsa merge varsayılır. Ardından compare_reference ile fark haritasını görün.', {
    path: z.string().optional().describe('Görsel dosyası (sunucu çalışma dizinine göreli)'),
    data: z.string().optional().describe('veya base64 / data URI'),
    mode: z.enum(['replace', 'merge']).optional(),
    parentId: z.string().optional(),
    placement: z.object({ x: z.number(), y: z.number(), width: z.number().positive().optional(), height: z.number().positive().optional() }).optional(),
    keepReference: z.boolean().optional(),
    name: z.string().optional(),
    ...traceShape,
  }, async (a) => {
    const r = await call('vectorize_image', a);
    return { content: [text(r)] };
  });
  reg('pdf_import', 'PDF\'i vektör olarak içe aktar. Vektör sayfalar kayıpsız gelir (yollar, gradyanlar, kırpmalar, gömülü görseller; metin = glif eğrileri) ve yapı sadeleştirilir (glifler satır başına tek path, gereksiz kırpmalar temizlenir). Taranmış (yalnız görsel içeren) sayfalar otomatik tespit edilip 300 dpi üzerinden izlenir. Her sayfa ayrı frame; her biri poppler render\'ıyla doğrulanır (fidelity). mode=replace TÜM belgeyi değiştirir (önceki frame\'ler kaybolur), append mevcut belgeye frame ekler.', {
    path: z.string().optional().describe('PDF dosyası (sunucu çalışma dizinine göreli)'),
    data: z.string().optional().describe('veya PDF içeriği base64'),
    name: z.string().optional().describe('Belge adı'),
    pages: z.array(z.number().int().positive()).optional().describe('Sayfa numaraları (1\'den); yoksa tümü'),
    mode: z.enum(['replace', 'append']).optional(),
    verify: z.boolean().optional().describe('Poppler render\'ıyla piksel doğrulaması (varsayılan true)'),
    traceScanned: z.boolean().optional().describe('Taranmış sayfaları izle (varsayılan true)'),
    password: z.string().optional(),
    trace: z.object(traceShape).optional().describe('Taranmış sayfalar için izleme ayarları'),
  }, async (a) => ({ content: [text(await call('pdf_import', a))] }));
  reg('compare_reference', 'Vektör sonucu kaynak rasterla piksel piksel karşılaştır; metrikler + fark haritası (kırmızı = hatalı piksel) görsel olarak döner. Kaynak: path (dosya) veya frame\'deki kilitli Referans görseli.', {
    frameId: z.string().optional(), referenceId: z.string().optional(), path: z.string().optional(),
  }, async (a) => {
    const r = await call('compare_reference', a);
    return { content: [text(r.metrics), ...(r.heatmap ? [{ type: 'image' as const, data: r.heatmap, mimeType: 'image/png' }] : [])] };
  }, { readOnlyHint: true });

  // ——— Sorgular
  reg('node_get', 'Bir node\'un tam verisi (geometri, stil, dönüşüm, path noktaları) ve frame-uzayı bbox.', { id: z.string() },
    async (a) => ({ content: [text(await call('node_get', a))] }), { readOnlyHint: true });
  reg('node_list', 'Node\'ları listele (id, tip, ad, bbox, ebeveyn, z-sırası). Filtreler: parentId, type, name (içerir), recursive.', {
    parentId: z.string().optional(), type: z.enum(['path', 'rect', 'ellipse', 'line', 'text', 'group']).optional(),
    name: z.string().optional(), recursive: z.boolean().optional(),
  }, async (a) => ({ content: [text(await call('node_list', a))] }), { readOnlyHint: true });
  reg('query_bbox', 'Node\'ların frame-uzayı sınır kutuları ve birleşimi. withStroke=true kontur kalınlığını dahil eder.', {
    ids: z.array(z.string()).optional(), withStroke: z.boolean().optional(),
  }, async (a) => ({ content: [text(await call('query_bbox', a))] }), { readOnlyHint: true });
  reg('query_intersect', 'Gerçek geometrik kesişim: hangi node çiftleri örtüşüyor ve ortak alan ne kadar. id verilirse yalnız onunla kesişenler.', {
    ids: z.array(z.string()).optional(), id: z.string().optional(),
  }, async (a) => ({ content: [text(await call('query_intersect', a))] }), { readOnlyHint: true });
  reg('query_hit', 'Frame-uzayında bir noktada hangi node\'lar var (üstten alta).', {
    x: z.number(), y: z.number(), tolerance: z.number().min(0).optional(),
  }, async (a) => ({ content: [text(await call('query_hit', a))] }), { readOnlyHint: true });
  reg('render_preview', 'Belgeyi PNG olarak render edip GÖRSEL olarak döndürür — çizdiğinizi görmek için düzenli kullanın. grid=N ile N birimlik koordinat ızgarası bindirir; region ile yakınlaştırır.', {
    frameId: z.string().optional(), maxSize: z.number().int().min(16).max(2048).optional().describe('En uzun kenar px (varsayılan 768)'),
    scale: z.number().positive().max(8).optional(),
    region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional(),
    grid: z.number().positive().optional(),
  }, async (a) => {
    const r = await call('render_preview', a);
    return { content: [{ type: 'image', data: r.png, mimeType: 'image/png' }, text({ width: r.width, height: r.height, scale: r.scale })] };
  }, { readOnlyHint: true });

  // ——— Geçmiş ve kilit
  reg('undo', 'Son değişikliği geri al. Başka ajanın değişikliği en üstteyse reddedilir (force=true ile zorlanır).', { force: z.boolean().optional() },
    async (a) => ({ content: [text(await call('undo', a))] }));
  reg('redo', 'Geri alınanı yinele.', { force: z.boolean().optional() },
    async (a) => ({ content: [text(await call('redo', a))] }));
  reg('lock_acquire', 'Belgeyi çok adımlı bir iş için kilitle (kira süresi ttlMs, varsayılan 30 sn, en çok 5 dk; yeniden çağırmak uzatır). Kilit varken diğer ajanlar yazamaz (LOCKED/409).', {
    ttlMs: z.number().int().positive().optional(),
  }, async (a) => ({ content: [text(await call('lock_acquire', a))] }));
  reg('lock_release', 'Kilidi bırak.', {}, async () => ({ content: [text(await call('lock_release', {}))] }));
  reg('lock_status', 'Kilit durumu.', {}, async () => ({ content: [text(await call('lock_status', {}))] }), { readOnlyHint: true });

  // ——— Resource'lar
  server.registerResource('document.json', 'masvector://document.json',
    { title: 'Belge (JSON)', description: 'Tam belge modeli', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await backend.call('doc_get', {}, agent()), null, 1) }] }));
  server.registerResource('design.svg', 'masvector://design.svg',
    { title: 'Tasarım (SVG)', description: 'İlk frame SVG olarak', mimeType: 'image/svg+xml' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'image/svg+xml', text: (await backend.call('doc_export', { format: 'svg' }, agent())).data }] }));
  server.registerResource('preview.png', 'masvector://preview.png',
    { title: 'Önizleme (PNG)', description: 'Güncel render', mimeType: 'image/png' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'image/png', blob: (await backend.call('render_preview', {}, agent())).png }] }));
  server.registerResource('guide', 'masvector://guide',
    { title: 'Ajant çizim rehberi', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: AGENT_GUIDE }] }));

  server.registerPrompt('draw', {
    title: 'Vektör çizim görevi',
    description: 'Bir çizim görevini MasVector iş akışıyla başlat',
    argsSchema: { subject: z.string().describe('Ne çizilecek') },
  }, ({ subject }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `${AGENT_GUIDE}\n\n## Görev\n${subject}\n\nÖnce doc_info ile tuvali oku, planını kısaca yaz, batch ile çiz, render_preview ile kontrol edip düzelt.` } }],
  }));

  return server;
}
