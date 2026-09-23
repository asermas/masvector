import type { OpName } from '../../model/schemas.js';

export const AGENT_GUIDE = `# MasVector — ajant çizim rehberi

Koordinat sistemi: frame uzayı, (0,0) sol-üst, x sağa, y AŞAĞI. Birim = px. doc_info frame boyutunu verir.
Belge: pages → frames → nodes. Katmanlar frame'in en üstündeki gruplardır; parentId verilmezse en üstteki açık katmana eklenir.

İyi iş akışı:
1. doc_info → tuval boyutu, katmanlar.
2. Katmanları kur (layer_create: "Arka plan", "Şekiller", "Metin").
3. İlgili adımları **batch** ile tek atomik adımda çiz (tek undo adımı, yarım kalmış çizim olmaz).
4. render_preview (grid=50 ile koordinatları gör) → hataları düzelt → tekrar önizle.
5. doc_save / doc_export.

PDF/görsel → vektör:
- pdf_import (vektör PDF'ler birebir; taranmışlar izlenir) veya vectorize_image (PNG/JPEG...). Rapordaki fidelity.pctOff'a bakın.
- compare_reference fark haritasını gösterir; kırmızı bölgeler varsa: daha çok ayrıntı (detail↑), renk (colors/palette), ya da elle düzeltme (node_edit_handles, path_simplify).
- Kurumsal renkler biliniyorsa palette ile verin: renkler birebir o değerlerde olur.

İpuçları:
- Organik şekiller için node_add_path + SVG "d" (C/Q/A komutları) kullanın; sonra node_edit_handles ile ince ayar.
- Delikli/karmaşık siluetler: basit şekiller + boolean_union/subtract/intersect/exclude (sonuç tek path).
- Kontur→dolgu: path_outline_stroke; içe/dışa kalınlaştırma: path_offset.
- Gradyan koordinatları node-yerel uzaydadır: {"type":"linear","x1":0,"y1":0,"x2":0,"y2":100,"stops":[{"offset":0,"color":"#..."},{"offset":1,"color":"#..."}]}.
- Hizalama: align_to (selection/frame/node/guide), distribute; hassasiyet: snap_to_grid, add_guide.
- Dönüşümler (rotate/scale/skew) varsayılan olarak her node'un kendi bbox merkezi etrafında olur; origin ile değiştirin.
- Çok ajanlı çalışmada: uzun işlerde lock_acquire/lock_release; expectedVersion ile iyimser kontrol. LOCKED alırsanız bekleyip tekrar deneyin.
- Metin boolean'a girmez. Açık yollar (line) boolean'a girmeden önce path_outline_stroke ile dolguya çevrilmeli.
`;

const S = 'Ortak: name, style{fill,stroke,strokeWidth,opacity,...}, transform (matris veya SVG metni), parentId (katman/grup/frame), index (z-sırası).';

