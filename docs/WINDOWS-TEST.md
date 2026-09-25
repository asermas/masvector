# MasVector 1.0.0 Beta — Windows test planı

Bu belge Windows'ta çalışan bir Claude oturumu (Claude Code) ya da elle test eden biri için yazıldı.
Komutlar **PowerShell** içindir. Her adımın sonunda **Beklenen** sonucu kontrol et ve en alttaki
**Rapor şablonunu** doldur. Bir adım başarısız olursa dur, tam hata çıktısını rapora ekle ve bir
sonraki bağımsız adımla devam et.

> Claude için not: Bu testler kullanıcının isteğiyle yapılıyor. Kurulum kullanıcı başınadır (yönetici
> izni gerekmez). Sistem ayarlarını değiştirme, Claude Desktop yapılandırmasına yalnız 5. adımda
> uygulamanın kendi komutuyla yazılır. Test bitince kaldırma adımı (9) isteğe bağlıdır; kullanıcıya sor.

- Depo: https://github.com/asermas/masvector
- Sürüm: https://github.com/asermas/masvector/releases/tag/v1.0.0

---

## 0. Ortam bilgisi

```powershell
[System.Environment]::OSVersion.VersionString
(Get-CimInstance Win32_OperatingSystem).Caption
$env:PROCESSOR_ARCHITECTURE
$env:USERNAME          # Türkçe karakter (ı, ş, ğ, ü, ö, ç) içeriyor mu? Rapora yaz.
Get-Command claude -ErrorAction SilentlyContinue | Select-Object Source
```

**Beklenen:** Windows 10/11, `AMD64`. `claude` bulunmuyorsa 5. ve 6. adımların Claude Code
kısımları "atlandı" olarak raporlanır.

---

## 1. İndir ve doğrula

```powershell
$T = Join-Path $env:USERPROFILE "Downloads\masvector-test"
New-Item -ItemType Directory -Force $T | Out-Null
$base = "https://github.com/asermas/masvector/releases/download/v1.0.0"
Invoke-WebRequest "$base/MasVector-Kurulum-1.0.0.exe" -OutFile "$T\MasVector-Kurulum-1.0.0.exe"
Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile "$T\SHA256SUMS.txt"
$h = (Get-FileHash "$T\MasVector-Kurulum-1.0.0.exe" -Algorithm SHA256).Hash.ToLower()
$beklenen = (Select-String "MasVector-Kurulum" "$T\SHA256SUMS.txt").Line.Split(" ")[0]
"hesaplanan: $h"; "beklenen:   $beklenen"; "eşleşiyor: $($h -eq $beklenen)"
```

**Beklenen:** `eşleşiyor: True` (dosya ~133 MB).

---

## 2. Kurulum

Sessiz kurulum (sihirbazsız):

```powershell
Start-Process "$T\MasVector-Kurulum-1.0.0.exe" -ArgumentList "/S" -Wait
$APP = Join-Path $env:LOCALAPPDATA "Programs\MasVector"
$EXE = Join-Path $APP "MasVector.exe"
Test-Path $EXE
Test-Path (Join-Path $APP "resources\poppler-win\bin\pdftocairo.exe")
Test-Path (Join-Path $APP "resources\app\dist\bin\mcp-stdio.js")
Test-Path (Join-Path ([Environment]::GetFolderPath("Desktop")) "MasVector.lnk")   # OneDrive Masaüstü de olabilir
```

