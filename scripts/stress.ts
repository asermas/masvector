// Vektörleştirme stres koşucusu: her girdi ayrı süreçte (çökme/bellek/zaman aşımı yalıtımı).
// Kullanım: npx tsx scripts/stress.ts [korpus dizini=.lab/stress] [--only ad1,ad2] [--out .lab/stress-out]
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dir = path.resolve(argv.find((a) => !a.startsWith('--')) ?? '.lab/stress');
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = opt('only')?.split(',');
const outDir = path.resolve(opt('out') ?? '.lab/stress-out');
const TIMEOUT = Number(opt('timeout') ?? 180) * 1000;
mkdirSync(outDir, { recursive: true });

if (process.env.MV_STRESS_ONE) {
  // —— çocuk süreç: tek dosya
  const file = process.env.MV_STRESS_ONE;
  const { readFileSync } = await import('node:fs');
  const { isPdf, pdfToDoc, vectorizeImageToDoc } = await import('../src/vectorize/index.js');
  const { renderPNG } = await import('../src/render/png.js');
  const { walk } = await import('../src/model/scene.js');
  const t0 = performance.now();
  let peak = 0;
  const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  try {
    const buf = readFileSync(file);
    const reps: any[] = [];
    let doc: any;
    if (isPdf(file, buf)) { const r = await pdfToDoc(file); doc = r.doc; reps.push(...r.reports); }
    else { const r = await vectorizeImageToDoc(buf); doc = r.doc; reps.push(r.report); }
    const ms = performance.now() - t0;
    let paths = 0, anchors = 0;
    for (const f of doc.pages[0].frames) for (const w of walk(f.nodes)) if (w.node.type === 'path') { paths++; for (const sp of w.node.subpaths) anchors += sp.points.length; }
    const stem = path.join(process.env.MV_STRESS_OUT!, path.basename(file).replace(/\.[^.]+$/, ''));
    try { writeFileSync(`${stem}.png`, renderPNG(doc, { scale: 1 }).png); } catch {}
    clearInterval(tick);
    const worst = reps.reduce((m, r) => ((r.fidelity?.pctOff ?? 0) >= (m?.fidelity?.pctOff ?? -1) ? r : m), null);
    process.stdout.write(JSON.stringify({
      ok: true, ms: Math.round(ms), rssMB: Math.round(Math.max(peak, process.memoryUsage().rss) / 1048576),
      kind: worst?.kind, preset: worst?.preset, pctOff: worst?.fidelity?.pctOff, verdict: worst?.fidelity?.verdict,
      psnr: worst?.fidelity?.psnr, pages: reps.length, paths, anchors, warnings: reps.flatMap((r) => r.warnings ?? []),
    }));
  } catch (e: any) {
    clearInterval(tick);
    process.stdout.write(JSON.stringify({ ok: false, ms: Math.round(performance.now() - t0), code: e?.code, error: String(e?.message ?? e).slice(0, 300) }));
  }
  process.exit(0);
}

// —— ana süreç
const files = readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|gif|bmp|tiff?|pdf)$/i.test(f)).filter((f) => !only || only.some((o) => f.includes(o))).sort();
const rows: any[] = [];
for (const f of files) {
  const r = await new Promise<any>((res) => {
    execFile(process.execPath, ['--import', 'tsx', path.join(here, 'stress.ts')], {
      env: { ...process.env, MV_STRESS_ONE: path.join(dir, f), MV_STRESS_OUT: outDir }, timeout: TIMEOUT, maxBuffer: 16 << 20,
    }, (e, out, err) => {
      try { res(JSON.parse(String(out))); }
      catch { res({ ok: false, crashed: true, error: (e?.killed ? `ZAMAN AŞIMI ${TIMEOUT / 1000}s` : String(err || e?.message)).slice(0, 300) }); }
    });
  });
  rows.push({ file: f, ...r });
  const status = !r.ok ? `HATA ${r.error}` : `${r.verdict ?? '—'} pctOff=${r.pctOff ?? '—'} psnr=${r.psnr ?? '—'}`;
  console.log(`${f.padEnd(28)} ${String(r.ms ?? '').padStart(7)}ms ${String(r.rssMB ?? '').padStart(5)}MB  paths=${String(r.paths ?? '').padStart(5)} anchors=${String(r.anchors ?? '').padStart(6)}  ${status}${r.warnings?.length ? `  ⚠ ${r.warnings.join(' | ').slice(0, 140)}` : ''}`);
}
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 2));
