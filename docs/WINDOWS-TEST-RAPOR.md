# MasVector 1.0.0 Beta — Windows test raporu (2026-09-25)

```
Windows sürümü / mimari: Windows 11 Pro 10.0.26200 / AMD64
Kullanıcı adında Türkçe karakter: hayır (aserm) — ama Masaüstü yolu Türkçe: C:\Users\aserm\OneDrive\Masaüstü
SmartScreen uyarısı: hayır (sessiz /S kurulum)

1 İndirme + SHA256 ........ ✅  (126.8 MiB, hash eşleşti)
2 Kurulum ................. ✅  (kısayol OneDrive\Masaüstü'nde; planın Test-Path'i yanlış yola bakıyor)
3 Açılış + arayüz ......... ✅  (health ok, pencere + 4 yardımcı süreç, ~\MasVector oluştu; R çizimi + Ctrl+Z çalışıyor)
4 Vektörleştirme .......... ⚠️  (pctOff: vector.pdf=0.001, scanned.pdf=0.103, logo.png=0.079, logo-q55.jpg=0.237, illustration.png=0.121 — hepsi "mükemmel";
                                 Türkçe/boşluklu yol sorunsuz; AMA girdi dosyasının üzerine yazıyor, bkz. H1)
5 Claude'a bağlama ........ ✅  (Desktop: ✅ her iki config — Roaming + Store Packages, eski unityMCP korundu, .bak var;
                                 Code: `claude` PATH'te yok → komut doğru mesajla atladı; paketli claude.exe ile elle eklendi → √ Connected;
                                 Ajanlar → "Claude'a bağlan (MCP)…" diyaloğu açılıyor; "Claude Code'a ekle" PATH yokken doğru hata veriyor;
                                 ~\.local\bin\claude.cmd (Desktop'ın paketli CLI'ına yönlendirici) PATH'e eklenince hem --connect-claude=all
                                 hem "Claude Code'a ekle" düğmesi ✅ — mevcut kaydı remove+add ile güncelliyor)
6 Canlı ajan çizimi ....... ⚠️  (gerçek Claude Code oturumu, masvector MCP araçlarıyla: frame_create + batch + render_preview doğru;
                                 AMA yeni frame pencerede hiç görünmüyor — %36 yakınlaştırmada bile, bkz. H2;
                                 vectorize_image merge ✅ mükemmel (logo-q55.jpg pctOff 0.237), pencerede anında göründü)
7 Kapalıyken MCP .......... ✅  (sunucu kapalı → araç çağrısı ~1 s'de sunucuyu başlattı → ok; sonra uygulama açılınca aynı belge, port çakışması yok)
8 Dışa aktarma/kaydetme ... ✅  (UI: SVG/PNG/PDF düğmeleri → Farklı Kaydet → dosyalar doğru (PDF poppler ile render edilip kontrol edildi);
                                 Vektörleştir… → Türkçe yoldaki vector.pdf → bildirim "sadakat mükemmel (%0.001 fark)";
                                 Ctrl+Z içe aktarmayı tamamen geri alıyor; Ctrl+S → kapat → tüm süreçler öldürüldü → yeniden aç: belge korunmuş (v14);
                                 MCP doc_export svg/png/pdf Türkçe yola da yazıyor)
9 Kaldırma ................ atlandı (kullanıcıya sorulacak)
```

## Hatalar

### H1 — KRİTİK: vectorize CLI kaynak dosyanın üzerine yazıyor
`--out` verilmezse çıktı tabanı = girdi adı (uzantısız). Girdi uzantısı istenen formatlardan biriyle
aynıysa (`x.pdf` + `--formats pdf`, `x.png` + `--formats png`) kaynak sessizce ezilir. Test planındaki
komut 5 girdinin 4'ünü bozdu (yalnız `.jpg` kurtuldu):

```
vector.pdf         repo=22309 test=91340  aynı=False
scanned.pdf        repo=47206 test=6937   aynı=False
logo.png           repo=52018 test=128523 aynı=False
illustration.png   repo=53871 test=152826 aynı=False
```
Öneri: çıktı yolu girdiyle aynıysa `-vektor` son eki ekle ya da hata ver; `--overwrite` bayrağı olmadan asla ezme.
Aynı durum MCP `vectorize_image`/UI "Vektörleştir…" dışa aktarımında da kontrol edilmeli.

