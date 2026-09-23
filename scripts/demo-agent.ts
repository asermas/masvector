// Scriptli demo ajan: MCP Streamable HTTP üzerinden bağlanıp bir illüstrasyon çizer.
// Kullanım: npm run mcp-http   (ayrı terminalde)   →   npx tsx scripts/demo-agent.ts [http://127.0.0.1:7878/mcp]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:7878/mcp';
const slow = Number(process.env.DEMO_DELAY ?? 0);
const client = new Client({ name: 'demo-ajan', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

async function t(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const txt = r.content.find((c: any) => c.type === 'text')?.text;
  if (r.isError) throw new Error(`${name}: ${txt}`);
  if (slow) await new Promise((res) => setTimeout(res, slow));
  return { json: txt ? JSON.parse(txt) : null, raw: r };
}
const op = (o: string, args: Record<string, unknown>) => ({ op: o, args });

const W = 800, H = 560;
await t('doc_create', { title: 'Gün batımı rozeti', width: W, height: H });
await t('frame_update', { id: (await t('doc_info')).json.pages[0].frames[0].id, background: '#0f1226' });
const bg = (await t('layer_create', { name: 'Gökyüzü' })).json.result.id;
const mid = (await t('layer_create', { name: 'Dağlar' })).json.result.id;
const fg = (await t('layer_create', { name: 'Ön plan' })).json.result.id;
const txt = (await t('layer_create', { name: 'Metin' })).json.result.id;

// Gökyüzü: radyal gradyanlı büyük daire rozet + güneş
const sky = await t('batch', {
  label: 'gökyüzü',
  ops: [
    op('node_add_ellipse', {
      parentId: bg, name: 'Rozet', x: 160, y: 40, width: 480, height: 480,
      style: { fill: { type: 'linear', x1: 0, y1: 40, x2: 0, y2: 520, stops: [{ offset: 0, color: '#1b1f5e' }, { offset: 0.55, color: '#c2408f' }, { offset: 1, color: '#ff9f5a' }] }, stroke: '#fbe3c4', strokeWidth: 6 },
    }),
    op('node_add_ellipse', {
      parentId: bg, name: 'Güneş', x: 330, y: 250, width: 140, height: 140,
      style: { fill: { type: 'radial', cx: 400, cy: 320, r: 70, stops: [{ offset: 0, color: '#fff6d8' }, { offset: 0.6, color: '#ffd166' }, { offset: 1, color: '#ff8c42' }] }, filters: [{ type: 'drop-shadow', dx: 0, dy: 0, blur: 30, color: '#ffb35c' }] },
    }),
  ],
});
const rozet = sky.json.results[0].id;

// Yıldızlar: bir yıldızı path olarak çiz, çoğalt, dağıt
const starD = (cx: number, cy: number, r: number) => {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (Math.PI / 5) * i - Math.PI / 2, rr = i % 2 ? r * 0.42 : r;
    return `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
  });
  return `M${pts.join(' L')} Z`;
};
await t('batch', {
  label: 'yıldızlar',
  ops: [[300, 120, 7], [360, 95, 4], [455, 110, 6], [520, 150, 4], [270, 180, 3.5], [420, 160, 3], [500, 90, 3]].map(([x, y, r], i) =>
    op('node_add_path', { parentId: bg, name: `Yıldız ${i + 1}`, d: starD(x, y, r), style: { fill: '#fff4d6', opacity: 0.9 } })),
});

// Dağlar: iki sıra, sonra rozet dairesiyle KESİŞİM (boolean_intersect) ile rozete kırp
const back = (await t('node_add_path', { parentId: mid, name: 'Arka dağlar', d: 'M140 420 L250 300 L320 360 L410 250 L500 350 L560 310 L680 430 L680 560 L140 560 Z', style: { fill: '#4a2c6f' } })).json.result.id;
const front = (await t('node_add_path', { parentId: mid, name: 'Ön dağlar', d: 'M140 470 C220 400 280 380 340 430 C390 470 430 390 500 380 C560 372 610 430 680 460 L680 560 L140 560 Z', style: { fill: '#2a1846' } })).json.result.id;
const clip1 = (await t('duplicate', { ids: [rozet] })).json.result[0].id;
await t('layer_move_node', { ids: [clip1], layerId: mid });
await t('boolean_intersect', { ids: [back, clip1] });
const clip2 = (await t('duplicate', { ids: [rozet] })).json.result[0].id;
await t('layer_move_node', { ids: [clip2], layerId: mid });
await t('boolean_intersect', { ids: [front, clip2] });

// Göl yansıması: iki elipsin XOR'u
await t('batch', {
  label: 'göl',
  ops: [op('node_add_ellipse', { parentId: fg, name: 'Göl', x: 300, y: 470, width: 200, height: 26, style: { fill: '#ffb36b', opacity: 0.35 } })],
});

// Kurdele: path + kontur → dolgu
const ribbon = (await t('node_add_path', {
  parentId: fg, name: 'Kurdele', d: 'M120 440 L200 455 Q400 500 600 455 L680 440 L660 480 L680 520 L590 505 Q400 545 210 505 L120 520 L140 480 Z',
  style: { fill: { type: 'linear', x1: 120, y1: 0, x2: 680, y2: 0, stops: [{ offset: 0, color: '#b3122d' }, { offset: 0.5, color: '#e63946' }, { offset: 1, color: '#b3122d' }] }, stroke: '#7a0c1f', strokeWidth: 3, strokeLinejoin: 'round' },
})).json.result.id;

await t('node_add_text', { parentId: txt, name: 'Başlık', x: 400, y: 498, content: 'MASVECTOR', fontSize: 34, fontWeight: 'bold', textAnchor: 'middle', style: { fill: '#fff6e8' } });
await t('node_add_text', { parentId: txt, name: 'Alt başlık', x: 400, y: 30, content: 'ajant tarafından MCP ile çizildi', fontSize: 16, textAnchor: 'middle', style: { fill: '#9aa3d9' } });
await t('align_to', { ids: [ribbon], align: 'hcenter', to: 'frame' });

const prev = await t('render_preview', { maxSize: 800 });
const img = prev.raw.content.find((c: any) => c.type === 'image');
const out = process.env.DEMO_OUT;
if (out) writeFileSync(out, Buffer.from(img.data, 'base64'));
await t('doc_save', { path: 'demo.json' });
await t('doc_export', { format: 'svg', path: 'demo.svg' });
await t('doc_export', { format: 'pdf', path: 'demo.pdf' });
console.log(JSON.stringify((await t('doc_info')).json.history));
await client.close();