**Beklenen:** Dört satır da `True`. SmartScreen uyarısı çıktıysa rapora yaz ("Ek bilgi → Yine de
çalıştır" ile geçilir). İstenirse sihirbazlı kurulum da ayrıca denenebilir (çift tıkla).

---

## 3. Uygulama açılıyor mu?

```powershell
Start-Process $EXE
Start-Sleep 8
Invoke-RestMethod http://127.0.0.1:7878/api/health
Get-Process MasVector | Select-Object Id, MainWindowTitle
Test-Path (Join-Path $env:USERPROFILE "MasVector")
```

**Beklenen:** `ok: True`. Birden çok `MasVector` süreci olması normaldir (pencere + belge sunucusu).
`MasVector` adlı başlıklı bir pencere var. `~\MasVector` çalışma klasörü oluştu.

Elle kontrol (kullanıcıdan ekran görüntüsü iste):
- Sol araç çubuğu, sağda Özellikler/Katmanlar paneli, altta durum çubuğunda yeşil **bağlı** yazısı.
- Dikdörtgen (R) ve elips (O) çiz, Ctrl+Z ile geri al. Çalışıyor mu?

---

## 4. Vektörleştirme (komut satırı, pencere gerekmez)

Test dosyalarını indir. Klasör adında **bilerek** Türkçe karakter ve boşluk var (Windows'ta poppler'ın
ASCII dışı yollarla çalıştığını doğrulamak için):

```powershell
$F = Join-Path $T "Çizim Testi ğüşıöç"
New-Item -ItemType Directory -Force $F | Out-Null
$raw = "https://raw.githubusercontent.com/asermas/masvector/main/tests/fixtures"
foreach ($n in "vector.pdf","scanned.pdf","logo.png","logo-q55.jpg","illustration.png") {
  Invoke-WebRequest "$raw/$n" -OutFile (Join-Path $F $n)
}
$env:ELECTRON_RUN_AS_NODE = "1"
$VEC = Join-Path $APP "resources\app\dist\bin\vectorize.js"
foreach ($n in "vector.pdf","scanned.pdf","logo.png","logo-q55.jpg","illustration.png") {
  "=== $n"
  & $EXE $VEC (Join-Path $F $n) --out (Join-Path $F "cikti\$n") --formats svg,pdf,png 2>&1 | Select-String '"verdict"|"pctOff"|"kind"|written|Error|Hata'
}
Remove-Item Env:ELECTRON_RUN_AS_NODE
Get-ChildItem $F | Select-Object Name, Length
```

**Beklenen:**

| Dosya | Tür | pctOff (hatalı piksel %) |
|---|---|---|
| vector.pdf | pdf-vector | < 0.25 (mükemmel) |
| scanned.pdf | pdf-scanned | < 1 |
| logo.png | image | < 0.25 |
| logo-q55.jpg | image | < 0.5 |
| illustration.png | image | < 0.3 |

Her girdi için `cikti\` altında `.svg`, `.pdf`, `.png` çıktıları oluşmalı; kaynak dosyalar değişmemeli (1.1'den itibaren CLI girdinin üzerine asla yazmaz: `--out` verilmezse çakışan çıktı `-vektor` son eki alır). `pdftocairo bulunamadı` ya da DLL hatası
çıkarsa bu **kritik** hatadır, tam çıktıyı rapora ekle.

---

## 5. Claude'a bağlama

```powershell
& $EXE --connect-claude=all
```

**Beklenen:** İki satır çıkmalı:
- `Claude Desktop → ...\Claude\claude_desktop_config.json` (Store sürümünde `...\Packages\Claude_...\` yolu).
- `Claude Code → Added stdio MCP server masvector ...`

Claude Code kontrolü:

```powershell
claude mcp get masvector
```

**Beklenen:** `Status: ✔ Connected`, `Environment: ELECTRON_RUN_AS_NODE=1`.

Claude Desktop kontrolü (kuruluysa):

```powershell
Get-Content (Join-Path $env:APPDATA "Claude\claude_desktop_config.json")
```

**Beklenen:** `mcpServers.masvector` var ve eski sunucular/ayarlar korunmuş. Yanında `.bak` yedeği var.

Menüden de bir kez dene: uygulamada **Ajanlar → Claude'a bağlan (MCP)…** diyaloğu açılıyor mu?
(Ekran görüntüsü.)

---

## 6. Ajan çizimi (canlı)

Uygulama açıkken **yeni** bir Claude Code oturumu başlat (MCP araçları oturum başında yüklenir) ve şunu iste:

> masvector araçlarıyla 800×600 bir frame'e basit bir logo çiz: lacivert dikdörtgen zemin, ortada
> turuncu daire, altında "TEST" yazısı. Sonra render_preview ile kontrol et.

**Beklenen:** Çizim MasVector penceresinde **canlı** belirir. Sağ alttaki "Ajant etkinliği" panelinde
işlemler listelenir. Kullanıcıdan pencerenin ekran görüntüsünü iste.

Aynı oturumda:

> masvector ile `<4. adımdaki klasör>\logo.png` dosyasını vektörleştir ve sadakat raporunu söyle.

**Beklenen:** `vectorize_image` aracı çalışır, sonuç pencerede görünür, verdict "mükemmel" ya da "çok iyi".

---

## 7. Uygulama kapalıyken MCP (sunucunun kendiliğinden başlaması)

```powershell
Get-Process MasVector -ErrorAction SilentlyContinue | Stop-Process
Start-Sleep 2
try { Invoke-RestMethod http://127.0.0.1:7878/api/health -TimeoutSec 2 } catch { "sunucu kapalı (beklenen)" }
```

Sonra yeni bir Claude Code oturumunda bir masvector aracı çağır (ör. "masvector'da node_list ile
belgedeki nesneleri listele").

```powershell
Invoke-RestMethod http://127.0.0.1:7878/api/health
```

**Beklenen:** İlk kontrol "sunucu kapalı", araç çağrısı başarılı, ikinci kontrol `ok: True`. Sonra
uygulamayı açınca aynı belge görünmeli.

---

## 8. Dışa aktarma ve kaydetme

Uygulamada:
1. Üst çubukta **SVG**, **PNG** ve **PDF** düğmeleriyle kaydet, dosyaları aç, doğru görünüyorlar mı?
2. **Vektörleştir…** düğmesiyle 4. adımdaki klasörden `vector.pdf` seç. Bildirim ve sadakat raporu çıkıyor mu?
3. Ctrl+S ile kaydet, uygulamayı kapatıp yeniden aç. Belge korunmuş mu?

---

## 9. (İsteğe bağlı) Kaldırma

Kullanıcıya sormadan yapma.

```powershell
Get-Process MasVector -ErrorAction SilentlyContinue | Stop-Process
Start-Process (Join-Path $APP "Uninstall MasVector.exe") -ArgumentList "/S" -Wait
Test-Path $EXE    # False beklenir
claude mcp remove masvector -s user
```

`~\MasVector` çalışma klasörü ve Claude Desktop'taki `masvector` kaydı kendiliğinden silinmez; kullanıcı isterse elle silinir.

---

## Rapor şablonu

```
Windows sürümü / mimari:
Kullanıcı adında Türkçe karakter: evet/hayır
SmartScreen uyarısı: evet/hayır

1 İndirme + SHA256 ........ ✅/❌
2 Kurulum ................. ✅/❌
3 Açılış + arayüz ......... ✅/❌
4 Vektörleştirme .......... ✅/❌  (pctOff: vector.pdf=, scanned.pdf=, logo.png=, logo-q55.jpg=, illustration.png=)
5 Claude'a bağlama ........ ✅/❌  (Desktop: , Code: )
6 Canlı ajan çizimi ....... ✅/❌
7 Kapalıyken MCP .......... ✅/❌
8 Dışa aktarma/kaydetme ... ✅/❌
9 Kaldırma ................ ✅/❌/atlandı

Hatalar (tam çıktı):
Ekran görüntüleri:
```