### H2 — Ajanın oluşturduğu ek frame'ler arayüzde görünmüyor
`frame_create` (800×600, x=0,y=0) + içine rect/ellipse/text → `render_preview` doğru görüntüyü veriyor,
belge sürümü artıyor, Ajan etkinliği panelinde işlemler listeleniyor; ama tuval yalnızca ilk frame'i
("Çerçeve 1", 1024×768) çiziyor, Katmanlar paneli "Boş belge" diyor. Frame seçici de yok.
Aynı anda ilk frame'e eklenen şekil anında göründü → canlı senkron sağlam, sorun çoklu-frame gösterimi.
Test planındaki 6. adım istemi ("800×600 bir frame'e … çiz") ajanı büyük olasılıkla bu yola sokar.
Tekrar testi (gerçek Claude Code oturumu): frame x=1900'e açıldı, "sığdır" ve %36 uzaklaştırmada da boş.
Sonuç: arayüzdeki SVG/PNG/PDF dışa aktarma da yalnızca 1. frame'i yazıyor — ajanın çizdiği logo arayüzden hiç alınamıyor.

### H3 — `vectorize_image mode:"replace"` tüm belgeyi değiştiriyor
`parentId` verilmesine rağmen belge yenilendi (yeni doc/frame id'leri); önceki frame'ler kayboldu,
sonraki `render_preview(frameId=eski)` → NOT_FOUND. Beklenen davranış buysa araç açıklamasında belirtilmeli.

### Küçük notlar
- `--connect-claude` çıktısında Node `DEP0190` uyarısı (spawn + `shell:true` ile argüman) — hem görüntü hem kaçışsız argüman riski.
- Claude Desktop Store sürümünde paketli `claude.exe` var (`…\Packages\Claude_…\LocalCache\Roaming\Claude\claude-code\<sürüm>\claude.exe`);
  PATH'te `claude` yoksa bu yol yedek olarak denenebilir.
- Plan düzeltmesi: kısayol kontrolü `[Environment]::GetFolderPath('Desktop')` kullanmalı; 4. adım `--out` ile ayrı klasöre yazmalı.
- "Claude'a bağlan" diyaloğunda Desktop JSON'undaki yol ekranda `resources\\app...\\mcp-stdio.js` diye kısaltılmış; ekrandan kopyalayan bozuk yol alır ("Ayarları kopyala" düğmesi kullanılmalı).
- Hata kutusunun başlığı İngilizce "Error" (arayüzün geri kalanı Türkçe).
- Vektörleştir bildirimi ~3 s'den kısa sürüyor; sadakat raporunu kaçırmak kolay.
- İçe aktarılan PDF'de Katmanlar paneli ham id'ler gösteriyor (`path_i7j3lqm7_515` …); vectorize_image'daki gibi "Renk N #hex" tarzı ad daha okunur.
- Ctrl+S sessiz kaydediyor (görsel onay yok); ayrıca içe aktarmada otomatik kayıt da yapılıyor.
- UI "Vektörleştir…" mevcut belgeyi onay sormadan değiştiriyor (Ctrl+Z ile geri geliyor).
- Test sırasında pencere bir kez açıklanamayan şekilde kapandı (bağlan diyaloğu açıkken; çökme kaydı/Crashpad yok). Sebep can be RDC: otomasyonun modal pencereye ShowWindow göndermesi. Yeniden üretilemedi.
- `node_delete` parametresi `ids` (dizi) — `node_add_*` tekil `id` döndürdüğü için ajanlar ilk denemede `id` gönderebilir.

## Ekran görüntüleri
window6.png (H2: boş tuval + Ajan etkinliği), window6b.png (ilk frame'e ekleme anında görünüyor),
render_preview (TEST logosu), window6c.png (vectorize_image canlı), ui_rect/ui_undo (R + Ctrl+Z),
r6_zoomout.png (H2 tekrar), r5_dialog.png (bağlan diyaloğu), r8_t1.png (Vektörleştir bildirimi), r8_reopen.png (yeniden açılış).