export const OP_DESCRIPTIONS: Record<OpName, string> = {
  node_add_path: `Bézier path ekle. "d" = SVG path verisi (M,L,H,V,C,S,Q,T,A,Z; göreli/mutlak) ya da subpaths=[{closed,points:[{x,y,in:{dx,dy},out:{dx,dy}}]}]. fillRule nonzero|evenodd. Açık yollar varsayılan konturlu. ${S}`,
  node_add_rect: `Dikdörtgen ekle (x,y sol-üst; rx/ry köşe yuvarlaklığı). ${S}`,
  node_add_ellipse: `Elips ekle — sınır kutusu x,y,width,height ile (daire: width=height). ${S}`,
  node_add_line: `Doğru parçası ekle (x1,y1)→(x2,y2); varsayılan siyah kontur. ${S}`,
  node_add_text: `Metin ekle. (x,y) = taban çizgisi noktası; textAnchor start|middle|end. ${S}`,
  node_update: 'Node geometrisini güncelle (props: rect x/y/width/height/rx/ry, ellipse x/y/width/height, line x1..y2, text content/fontSize/fontFamily/fontWeight/textAnchor/x/y, path d/subpaths/fillRule; hepsi için name/visible/locked).',
  node_delete: 'Node(ları) sil (gruplar alt ağacıyla).',
  node_move: 'Frame uzayında taşı: dx,dy göreli ya da to={x,y} seçimin sol-üstünü mutlak konuma.',
  node_transform: 'Dönüşüm uygula: rotate (derece, saat yönü), scale (sayı veya {x,y}), skew {x,y}, translate, ya da ham matrix. Varsayılan merkez her node\'un bbox merkezi; origin="origin" veya {x,y}. mode="set" yerel matrisi değiştirir.',
  node_set_style: 'Stil ata (kısmi): fill/stroke (renk veya gradyan), strokeWidth, strokeLinecap, strokeLinejoin, strokeDasharray, opacity, fillOpacity, strokeOpacity, blendMode, filters [{type:"blur",radius}|{type:"drop-shadow",dx,dy,blur,color}]. Grupta dolgu/kontur çocuklara iner.',
  node_edit_handles: 'Path çapa/handle düzenle (yerel koordinat). edits: move(x,y) | set(x,y,in,out; null=sil) | insert(index+t: segmenti eğriyi bozmadan böl; ya da x,y ile index önüne nokta) | delete | close | open | smooth (teğet handle üret) | corner (handle sil). subpath varsayılan 0.',
  node_reorder: 'Z-sırası: front, back, forward, backward veya kardeşler arasında indeks.',
  node_to_path: 'rect/ellipse/line\'ı düzenlenebilir path\'e çevir (id korunur).',
  boolean_union: 'Birleşim → tek path (operandlar silinir; keepOriginals ile kalır). Gruplar ve dönüşmüş node\'lar desteklenir. Stil ilk operanddan.',
  boolean_subtract: 'Fark: ilk id − diğerleri → tek path.',
  boolean_intersect: 'Kesişim: hepsinin ortak alanı → tek path. Örtüşme yoksa hata (belge değişmez).',
  boolean_exclude: 'XOR: örtüşmeyen alanlar → tek path.',
  path_offset: 'Kapalı şekli delta kadar dışa (+) / içe (−) ofsetle; join miter|round|square. Yeni path üretir (keepOriginal=false ile orijinali değiştirir).',
  path_outline_stroke: 'Konturu dolgu path\'ine çevir (kalınlık, uç ve birleşim tipi korunur).',
  group: 'Node\'ları gruplandır (görsel konum korunur; grup ilk node\'un kapsayıcısına girer).',
  ungroup: 'Grubu çöz; çocuklar grubun yerine, dönüşümü devralarak geçer.',
  duplicate: 'Kopyala (yeni id\'ler), isteğe bağlı dx,dy kaydırma. Kopya orijinalin hemen üstüne gelir.',
  layer_create: 'Frame\'e katman ekle (index yoksa en üste). Yeni node\'lar parentId verilmezse en üstteki açık+kilitsiz katmana gider.',
  layer_move_node: 'Node\'ları başka katmana/gruba taşı (görsel konum korunur).',
  layer_toggle: 'Katman/node görünürlüğünü değiştir (visible verilmezse tersle).',
  layer_lock: 'Katman/node kilidini değiştir (kilitli node ve çocukları düzenlenemez).',
  frame_create: 'Sayfaya yeni frame (artboard) ekle; x,y sayfa koordinatı.',
  frame_update: 'Frame adı/konum/boyut/arka plan rengini değiştir (background: renk veya "none").',
  snap_to_grid: 'Izgaraya yasla: mode=position (bbox sol-üst) veya points (her çapa/köşe). size verilirse sayfa ızgarası güncellenir.',
  add_guide: 'Kılavuz çizgisi ekle (axis x = dikey çizgi x=value; y = yatay). align_to to="guide:<id>" ile kullanılır.',
  remove_guide: 'Kılavuzu sil.',
  align_to: 'Hizala: left|hcenter|right|top|vcenter|bottom; to = "selection" (varsayılan), "frame", bir node id (o sabit kalır) veya "guide:<id>".',
  node_add_image: `Raster görsel ekle (data URI). ${S}`,
  clip_create: 'Kırpma maskesi oluştur: maske şekli (varsayılan seçimin en üstündeki) diğer node\'ları kırpar; sonuç maske taşıyan grup.',
  clip_release: 'Kırpma maskesini çöz: maske ince gri konturlu path olarak gruba geri eklenir.',
  path_simplify: 'Çapa sayısını azalt: path\'i yeniden uydurarak (köşeler korunur) daha az, düzgün Bézier çapasıyla yeniden yaz. İzleme/PDF içe aktarma sonrası temizlik için.',
  distribute: 'En az 3 node\'u x veya y ekseninde eşit aralıkla dağıt (uçtakiler sabit).',
};
