// Linux'ta Windows kurulum dosyası (NSIS .exe) üretimi — wine gerektirmeden.
// electron-builder, kaldırıcıyı (uninstaller) çıkarmak için normalde derlenen kurulumu wine ile çalıştırır.
// macOS'ta ise aynı işi saf JS ile yapan UninstallerReader'ı kullanır; o yolu burada da seçtiriyoruz.
// Not: makensis Türkçe yerel ayarda (i→İ) yönergeleri tanımıyor → LANG=C.UTF-8 şart.
process.env.LANG = 'C.UTF-8';
process.env.LC_ALL = 'C.UTF-8';
if (process.platform !== 'win32') require('app-builder-lib/out/util/macosVersion').isMacOsCatalina = () => true;

const { build, Platform, Arch } = require('electron-builder');
build({ targets: Platform.WINDOWS.createTarget(null, Arch.x64) })
  .then((files) => { for (const f of files) console.log(`✓ ${f}`); })
  .catch((e) => { console.error(e); process.exit(1); });
