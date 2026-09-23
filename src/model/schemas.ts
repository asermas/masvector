import { z } from 'zod';

// Operasyon argüman şemaları — Document Server doğrulaması ve MCP tool girdileri bu tek kaynaktan gelir.

const num = z.number().finite();
const ids = z.array(z.string()).min(1).describe('Hedef node id listesi');

const stop = z.object({ offset: num.min(0).max(1), color: z.string(), opacity: num.min(0).max(1).optional() });
export const paintSchema = z.union([
  z.string().describe('CSS renk ("#1e90ff", "rgb(...)", "none")'),
  z.object({ type: z.literal('linear'), x1: num, y1: num, x2: num, y2: num, stops: z.array(stop).min(1) }),
  z.object({ type: z.literal('radial'), cx: num, cy: num, r: num.positive(), fx: num.optional(), fy: num.optional(), stops: z.array(stop).min(1) }),
]).describe('Boya: renk metni ya da node-yerel koordinatlı linear/radial gradyan');

const blend = z.enum(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion']);
const filter = z.union([
  z.object({ type: z.literal('blur'), radius: num.min(0) }),
  z.object({ type: z.literal('drop-shadow'), dx: num, dy: num, blur: num.min(0), color: z.string() }),
]);

export const styleSchema = z.object({
  fill: paintSchema.optional(),
  stroke: paintSchema.optional(),
  strokeWidth: num.min(0).optional(),
  strokeLinecap: z.enum(['butt', 'round', 'square']).optional(),
  strokeLinejoin: z.enum(['miter', 'round', 'bevel']).optional(),
  strokeDasharray: z.array(num.min(0)).optional(),
  opacity: num.min(0).max(1).optional(),
  fillOpacity: num.min(0).max(1).optional(),
  strokeOpacity: num.min(0).max(1).optional(),
  blendMode: blend.optional(),
  filters: z.array(filter).optional(),
}).describe('Stil (kısmi); verilmeyen alanlar varsayılan/korunur');

export const matrixSchema = z.object({ a: num, b: num, c: num, d: num, e: num, f: num });
const transformIn = z.union([matrixSchema, z.string().describe('SVG transform metni, ör. "rotate(30 50 50)"')]);

const handle = z.object({ dx: num, dy: num });
const pathPoint = z.object({ x: num, y: num, in: handle.optional(), out: handle.optional() });
export const subpathSchema = z.object({ closed: z.boolean(), points: z.array(pathPoint).min(1) });

const common = {
  name: z.string().optional(),
  style: styleSchema.optional(),
  transform: transformIn.optional(),
  parentId: z.string().optional().describe('Frame, katman veya grup id; yoksa aktif katman / ilk frame'),
  index: z.number().int().min(0).optional().describe('Z-sırası (0 = en arka); yoksa en öne'),
};

const origin = z.union([z.enum(['center', 'origin']), z.object({ x: num, y: num })]);

export const OP_SCHEMAS = {
  node_add_path: z.object({
    ...common,
    d: z.string().optional().describe('SVG path verisi (M/L/H/V/C/S/Q/T/A/Z)'),
    subpaths: z.array(subpathSchema).optional().describe('Alternatif: çapa+handle noktaları'),
    fillRule: z.enum(['nonzero', 'evenodd']).optional(),
  }),
  node_add_rect: z.object({ ...common, x: num, y: num, width: num.min(0), height: num.min(0), rx: num.min(0).optional(), ry: num.min(0).optional() }),
  node_add_ellipse: z.object({ ...common, x: num, y: num, width: num.min(0), height: num.min(0) }),
  node_add_line: z.object({ ...common, x1: num, y1: num, x2: num, y2: num }),
  node_add_text: z.object({
    ...common, x: num, y: num, content: z.string(), fontSize: num.positive().optional(), fontFamily: z.string().optional(),
    fontWeight: z.string().optional(), textAnchor: z.enum(['start', 'middle', 'end']).optional(),
  }),
  node_update: z.object({
    id: z.string(),
    props: z.record(z.string(), z.any()).describe('Tipe özgü geometri alanları (x,y,width,height,rx,content,fontSize,d,subpaths,fillRule,name...)'),
  }),
  node_delete: z.object({ ids }),
  node_move: z.object({
    ids,
    dx: num.optional(), dy: num.optional(),
    to: z.object({ x: num, y: num }).optional().describe('Seçimin sol-üst köşesini bu mutlak noktaya taşı'),
  }),
  node_transform: z.object({
    ids,
    matrix: matrixSchema.optional().describe('Ham matris'),
    mode: z.enum(['multiply', 'set']).optional().describe('multiply (varsayılan): mevcut dönüşüme ekle; set: değiştir'),
    translate: z.object({ x: num, y: num }).optional(),
    rotate: num.optional().describe('Derece, saat yönü'),
    scale: z.union([num, z.object({ x: num, y: num })]).optional(),
    skew: z.object({ x: num, y: num }).optional(),
    origin: origin.optional().describe('rotate/scale/skew merkezi; varsayılan her node için bbox merkezi'),
  }),
  node_set_style: z.object({ ids, style: styleSchema }),
  node_edit_handles: z.object({
    id: z.string(),
    edits: z.array(z.object({
      action: z.enum(['move', 'set', 'insert', 'delete', 'close', 'open', 'smooth', 'corner']),
      subpath: z.number().int().min(0).optional(),
      index: z.number().int().min(0).optional(),
      x: num.optional(), y: num.optional(),
      in: handle.nullable().optional(), out: handle.nullable().optional(),
      t: num.min(0).max(1).optional().describe('insert: segment [index→index+1] üzerindeki parametre'),
    })).min(1),
  }),
  node_reorder: z.object({ id: z.string(), to: z.union([z.enum(['front', 'back', 'forward', 'backward']), z.number().int().min(0)]) }),
  node_to_path: z.object({ ids }),
  boolean_union: z.object({ ids: z.array(z.string()).min(2), keepOriginals: z.boolean().optional() }),
  boolean_subtract: z.object({ ids: z.array(z.string()).min(2).describe('İlki gövde, diğerleri çıkarılır'), keepOriginals: z.boolean().optional() }),
  boolean_intersect: z.object({ ids: z.array(z.string()).min(2), keepOriginals: z.boolean().optional() }),
  boolean_exclude: z.object({ ids: z.array(z.string()).min(2), keepOriginals: z.boolean().optional() }),
  path_offset: z.object({ id: z.string(), delta: num, join: z.enum(['miter', 'round', 'square']).optional(), keepOriginal: z.boolean().optional() }),
  path_outline_stroke: z.object({ id: z.string(), keepOriginal: z.boolean().optional() }),
  group: z.object({ ids, name: z.string().optional() }),
  ungroup: z.object({ id: z.string() }),
  duplicate: z.object({ ids, dx: num.optional(), dy: num.optional() }),
  layer_create: z.object({ name: z.string(), frameId: z.string().optional(), index: z.number().int().min(0).optional() }),
  layer_move_node: z.object({ ids, layerId: z.string(), index: z.number().int().min(0).optional() }),
  layer_toggle: z.object({ id: z.string(), visible: z.boolean().optional() }),
  layer_lock: z.object({ id: z.string(), locked: z.boolean().optional() }),
  frame_create: z.object({ name: z.string(), x: num, y: num, w: num.positive(), h: num.positive(), background: z.string().optional(), pageId: z.string().optional() }),
  frame_update: z.object({ id: z.string(), name: z.string().optional(), x: num.optional(), y: num.optional(), w: num.positive().optional(), h: num.positive().optional(), background: z.string().optional() }),
  snap_to_grid: z.object({
    ids: z.array(z.string()).optional().describe('Yoksa tüm düzenlenebilir node\'lar'),
    size: num.positive().optional().describe('Izgara adımı; verilirse sayfa ızgarası da güncellenir'),
    mode: z.enum(['position', 'points']).optional().describe('position: bbox sol-üstünü; points: her çapayı yasla'),
  }),
  add_guide: z.object({ axis: z.enum(['x', 'y']), value: num, pageId: z.string().optional() }),
  remove_guide: z.object({ id: z.string() }),
  align_to: z.object({
    ids,
    align: z.enum(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom']),
    to: z.string().optional().describe('"selection" (varsayılan), "frame", bir node id veya "guide:<id>"'),
  }),
  distribute: z.object({ ids: z.array(z.string()).min(3), axis: z.enum(['x', 'y']) }),
} as const;

export type OpName = keyof typeof OP_SCHEMAS;
export type OpArgs<K extends OpName> = z.infer<(typeof OP_SCHEMAS)[K]>;
export const OP_NAMES = Object.keys(OP_SCHEMAS) as OpName[];
