# Test fikstürleri: gerçekçi PDF'ler (pycairo) — vektör + kırpma + gradyan + alfalı görsel + metin, ve taranmış sayfa.
import cairo, math, os, sys
out = sys.argv[1] if len(sys.argv) > 1 else 'tests/fixtures'
os.makedirs(out, exist_ok=True)

# 1) vektör PDF (A5 yatay, pt)
W, H = 595, 420
s = cairo.PDFSurface(os.path.join(out, 'vector.pdf'), W, H)
c = cairo.Context(s)
c.set_source_rgb(0.97, 0.96, 0.93); c.paint()
# gradyanlı yuvarlak kart
def rrect(x, y, w, h, r):
    c.new_sub_path(); c.arc(x+w-r, y+r, r, -math.pi/2, 0); c.arc(x+w-r, y+h-r, r, 0, math.pi/2)
    c.arc(x+r, y+h-r, r, math.pi/2, math.pi); c.arc(x+r, y+r, r, math.pi, 3*math.pi/2); c.close_path()
g = cairo.LinearGradient(40, 40, 300, 240); g.add_color_stop_rgb(0, 0.12, 0.35, 0.95); g.add_color_stop_rgb(1, 0.55, 0.2, 0.85)
rrect(40, 40, 260, 200, 24); c.set_source(g); c.fill()
# kırpılmış daireler (clip)
c.save(); rrect(40, 40, 260, 200, 24); c.clip()
for i, (x, y, r) in enumerate([(280, 60, 90), (60, 230, 70)]):
    c.arc(x, y, r, 0, 2*math.pi); c.set_source_rgba(1, 1, 1, 0.18); c.fill()
c.restore()
# yıldız (evenodd)
c.set_fill_rule(cairo.FILL_RULE_EVEN_ODD)
cx, cy, R = 450, 120, 70
for i in range(5):
    a = -math.pi/2 + i*4*math.pi/5
    (c.move_to if i == 0 else c.line_to)(cx + R*math.cos(a), cy + R*math.sin(a))
c.close_path(); c.set_source_rgb(0.98, 0.72, 0.1); c.fill_preserve(); c.set_source_rgb(0.5, 0.3, 0); c.set_line_width(3); c.set_line_join(cairo.LINE_JOIN_ROUND); c.stroke()
c.set_fill_rule(cairo.FILL_RULE_WINDING)
# kesikli eğri
c.move_to(340, 330); c.curve_to(390, 250, 470, 400, 550, 300); c.set_source_rgb(0.1, 0.55, 0.35); c.set_line_width(5); c.set_dash([12, 6]); c.set_line_cap(cairo.LINE_CAP_ROUND); c.stroke(); c.set_dash([])
# radyal gradyanlı küre
rg = cairo.RadialGradient(130, 320, 5, 150, 340, 60); rg.add_color_stop_rgb(0, 1, 1, 1); rg.add_color_stop_rgb(1, 0.85, 0.2, 0.25)
c.arc(150, 340, 55, 0, 2*math.pi); c.set_source(rg); c.fill()
# metin (Türkçe)
c.select_font_face('DejaVu Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD); c.set_font_size(28)
c.set_source_rgb(1, 1, 1); c.move_to(62, 140); c.show_text('Şığ Görünüm')
c.select_font_face('DejaVu Serif', cairo.FONT_SLANT_ITALIC, cairo.FONT_WEIGHT_NORMAL); c.set_font_size(16)
c.set_source_rgb(0.15, 0.15, 0.2); c.move_to(250, 395); c.show_text('MasVector PDF içe aktarma testi — ğüşiöç')
# alfalı raster görsel
img = cairo.ImageSurface(cairo.FORMAT_ARGB32, 64, 64); ic = cairo.Context(img)
for yy in range(8):
    for xx in range(8):
        ic.set_source_rgba(xx/7, yy/7, 0.6, 0.35 + 0.65*((xx+yy) % 2)); ic.rectangle(xx*8, yy*8, 8, 8); ic.fill()
c.save(); c.translate(250, 270); c.scale(1.2, 1.2); c.set_source_surface(img, 0, 0); c.paint(); c.restore()
s.finish()

# 2) taranmış sayfa: tek raster görsel (logo gibi düz renkli çizim, JPEG-benzeri gürültü yok)
R = 3  # 3x çözünürlük
sc = cairo.ImageSurface(cairo.FORMAT_RGB24, 600*R, 400*R); k = cairo.Context(sc); k.scale(R, R)
k.set_source_rgb(1, 1, 1); k.paint()
k.set_source_rgb(0.85, 0.1, 0.2); k.arc(160, 200, 110, 0, 2*math.pi); k.fill()
k.set_source_rgb(1, 1, 1); k.arc(160, 200, 60, 0, 2*math.pi); k.fill()
k.set_source_rgb(0.1, 0.2, 0.45); k.rectangle(300, 110, 230, 60); k.fill()
k.move_to(300, 330); k.line_to(415, 190); k.line_to(530, 330); k.close_path(); k.set_source_rgb(0.95, 0.65, 0.1); k.fill()
k.select_font_face('DejaVu Sans', 0, 1); k.set_font_size(34); k.set_source_rgb(0.1, 0.2, 0.45); k.move_to(300, 380); k.show_text('LOGO A.Ş.')
sc.write_to_png(os.path.join(out, 'logo.png'))
ps = cairo.PDFSurface(os.path.join(out, 'scanned.pdf'), 600, 400); pc = cairo.Context(ps)
pc.scale(1/R, 1/R); pc.set_source_surface(sc, 0, 0); pc.paint(); ps.finish()
print('ok')
