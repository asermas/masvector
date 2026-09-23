import type { Matrix, Style } from './types.js';

let counter = 0;
/** Kısa, çakışmasız, okunabilir id: `rect_k3f9a_1`. */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}_${counter}`;
}

export const IDENTITY: Readonly<Matrix> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function defaultStyle(overrides: Partial<Style> = {}): Style {
  return {
    fill: '#000000',
    stroke: 'none',
    strokeWidth: 1,
    opacity: 1,
    blendMode: 'normal',
    filters: [],
    ...overrides,
  };
}

export const DEFAULT_PORT = 7878;
export const DOC_FILENAME = 'masvector.document.json';
