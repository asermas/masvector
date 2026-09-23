// Bağımlılıksız, SVG için yeterli küçük XML ayrıştırıcı (etiketler, öznitelikler, metin, CDATA, yorum, PI, DOCTYPE).

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

export function parseXml(src: string): XmlElement {
  let i = 0;
  const root: XmlElement = { name: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  const fail = (msg: string) => { throw new Error(`XML hatası (konum ${i}): ${msg}`); };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); if (e < 0) fail('kapanmamış yorum'); i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i); if (e < 0) fail('kapanmamış CDATA');
      top().children.push(src.slice(i + 9, e)); i = e + 3; continue;
    }
    if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i); if (e < 0) fail('kapanmamış PI'); i = e + 2; continue; }
    if (src.startsWith('<!', i)) {
      // DOCTYPE (iç altküme köşeli parantezlerini atla)
      let depth = 0, j = i + 2;
      for (; j < src.length; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        else if (src[j] === '>' && depth <= 0) break;
      }
      i = j + 1; continue;
    }
    if (src[i + 1] === '/') {
      const e = src.indexOf('>', i);
      const name = src.slice(i + 2, e).trim();
      if (top().name !== name) fail(`beklenmeyen kapanış </${name}> (açık: <${top().name}>)`);
      stack.pop(); i = e + 1; continue;
    }
    // açılış etiketi
    const m = /^<([A-Za-z_][\w:.-]*)/.exec(src.slice(i, i + 256));
    if (!m) fail('geçersiz etiket');
    const el: XmlElement = { name: m![1], attrs: {}, children: [] };
    i += m![0].length;
    const attrRe = /\s*([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
    for (;;) {
      attrRe.lastIndex = i;
      const am = attrRe.exec(src);
      if (!am) break;
      el.attrs[am[1]] = decodeEntities(am[3] ?? am[4] ?? '');
      i = attrRe.lastIndex;
    }
    while (/\s/.test(src[i] ?? '')) i++;
    top().children.push(el);
    if (src.startsWith('/>', i)) { i += 2; }
    else if (src[i] === '>') { i++; stack.push(el); }
    else fail(`<${el.name}> etiketi düzgün kapanmıyor`);
  }
  if (stack.length > 1) throw new Error(`XML hatası: kapanmamış <${top().name}>`);
  const docEl = root.children.find((c): c is XmlElement => typeof c !== 'string');
  if (!docEl) throw new Error('XML hatası: kök eleman yok');
  return docEl;

  function pushText(t: string) { if (t.trim()) top().children.push(decodeEntities(t)); }
}

export const textContent = (el: XmlElement): string =>
  el.children.map((c) => (typeof c === 'string' ? c : textContent(c))).join('');
