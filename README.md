# MasVector (Claude sürümü)

Ajantların (LLM'lerin) MCP üzerinden bağlanıp profesyonel vektör çizim yaptığı **Electron masaüstü editörü** ve ona eşlik eden **MCP sunucusu**. Spec: `~/masvector/masvector.md`. Bu dizin o spec'ten, `~/masvector` altındaki opencode sürümüne bakılmadan, sıfırdan yazıldı.

```
┌──────────────┐  SSE (canlı belge)   ┌──────────────────┐  RPC / MCP stdio | HTTP  ┌────────────┐
│ Electron UI  │ ◄─────────────────── │ Document Server  │ ◄──────────────────────── │ Ajant/LLM  │
│ canvas+araçlar│ ───── /api/rpc ────► │ tek doğruluk      │   tool + resource + prompt │ (1..N)     │
└──────────────┘                      │ kaynağı           │                            └────────────┘
                                      │ model · boolean · undo/redo · kilit · disk · SSE │
                                      └──────────────────┘
```

- **Document Server** (`src/server/engine.ts`, `http.ts`): tüm değişiklikler buradan geçer. Akış: doğrulama (zod) → kilit → sürüm kontrolü → atomik uygulama (hata olursa belge geri döner) → geçmiş → SSE yayını → diske atomik kayıt.
- **MCP sunucusu** (`src/server/mcp/`): ince katman. Operasyon şemaları model katmanındaki tek kaynaktan (`src/model/schemas.ts`) üretilir. stdio ve Streamable HTTP taşımalarını destekler.
- **Electron UI** (`src/ui/`): yalnız render istemcisi. Belgeyi SSE'den alır, her değişikliği RPC ile sunucuya yollar. Sunucu çalışmıyorsa onu **ayrı bir süreç** olarak başlatır. Aynı arayüz tarayıcıda da açılır (`http://127.0.0.1:7878/`).

## Kurulum ve çalıştırma

```bash
npm install
npm run build        # tsc + renderer tip kontrolü + UI paketi (dist/)
npm test             # 44 test: birim + gerçek MCP istemcili entegrasyon
```

```bash
npm run doc-server -- --workspace ~/MasVector     # API + SSE + UI (/) + MCP (/mcp) → :7878
npm run dev                                        # Electron (sunucu yoksa kendisi başlatır)
npx tsx scripts/demo-agent.ts                      # scriptli ajan bir rozet çizer (MCP HTTP)
```

### Ajant bağlama

**Paylaşılan belge (birden çok ajan + UI aynı anda):** önce `doc-server` çalışsın.

```bash
claude mcp add --transport http masvector http://127.0.0.1:7878/mcp
```

OpenCode (`opencode.json`):
```json
{ "mcp": { "masvector": { "type": "remote", "url": "http://127.0.0.1:7878/mcp" } } }
```

**stdio, paylaşılan belgeye bağlı:**
```bash
claude mcp add masvector -- node /home/anilmas/masvector-claude/dist/bin/mcp-stdio.js --server http://127.0.0.1:7878
```

**stdio, izole (ajan başına ayrı belge)** ve istenirse canlı izleme:
```bash
node dist/bin/mcp-stdio.js --workspace ./cizim --serve-ui 7880   # tarayıcıda http://127.0.0.1:7880
```

## MCP yüzeyi

| Grup | Tool'lar |
|---|---|
| Belge | `doc_create` `doc_open` `doc_save` `doc_export` (svg/png/pdf/json) `doc_import` (replace/merge) `doc_info` |
| Node | `node_add_path` (SVG `d` veya çapa+handle) `node_add_rect` `node_add_ellipse` `node_add_line` `node_add_text` `node_get` `node_list` `node_update` `node_delete` `node_to_path` |
| Düzen | `node_move` `node_transform` `node_set_style` `node_edit_handles` `node_reorder` |
| Operasyon | `boolean_union` `boolean_subtract` `boolean_intersect` `boolean_exclude` `path_offset` `path_outline_stroke` `group` `ungroup` `duplicate` `batch` |
| Katman / frame | `layer_create` `layer_move_node` `layer_toggle` `layer_lock` `frame_create` `frame_update` |
| Hassasiyet | `snap_to_grid` `add_guide` `remove_guide` `align_to` `distribute` |
| Görüntü / sorgu | `render_preview` (görsel döner; `grid`, `region`) `query_bbox` `query_intersect` `query_hit` |
| Geçmiş / kilit | `undo` `redo` `lock_acquire` `lock_release` `lock_status` |
| Resource | `masvector://document.json` `masvector://design.svg` `masvector://preview.png` `masvector://guide` |
| Prompt | `draw` — iş akışı rehberiyle çizim görevi |

## Tasarım kararları

- **Katmanlar**, frame'in en üst seviyesindeki `isLayer` gruplarıdır. Spec'teki grup modeli (`visible` + `locked`) aynen kullanılır, ayrı bir veri yapısı yok.
- **Boolean**, clipper-lib ile yapılır ve dönüşmüş/gruplanmış operandlarla çalışır. Her operandın dolgu kuralı önce kendi içinde çözülür, böylece evenodd delikler korunur. Sonuç tek bir path'tir. Ardından **eğri yeniden uydurma** (Schneider algoritması + köşe tespiti) düzleşmiş yayları kübik Bézier'e döndürür. Örnekte bir dağ ile dairenin kesişimi 189 düz segment yerine 11 düzenlenebilir çapa verdi, alan hatası %0,2'nin altında.
- **Eşzamanlılık** üç katmanlı:
  1. Kira tabanlı belge kilidi (`lock_acquire`, TTL'li, yenilenebilir). Kilit başkasındaysa 409 `LOCKED` döner.
  2. MCP katmanında `LOCKED` alındığında 5 sn'ye kadar üstel geri çekilmeyle otomatik yeniden deneme.
  3. İsteğe bağlı `expectedVersion` ile iyimser kontrol (`CONFLICT`).
- **Undo sahipliği:** bir ajan başka bir ajanın son değişikliğini geri alamaz (`CONFLICT`); `force=true` ile zorlanabilir. UI'daki insan kullanıcı her zaman zorlar.
- **`batch`:** birden çok operasyon tek atomik adımda ve tek undo adımında uygulanır. Biri başarısız olursa hiçbiri uygulanmaz ve hata `batch[i]` olarak işaretlenir.
- **Güvenlik:**
  - Dosya yolları çalışma dizinine hapsedilir (`--allow-any-path` ile kaldırılabilir).
  - `/api/rpc` yalnız `application/json` kabul eder (CSRF koruması).
  - Loopback'e bağlıyken yabancı `Host` başlıkları reddedilir (DNS rebinding koruması).
  - Electron'da `contextIsolation`, `sandbox` açık ve CSP tanımlı.
- **Render**, tek bir kaynaktan (`src/render/draw.ts`) hem Electron canvas'ında hem headless (`@napi-rs/canvas`) önizlemede yapılır. Grup opaklığı/filtresi ara katmanla doğru şekilde birleştirilir.
- **PDF** harici bağımlılık olmadan yazılır ve tamamen vektördür: Bézier'ler `c` operatörüyle, gradyanlar gerçek PDF shading ile, opaklık ve karışım modları ExtGState ile.

## Bilinen sınırlar

- SVG import: `clipPath`/`mask`/`pattern`/`marker` desteklenmez (uyarı döner). `<tspan>` konumlandırması tek satıra indirgenir.
- Sunucuda font ölçümü yoktur; metin bbox'ı karakter genişliği tahminidir. Metin boolean işlemlerine giremez.
- PDF metni standart Helvetica ile yazılır; ş/ğ/ı en yakın ASCII harfe düşer (uyarı verilir). SVG ve PNG tam Unicode destekler. PDF'de filtreler ve gradyan durak opaklığı dışa aktarılmaz.
- Undo/redo belge anlık görüntüleriyle çalışır (son 200 adım). Çok büyük belgelerde bellek kullanımı artar.

## Dizin

```
src/common        tipler, hatalar, id
src/math          matris, Bézier (kesin bbox, uyarlamalı düzleştirme), geometri, eğri uydurma
src/model         sahne, operasyon şemaları + işleyicileri, boolean/ofset, isabet testi
src/serialization path verisi (A/Q/T/S dahil), SVG import (CSS, gradyan href, use) / export, JSON, PDF
src/render        ortak canvas renderer, headless PNG
src/server        engine (doğruluk kaynağı), HTTP+SSE, backend (yerel/uzak), mcp/
src/ui            electron/ (main, preload), renderer/ (arayüz)
src/bin           doc-server, mcp-stdio, mcp-http
tests             core, serialization, integration (MCP HTTP + stdio + çoklu ajan + SSE)
```
