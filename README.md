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
npm test             # 56 test: birim + vektörleştirme kalitesi + gerçek MCP istemcili entegrasyon
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

## Windows (.exe) ve paketleme

```bash
npm run dist:win     # → release/MasVector-Kurulum-1.1.0.exe (NSIS kurulum) + MasVector-1.1.0-win.zip (taşınabilir)
npm run dist:linux   # → AppImage + .deb
```

Windows paketi Linux'ta **wine gerektirmeden** üretilir:
- `scripts/win-natives.mjs` — `@napi-rs/canvas` ve `@neplex/vectorizer`'ın win32-x64 derlemelerini `node_modules`'e koyar (yalnız sistem DLL'lerine bağlılar).
- `scripts/fetch-poppler-win.sh` — PDF için poppler'ı (pdftocairo/pdftoppm/pdfinfo) indirir, yalnız içe aktarılan DLL'leri tutar → `resources/poppler-win`. Kullanıcının ayrıca bir şey kurması gerekmez.
- `scripts/dist-win.cjs` — electron-builder'ın kaldırıcıyı wine ile çıkarma adımı yerine saf JS okuyucusunu kullanır.
- Tuzak: makensis Türkçe yerel ayarda (`i`→`İ`) yönergeleri tanımıyor; betik `LANG=C.UTF-8` ayarlar.

Kurulum kullanıcı başınadır (`%LOCALAPPDATA%\Programs\MasVector`, yönetici izni gerekmez), masaüstü ve Başlat menüsü kısayolu oluşturur. İmzasız olduğu için ilk açılışta SmartScreen "Yine de çalıştır" isteyebilir.

### Claude'a bağlama (Windows / paketli sürüm)

Uygulamada **Ajanlar → Claude'a bağlan (MCP)…**:
- **Claude Desktop'a ekle** → `%APPDATA%\Claude\claude_desktop_config.json` (Microsoft Store sürümünün sanal yolu da) içine `masvector` sunucusunu yazar, eskisini `.bak` olarak saklar. Claude Desktop yeniden başlatılır.
- **Claude Code'a ekle** → `claude mcp add --scope user …` çalıştırır.

Pencere açmadan: `MasVector.exe --connect-claude=desktop|code|all`.

Kaydedilen komut uygulamanın kendi exe'sidir; ayrı Node kurulumu gerekmez:
```json
{ "mcpServers": { "masvector": {
  "command": "C:\\Users\\<ad>\\AppData\\Local\\Programs\\MasVector\\MasVector.exe",
  "args": ["C:\\Users\\<ad>\\AppData\\Local\\Programs\\MasVector\\resources\\app\\dist\\bin\\mcp-stdio.js",
           "--server", "http://127.0.0.1:7878", "--ensure-server"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
```
`ELECTRON_RUN_AS_NODE=1` exe'yi düz Node olarak çalıştırır; `--ensure-server` masaüstü uygulaması kapalıysa belge sunucusunu arka planda başlatır (çalışma dizini `~/MasVector`). Uygulama açıksa ajan çizdikçe pencerede canlı görünür. Uygulama açıkken HTTP de kullanılabilir: `claude mcp add --transport http masvector http://127.0.0.1:7878/mcp`.

## PDF / görsel → vektör

Uygulama kendi başına (komut satırı), arayüzden ("Vektörleştir…" düğmesi, Electron'da *Dosya → PDF / görsel vektörleştir…*) veya bir ajan üzerinden (MCP: `pdf_import`, `vectorize_image`, `compare_reference`) çalışır. Her dönüşüm kaynağa karşı **piksel piksel doğrulanır** ve raporlanır.

```bash
npm run vectorize -- logo.jpg --out cikti/logo --formats svg,pdf,png --diff
npm run vectorize -- katalog.pdf --pages 1,3 --out cikti/katalog
npm run vectorize -- kurumsal.png --palette "#d91933,#193373,#f3a619"
```

**PDF:**
- Vektör sayfalar poppler (`pdftocairo`) ile kayıpsız okunur: yollar, gradyanlar, kırpma maskeleri, alfalı görseller; metin glif eğrisi olarak gelir.
- Ardından yapı, görüntü değişmeden sadeleştirilir:
  - glifler satır başına tek path'e birleştirilir,
  - gereksiz kırpmalar atılır,
  - "gradyan dikdörtgen + yuvarlak kırpma" gibi kalıplar tek şekle indirilir,
  - sayfa zemini frame arka planı olur.
- Test sayfasında 171 node 8'e indi ve doğrulama `pdftoppm` render'ına karşı %0,04 fark verdi.
- Taranmış (yalnız görsel içeren) sayfalar otomatik tespit edilip 300 dpi'den izlenir.

**Görsel (PNG/JPEG/WebP/GIF/BMP/TIFF):** iki kip yarışır, ölçüte göre iyi olan (eşitse daha sade olan) seçilir.
- **Palet kipi (logo/düz renk):**
  1. OKLab'de k-means; palet yalnız düz bölgelerden öğrenilir. Böylece kenar yumuşatma karışımları sahte renk üretmez.
  2. Kenar pikselleri yalnız komşu düz bölgelerin renklerinden birine atanır.
  3. Çoğunluk filtresi ve leke temizliği uygulanır.
  4. Her renk kendi bağımsız şekli olarak izlenir (vtracer) ve yalnız üstündeki komşu renklerin altına ~1 px taşar: ne boşluk kalır ne gizli geometri.
  5. Son olarak: gürültü uyarlamalı maske yumuşatma, Schneider eğri uydurma (pencereli köşe algılama), eşdoğrusal kübikleri doğruya indirme ve sivri köşe onarımı.
- **Gradyan kipi (illüstrasyon/ikon/foto):**
  1. Görsel keskin kenarlardan bölgelere ayrılır.
  2. Her bölgeye sabit, doğrusal ya da radyal gradyan uydurulur (duraklar ve opaklık dahil).
  3. Modelin açıklayamadığı piksel kümeleri ayrı bölge olur (gradyan zemin üstündeki düşük kontrastlı şekiller).
  4. Saydam zemine sönen yumuşak gölge ve parıltılar halka halka değil, **bulanıklık filtreli tek şekil** olarak çıkar.

- **İnce yapılar (1.1):** 1–2 px çizgiler ve küçük metin hiç düz piksel içermez. Palet renkleriyle ya da karışımlarıyla açıklanamayan, iki yanında aynı zemin olan pikseller ayrıca kümelenir. Renk, kenar yumuşatmasının ötesine (tam kaplamaya) dışdeğerlenir. JPEG çınlaması ve bölge kenarı saçakları bu yola girmez.
- **Kaydırılmış gölge (1.1):** drop shadow'da örtücü nesnenin kayması aranır. σ ve opaklık, "kaydırılmış şekil ⊛ Gauss" modelinin görünen alfaya uydurulmasıyla bulunur.
- **Piksel-birebir kip (1.1):** dama, titreşimli (dithered) 1-bit görseller, piksel sanatı, ≤32 px ikonlar ve ince şeritler, TAM renk başına birleştirilmiş dikdörtgenlerle kesin vektöre çevrilir. Pürüzsüz yorum için `refine: false` kullanın.
- **Karmaşıklık cezası (1.1):** basit sonuç zaten çok iyiyse (≤%1,5), 3 kattan fazla çapa kullanan "daha sadık" sonuç seçilmez. JPEG'li küçük logoda onlarca renk bölgesi yerine 4 temiz renk çıkar.

**Doğrulama ölçütü:**
- Algısal renk farkı (OKLab ΔE > 0,04) üzerinden hesaplanır.
- 1 px konum ve kenar yumuşatma karışımı toleranslıdır.
- JPEG gibi kayıplı ya da gürültülü kaynaklarda, kenar koruyan süzgeçle (medyan + sigma) temizlenmiş kaynağa karşı ölçülür. ≤64 px görsellerde temizlenmez, çünkü orada "gürültü" ayrıntıdır.
- Karar: < %0,25 **mükemmel**, < %1 **çok iyi**.

Ölçülmüş sonuçlar (Ubuntu sistem görselleri + test fikstürleri):

| Girdi | Tür | Fark | Sonuç | Katman / çapa |
|---|---|---|---|---|
| Logo PNG | düz 3 renk | %0,08 | mükemmel | 3 / 112 |
| Aynı logo, JPEG %55 | gürültülü | %0,24 | mükemmel | 3 / 235 |
| Aynı logo, 360 px JPEG | küçük | %0,74 | çok iyi | 3 / 103 |
| Gradyanlı illüstrasyon | gradyan + gölge | %0,12 | mükemmel | 113 / 3305 |
| Firefox ikonu 256 px | karmaşık gradyan | %0,24 | mükemmel | 95 / 1043 |
| Ubuntu ikonu 256 px | gradyan + yumuşak gölge | %0,15 | mükemmel | 58 / 510 |
| Ubuntu metin logosu | saydam zemin | %0,14 | mükemmel | 3 / 137 |
| Düşük poligon rakun 4K | düşük kontrast | %0,03 | mükemmel | 6 / 279 |
| Uçan kutular 4K | dalga + gölge | %0,08 | mükemmel | 35 / 16 k |
| Fotoğraf (Red Acer 4K) | foto | %0,44 | çok iyi | 844 / 71 k (2,5 MB) |
| Taranmış PDF | raster sayfa | %0,10 | mükemmel | 3 |
| Vektör PDF | yol + metin + görsel | %0,04 | mükemmel | 8 |

**Stres testi (1.1):** `npm run stress` 46 zor girdi üretir ve her birini ayrı süreçte ölçer. Girdiler: 1×1 ile 3000² arası boyutlar, 6000×160 panorama, 20×900 şerit, kıl çizgiler, 8–110 px metin, doğrusal/radyal/bantlı gradyan, yarı saydam örtüşme, kaydırılmış yumuşak gölge, JPEG q10/q30, bulanık, gürültülü, perspektifli "telefon fotoğrafı", 64 renk, piksel sanatı, 1 px dama, saf gürültü, CMYK/EXIF/16-bit/1-bit/GIF/WebP/BMP/TIFF, bozuk dosyalar, eğik ve çok sayfalı taranmış PDF.

| | 1.0 | 1.1 |
|---|---|---|
| Mükemmel / çok iyi / iyi / zayıf (+3 bozuk dosya: anlamlı hata) | 25 / 5 / 6 / 7 | 30 / 7 / 4 / 2 |
| 512 px logo | 6,2 s | 1,0 s |
| Bulanık logo | 25,7 s (%0,92) | 8,0 s (%0,20) |
| 1 px dama / 1-bit titreşim | 99 s / 87 s (zayıf) | 0,1 s / 0,2 s (%0) |
| Kaydırılmış yumuşak gölge | %13,7 | %0,002 |
| Gürültülü logo (σ≈18) | %4,9 | %0,10 |

Zayıf kalan iki girdi: 1 px kenar yumuşatmalı kıl çizgiler (%7,8; kusursuz geometriyle çizilmiş vektör bile bu kaynağa göre %1,4 alır) ve saf rastgele gürültü (vektörle temsil edilemez).

## MCP yüzeyi

| Grup | Tool'lar |
|---|---|
| Belge | `doc_create` `doc_open` `doc_save` `doc_export` (svg/png/pdf/json) `doc_import` (replace/merge) `doc_info` |
| Node | `node_add_path` (SVG `d` veya çapa+handle) `node_add_rect` `node_add_ellipse` `node_add_line` `node_add_text` `node_get` `node_list` `node_update` `node_delete` `node_to_path` |
| Düzen | `node_move` `node_transform` `node_set_style` `node_edit_handles` `node_reorder` |
| Operasyon | `boolean_union` `boolean_subtract` `boolean_intersect` `boolean_exclude` `path_offset` `path_outline_stroke` `group` `ungroup` `duplicate` `batch` |
| Katman / frame | `layer_create` `layer_move_node` `layer_toggle` `layer_lock` `frame_create` `frame_update` |
| Hassasiyet | `snap_to_grid` `add_guide` `remove_guide` `align_to` `distribute` |
| Vektörleştirme | `pdf_import` (vektör birebir, taranmış → izleme) `vectorize_image` (replace/merge) `compare_reference` (metrik + fark haritası görseli) |
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

- 1 px kenar yumuşatmalı kıl çizgiler dış hat olarak izlenir: renk ve süreklilik doğrudur ama kalınlık/konum ±0,5 px dalgalanabilir (merkez çizgisi/stroke çıkarımı yok).
- Fotoğraflar vektörleştirilebilir ama sonuç ağırdır (binlerce şekil) ve fotoğrafik ayrıntı basitleşir; vektör, logo/illüstrasyon/çizim için doğru araçtır.
- SVG yalnız doğrusal/radyal gradyanı destekler: karmaşık 2B renk geçişleri birkaç gradyan bölgesine bölünür (yakından bakınca hafif dikiş görülebilir).
- PDF içe aktarma poppler-utils gerektirir (`sudo apt install poppler-utils`). PDF metinleri glif eğrisi olarak gelir (görünüm birebir, düzenlenebilir metin değil).
- Karmaşık yumuşak maskeler (görsel olmayan `mask` içerikleri) maskesiz aktarılır ve uyarı verilir.

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
