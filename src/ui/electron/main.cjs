// Electron ana süreci. UI yalnız bir render istemcisidir: belge Document Server'dadır.
// Sunucu çalışmıyorsa AYRI bir süreç olarak başlatılır (3 süreçli mimari korunur).
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const argv = process.argv.slice(1);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const SERVER = (argVal('--server') || process.env.MASVECTOR_URL || 'http://127.0.0.1:7878').replace(/\/$/, '');
const WORKSPACE = argVal('--workspace') || process.env.MASVECTOR_WORKSPACE || path.join(os.homedir(), 'MasVector');

let child = null;
let win = null;

async function healthy() {
  try { const r = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; }
}

async function ensureServer() {
  if (await healthy()) return 'mevcut';
  const port = new URL(SERVER).port || '7878';
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const built = path.join(ROOT, 'dist', 'bin', 'doc-server.js');
  const args = fs.existsSync(built)
    ? [built]
    : ['--import', 'tsx', path.join(ROOT, 'src', 'bin', 'doc-server.ts')];
  args.push('--port', port, '--workspace', WORKSPACE, '--allow-any-path');
  child = spawn(process.execPath, args, {
    cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => { child = null; if (code) console.error(`[electron] doc-server çıktı: ${code}`); });
  for (let i = 0; i < 60; i++) { if (await healthy()) return 'başlatıldı'; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`Document Server başlatılamadı (${SERVER})`);
}

async function rpc(method, params) {
  const r = await fetch(`${SERVER}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, agentId: 'ui:insan' }),
  });
  const b = await r.json();
  if (!b.ok) throw new Error(b.error?.message ?? `HTTP ${r.status}`);
  return b.result;
}

function menu() {
  const guard = (fn) => async () => { try { await fn(); } catch (e) { dialog.showErrorBox('MasVector', String(e.message ?? e)); } };
  return Menu.buildFromTemplate([
    {
      label: 'Dosya',
      submenu: [
        { label: 'Yeni', accelerator: 'CmdOrCtrl+N', click: guard(() => rpc('doc_create', { title: 'Adsız' })) },
        {
          label: 'Aç…', accelerator: 'CmdOrCtrl+O', click: guard(async () => {
            const r = await dialog.showOpenDialog(win, { filters: [{ name: 'MasVector / SVG', extensions: ['json', 'svg'] }], properties: ['openFile'] });
            if (!r.canceled && r.filePaths[0]) await rpc('doc_open', { path: r.filePaths[0] });
          }),
        },
        {
          label: 'SVG içe aktar (birleştir)…', click: guard(async () => {
            const r = await dialog.showOpenDialog(win, { filters: [{ name: 'SVG', extensions: ['svg'] }], properties: ['openFile'] });
            if (!r.canceled && r.filePaths[0]) await rpc('doc_import', { path: r.filePaths[0], format: 'svg', mode: 'merge', name: path.basename(r.filePaths[0]) });
          }),
        },
        { type: 'separator' },
        { label: 'Kaydet', accelerator: 'CmdOrCtrl+S', click: guard(() => rpc('doc_save', {})) },
        {
          label: 'Farklı kaydet…', accelerator: 'CmdOrCtrl+Shift+S', click: guard(async () => {
            const r = await dialog.showSaveDialog(win, { defaultPath: path.join(WORKSPACE, 'belge.json'), filters: [{ name: 'MasVector JSON', extensions: ['json'] }, { name: 'SVG', extensions: ['svg'] }, { name: 'PDF', extensions: ['pdf'] }, { name: 'PNG', extensions: ['png'] }] });
            if (!r.canceled && r.filePath) await rpc('doc_save', { path: r.filePath });
          }),
        },
        { type: 'separator' },
        { label: 'Çalışma dizinini aç', click: () => shell.openPath(WORKSPACE) },
        { type: 'separator' },
        { role: 'quit', label: 'Çık' },
      ],
    },
    { label: 'Görünüm', submenu: [{ role: 'reload', label: 'Yenile' }, { role: 'toggleDevTools', label: 'Geliştirici araçları' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Tam ekran' }] },
  ]);
}

ipcMain.handle('save-export', async (_e, format, url) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(WORKSPACE, `tasarim.${format}`), filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (r.canceled || !r.filePath) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dışa aktarma başarısız: HTTP ${res.status}`);
  fs.writeFileSync(r.filePath, Buffer.from(await res.arrayBuffer()));
  return r.filePath;
});
ipcMain.handle('server-info', () => ({ server: SERVER, workspace: WORKSPACE, spawned: !!child }));

app.whenReady().then(async () => {
  let how;
  try { how = await ensureServer(); }
  catch (e) { dialog.showErrorBox('MasVector', String(e.message)); app.quit(); return; }
  console.error(`[electron] Document Server ${how}: ${SERVER}`);
  Menu.setApplicationMenu(menu());
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 500, backgroundColor: '#1b1d22', title: 'MasVector',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL(`${SERVER}/?server=${encodeURIComponent(SERVER)}`);
  if (process.env.MASVECTOR_SCREENSHOT) {
    // Başsız doğrulama: pencere görüntüsünü alıp çık
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.MASVECTOR_SCREENSHOT, img.toPNG());
      app.quit();
    }, Number(process.env.MASVECTOR_SCREENSHOT_DELAY || 1500));
  }
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => { if (child) child.kill('SIGTERM'); });
