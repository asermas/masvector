import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/** Küçük argüman ayrıştırıcı: --key value, --flag, --no-flag. */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) out[k] = v;
    else if (k.startsWith('no-')) out[k.slice(3)] = false;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** Proje kökü (src/bin veya dist/bin'den iki üst). */
export const PROJECT_ROOT = path.resolve(here, '..', '..');
export const UI_DIR = path.join(PROJECT_ROOT, 'dist', 'ui');
export const uiAvailable = () => existsSync(path.join(UI_DIR, 'index.html'));

export const HELP_COMMON = `
  --workspace DIR      Göreli yolların kökü ve kayıt dizini (varsayılan: geçerli dizin)
  --file PATH          Başlangıçta açılacak .json/.svg (yoksa oluşturulur)
  --no-autosave        Otomatik kaydı kapat
  --allow-any-path     Çalışma dizini dışına okuma/yazmaya izin ver
`;
