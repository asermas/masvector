/** CSS renk metnini [r,g,b,a] (0..1) olarak çöz. Tanınmazsa null. */
const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080',
  grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', navy: '#000080', purple: '#800080',
  teal: '#008080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', crimson: '#dc143c', khaki: '#f0e68c',
  beige: '#f5f5dc', ivory: '#fffff0', lavender: '#e6e6fa', turquoise: '#40e0d0', tan: '#d2b48c', chocolate: '#d2691e',
  darkgray: '#a9a9a9', lightgray: '#d3d3d3', darkblue: '#00008b', darkgreen: '#006400', darkred: '#8b0000',
  skyblue: '#87ceeb', steelblue: '#4682b4', slategray: '#708090', forestgreen: '#228b22', seagreen: '#2e8b57',
  dodgerblue: '#1e90ff', royalblue: '#4169e1', orchid: '#da70d6', plum: '#dda0dd', sienna: '#a0522d', peru: '#cd853f',
  transparent: 'rgba(0,0,0,0)',
};

export function parseColor(input: string): [number, number, number, number] | null {
  let c = input.trim().toLowerCase();
  if (NAMED[c]) c = NAMED[c];
  let m = /^#([0-9a-f]{3,8})$/.exec(c);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [v(0), v(2), v(4), h.length === 8 ? v(6) : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (s: string) => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s) / 255);
    const a = p[3] !== undefined ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
    return [ch(p[0]), ch(p[1]), ch(p[2]), a];
  }
  m = /^hsla?\(([^)]+)\)$/.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const h = ((parseFloat(p[0]) % 360) + 360) % 360 / 360, s = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
    const a = p[3] !== undefined ? parseFloat(p[3]) : 1;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, pp = 2 * l - q;
    const f = (t: number) => {
      t = (t + 1) % 1;
      return t < 1 / 6 ? pp + (q - pp) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3), a];
  }
  return null;
}
