// Bayrak/zorlu girdi kıyas koşucusu: paralel çocuk süreçler.
// Her girdi için: pctOff (kaynağa), gt (temiz gerçek render'a), gt4 (4× büyütmede gerçek vektöre — gerçek SVG kalitesi),
// yapı (yol sayısı, renk sayısı, gradyan, piksel kipi).
// Kullanım: npx tsx scripts/flagbench.ts [--only a,b] [--out .lab/flags/out] [--j 4]
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(here, '..', '.lab/flags');
const outDir = process.env.MV_FB_OUT ?? path.resolve(opt('out') ?? path.join(root, 'out'));
mkdirSync(outDir, { recursive: true });

if (process.env.MV_FB_ONE) {
  const file = process.env.MV_FB_ONE;
  const base = process.env.MV_DIST ? '../dist' : '../src';
  const { vectorizeImageToDoc } = await import(`${base}/vectorize/index.js`);
  const { compareDocument, compareRGBA } = await import(`${base}/vectorize/compare.js`);
  const { renderRGBA, decodeImageBuffer, renderPNG } = await import(`${base}/render/png.js`);
  const { walk } = await import(`${base}/model/scene.js`);
  const { frameToSVG } = await import(`${base}/serialization/svg-export.js`);
  const t0 = performance.now();
  try {
    const extra = process.env.MV_OPTS ? JSON.parse(process.env.MV_OPTS) : {};
    const r = await vectorizeImageToDoc(readFileSync(file), extra);
    const ms = performance.now() - t0;
    const doc = r.doc, f = doc.pages[0].frames[0];
    const stem = path.basename(file).replace(/\.[^.]+$/, '');
    const hide = r.referenceId ? [r.referenceId] : [];
    let paths = 0, anchors = 0, grads = 0, prims = 0; const colors = new Set<string>();
    for (const w of walk(f.nodes)) {
      const n: any = w.node; if (w.ancestors.some((a: any) => a.locked) || n.type === 'image') continue;
      if (n.type === 'path') { paths++; for (const sp of n.subpaths) anchors += sp.points.length; }
      if (n.type === 'rect' || n.type === 'ellipse') prims++;
      const fl = n.style?.fill; if (typeof fl === 'string') { if (fl !== 'none') colors.add(fl); } else if (fl) grads++;
    }
    const svg = frameToSVG(f, { skipHidden: true });
    writeFileSync(path.join(outDir, `${stem}.svg`), svg);
    const out: any = { ok: true, ms: Math.round(ms), pctOff: r.report.fidelity?.pctOff, psnr: r.report.fidelity?.psnr, preset: r.report.preset,
      paths, prims, anchors, colors: colors.size, grads, pixel: (r.report.warnings ?? []).some((w: string) => /piksel-birebir/i.test(w)), svgKB: Math.round(svg.length / 1024) };
    const tp = path.join(root, 'truth', `${stem}.png`), tp4 = path.join(root, 'truth4', `${stem}.png`);
    if (existsSync(tp)) { const t = decodeImageBuffer(readFileSync(tp))!; out.gt = compareDocument(doc, t, { hide }).metrics.pctOff; }
    if (existsSync(tp4)) {
      const t = decodeImageBuffer(readFileSync(tp4))!;
      const clone = structuredClone(doc); const hs = new Set(hide);
      const vis = (ns: any[]) => ns.forEach((n) => { if (hs.has(n.id)) n.visible = false; if (n.children) vis(n.children); });
      vis(clone.pages[0].frames[0].nodes);
      const rr = renderRGBA(clone, { width: t.width, height: t.height, background: true });
      const cm = compareRGBA(t.rgba, rr.rgba as any, t.width, t.height);
      out.gt4 = cm.metrics.pctOff;
      if (process.env.MV_FB_PNG) writeFileSync(path.join(outDir, `${stem}-4x.png`), renderPNG(clone, { scale: 4 }).png);
    }
    process.stdout.write(JSON.stringify(out));
  } catch (e: any) { process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack ?? e).slice(0, 400) })); }
  process.exit(0);
}

const only = opt('only')?.split(',');
const J = Number(opt('j') ?? 4);
const dir = path.join(root, 'corpus');
const files = readdirSync(dir).filter((f) => !only || only.some((o) => f.includes(o))).sort();
const rows: any[] = new Array(files.length);
let next = 0;
async function worker() {
  while (next < files.length) {
    const i = next++, f = files[i];
    rows[i] = await new Promise<any>((res) => execFile(process.execPath, ['--import', 'tsx', path.join(here, 'flagbench.ts')], {
      env: { ...process.env, MV_FB_ONE: path.join(dir, f), MV_FB_OUT: outDir }, timeout: 300000, maxBuffer: 16 << 20,
    }, (e, out, err) => { try { res({ file: f, ...JSON.parse(String(out)) }); } catch { res({ file: f, ok: false, error: String(err || e?.message).slice(0, 300) }); } }));
    const r = rows[i];
    console.log(`${f.padEnd(26)} ${r.ok ? `off=${String(r.pctOff).padEnd(6)} gt=${String(r.gt ?? '-').padEnd(6)} gt4=${String(r.gt4 ?? '-').padEnd(6)} paths=${String(r.paths).padEnd(4)} prim=${r.prims} col=${r.colors} grad=${r.grads}${r.pixel ? ' PIKSEL' : ''} ${r.ms}ms` : 'HATA ' + r.error}`);
  }
}
await Promise.all(Array.from({ length: J }, worker));
const ok = rows.filter((r) => r.ok);
const max = (k: string) => ok.reduce((m, r) => (typeof r[k] === 'number' && r[k] > m.v ? { v: r[k], f: r.file } : m), { v: -1, f: '' });
const sum = (k: string) => +ok.reduce((s, r) => s + (r[k] ?? 0), 0).toFixed(3);
const summary = { n: rows.length, failed: rows.length - ok.length, pixel: ok.filter((r) => r.pixel).length, over05: ok.filter((r) => r.pctOff > 0.5).length,
  maxOff: max('pctOff'), sumOff: sum('pctOff'), maxGt: max('gt'), sumGt: sum('gt'), maxGt4: max('gt4'), sumGt4: sum('gt4'), grads: sum('grads'), timeS: Math.round(sum('ms') / 1000) };
console.log(JSON.stringify(summary));
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ summary, rows }, null, 2));
