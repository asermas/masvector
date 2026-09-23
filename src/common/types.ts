// MasVector belge modeli: pages → frames → nodes.
// Tüm geometri node'un yerel koordinatındadır; `transform` yerelden ebeveyne taşır.

/** 2D afin matris (SVG/Canvas sırası): x' = a·x + c·y + e, y' = b·x + d·y + f */
export interface Matrix {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export interface GradientStop { offset: number; color: string; opacity?: number }

export interface LinearGradient {
  type: 'linear';
  x1: number; y1: number; x2: number; y2: number;
  stops: GradientStop[];
}

export interface RadialGradient {
  type: 'radial';
  cx: number; cy: number; r: number;
  fx?: number; fy?: number;
  stops: GradientStop[];
}

/** Boya: CSS renk metni ("#ff8800", "rgb(...)", "none") veya gradyan. Koordinatlar node-yerel. */
export type Paint = string | LinearGradient | RadialGradient;

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light' | 'difference' | 'exclusion';

export type Filter =
  | { type: 'blur'; radius: number }
  | { type: 'drop-shadow'; dx: number; dy: number; blur: number; color: string };

export interface Style {
  fill: Paint;
  stroke: Paint;
  strokeWidth: number;
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeLinejoin?: 'miter' | 'round' | 'bevel';
  strokeDasharray?: number[];
  opacity: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  blendMode: BlendMode;
  filters: Filter[];
}

export interface Handle { dx: number; dy: number }

/**
 * Bir çapa noktası. `in` bu noktaya gelen segmentin 2. kontrol noktası,
 * `out` bu noktadan çıkan segmentin 1. kontrol noktası (çapaya göreli).
 * İkisi de yoksa segment düz çizgidir.
 */
export interface PathPoint { x: number; y: number; in?: Handle; out?: Handle }

export interface SubPath { closed: boolean; points: PathPoint[] }

interface NodeBase {
  id: string;
  name?: string;
  transform: Matrix;
  style: Style;
  visible: boolean;
  locked: boolean;
}

export interface PathNode extends NodeBase {
  type: 'path';
  subpaths: SubPath[];
  fillRule: 'nonzero' | 'evenodd';
}
export interface RectNode extends NodeBase {
  type: 'rect';
  x: number; y: number; width: number; height: number; rx?: number; ry?: number;
}
export interface EllipseNode extends NodeBase {
  type: 'ellipse';
  x: number; y: number; width: number; height: number;
}
export interface LineNode extends NodeBase {
  type: 'line';
  x1: number; y1: number; x2: number; y2: number;
}
export interface TextNode extends NodeBase {
  type: 'text';
  x: number; y: number; content: string;
  fontSize: number; fontFamily: string;
  fontWeight?: string;
  textAnchor?: 'start' | 'middle' | 'end';
}
/** Gömülü raster görsel (PDF içindeki fotoğraflar, izleme referansı). `href` = data URI. */
export interface ImageNode extends NodeBase {
  type: 'image';
  x: number; y: number; width: number; height: number;
  href: string;
}
/** Kırpma maskesi: grup-yerel koordinatlarda; yalnız bu alanın içindeki çocuklar görünür. */
export interface ClipMask { subpaths: SubPath[]; rule: 'nonzero' | 'evenodd' }
export interface GroupNode extends NodeBase {
  type: 'group';
  /** Katman = frame'in en üst seviyesindeki `isLayer` grubu. */
  isLayer?: boolean;
  clip?: ClipMask;
  children: VNode[];
}

export type VNode = PathNode | RectNode | EllipseNode | LineNode | TextNode | ImageNode | GroupNode;
export type NodeType = VNode['type'];

export interface Guide { id: string; axis: 'x' | 'y'; value: number }

export interface Frame {
  id: string;
  name: string;
  x: number; y: number; w: number; h: number;
  background?: string;
  nodes: VNode[];
}

export interface Page {
  id: string;
  name: string;
  frames: Frame[];
  guides: Guide[];
  grid: { size: number; enabled: boolean };
}

export interface VDocument {
  id: string;
  title: string;
  /** Her başarılı değişiklikte bir artar (iyimser eşzamanlılık için). */
  version: number;
  pages: Page[];
}

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export type Point = { x: number; y: number };
export type Polygon = Point[];
