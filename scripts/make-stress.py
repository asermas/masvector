# Vektörleştirme stres korpusu: gerçek dünyada karşılaşılan zor girdiler (Pillow + numpy).
# Kullanım: python scripts/make-stress.py [.lab/stress]
import io, math, os, sys, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else '.lab/stress'
os.makedirs(out, exist_ok=True)
rng = random.Random(7)
nrng = np.random.default_rng(7)
SS = 4  # süper örnekleme: kenarlar gerçek görsellerdeki gibi yumuşatılmış olsun


def font(size):
    for f in ('arialbd.ttf', 'arial.ttf', 'segoeui.ttf', 'DejaVuSans-Bold.ttf'):
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default()


def canvas(w, h, bg=(255, 255, 255, 255), mode='RGBA'):
    im = Image.new(mode, (w * SS, h * SS), bg)
    return im, ImageDraw.Draw(im)


def down(im, w, h):
    return im.resize((w, h), Image.LANCZOS)


def save(im, name, **kw):
    p = os.path.join(out, name)
    im.save(p, **kw)
    print(name, im.size, im.mode)


def logo(w=512, h=512, bg=(255, 255, 255, 255)):
    im, d = canvas(w, h, bg)
    s = SS
    d.rounded_rectangle([w * s * .078, h * s * .078, w * s * .922, h * s * .922], radius=min(w, h) * s * .117, fill=(25, 51, 115, 255))
    d.ellipse([w * s * .3, h * s * .2, w * s * .7, h * s * .6], fill=(217, 25, 51, 255))
    d.polygon([(w * s * .5, h * s * .62), (w * s * .3, h * s * .85), (w * s * .7, h * s * .85)], fill=(245, 176, 65, 255))
    d.text((w * s * .5, h * s * .92), 'MAS', font=font(int(h * s * .09)), fill=(255, 255, 255, 255), anchor='mm')
    return down(im, w, h)


# 1) Boyut uçları
save(logo(16, 16), 'tiny-16.png')
save(logo(48, 48), 'icon-48.png')
save(Image.new('RGBA', (1, 1), (200, 30, 30, 255)), 'pixel-1x1.png')
save(logo(3000, 3000), 'huge-3000.png')
wide = Image.new('RGBA', (6000, 160), (255, 255, 255, 255)); wd = ImageDraw.Draw(wide)
for i in range(40): wd.ellipse([i * 150 + 10, 20, i * 150 + 130, 140], fill=(rng.randrange(256), rng.randrange(256), rng.randrange(256), 255))
save(wide, 'panorama-6000x160.png')
save(logo(512, 512).rotate(90, expand=True).resize((20, 900)), 'sliver-20x900.png')

# 2) Düz renk, boş, tamamen saydam
save(Image.new('RGBA', (300, 200), (18, 120, 200, 255)), 'solid.png')
save(Image.new('RGBA', (300, 200), (0, 0, 0, 0)), 'transparent.png')
save(Image.new('RGB', (300, 200), (255, 255, 255)), 'white.png')

# 3) İnce çizgiler / tel çizim
im, d = canvas(600, 400)
for i in range(0, 600 * SS, 40 * SS): d.line([(i, 0), (600 * SS - i, 400 * SS)], fill=(0, 0, 0, 255), width=SS)
for r in range(20, 200, 25): d.ellipse([300 * SS - r * SS, 200 * SS - r * SS, 300 * SS + r * SS, 200 * SS + r * SS], outline=(200, 0, 0, 255), width=SS)
save(down(im, 600, 400), 'hairlines.png')
im, d = canvas(800, 600)
for k in range(12):
    pts = [(rng.uniform(0, 800) * SS, rng.uniform(0, 600) * SS) for _ in range(6)]
    d.line(pts, fill=(20, 20, 20, 255), width=rng.choice([1, 2, 3, 6, 10]) * SS, joint='curve')
save(down(im, 800, 600).convert('L'), 'lineart-gray.png')

# 4) Metin
im, d = canvas(900, 500)
y = 10
for sz in (8, 10, 12, 16, 24, 36, 64, 110):
    d.text((20 * SS, y * SS), f'Çizim Testi ğüşıöç {sz}px — AaBbGg 0123', font=font(sz * SS), fill=(10, 10, 10, 255)); y += sz * 1.35 + 6
save(down(im, 900, 500), 'text-sizes.png')

# 5) Gradyanlar
x = np.linspace(0, 1, 640)[None, :, None]; yv = np.linspace(0, 1, 480)[:, None, None]
a = np.array([30, 90, 240]); b = np.array([230, 60, 150])
lin = (a * (1 - x) + b * x) * np.ones((480, 1, 1))
im = Image.fromarray(lin.astype(np.uint8), 'RGB').convert('RGBA'); d = ImageDraw.Draw(im)
d.ellipse([200, 120, 440, 360], fill=(255, 255, 255, 255)); d.rectangle([40, 380, 600, 440], fill=(20, 20, 20, 255))
save(im, 'gradient-linear.png')
rr = np.sqrt((x - .5) ** 2 + (yv - .5) ** 2) / .7071
rad = (np.array([255, 220, 80]) * (1 - rr) + np.array([200, 30, 20]) * rr)
save(Image.fromarray(np.clip(rad, 0, 255).astype(np.uint8), 'RGB'), 'gradient-radial.png')
# bantlaşmış (8 renk basamaklı) gradyan
save(Image.fromarray(((np.floor(lin / 32) * 32)).astype(np.uint8), 'RGB'), 'gradient-banded.png')

# 6) Saydamlık: yarı saydam örtüşme, yumuşak gölge, alfa kenarlı logo
im = Image.new('RGBA', (500, 400), (0, 0, 0, 0)); d = ImageDraw.Draw(im, 'RGBA')
d.ellipse([60, 60, 300, 300], fill=(255, 0, 0, 140)); d.ellipse([200, 60, 440, 300], fill=(0, 0, 255, 140)); d.ellipse([130, 160, 370, 390], fill=(0, 200, 0, 140))
save(im, 'alpha-overlap.png')
sh = Image.new('RGBA', (500, 400), (0, 0, 0, 0)); ImageDraw.Draw(sh).rounded_rectangle([110, 110, 410, 330], 30, fill=(0, 0, 0, 160))
sh = sh.filter(ImageFilter.GaussianBlur(18)); card = Image.new('RGBA', (500, 400), (0, 0, 0, 0)); ImageDraw.Draw(card).rounded_rectangle([90, 80, 390, 300], 30, fill=(255, 255, 255, 255))
save(Image.alpha_composite(sh, card), 'soft-shadow.png')
save(logo(512, 512, bg=(0, 0, 0, 0)), 'logo-transparent.png')

# 7) Kayıp / bozulma: ağır JPEG, bulanık, gürültülü, yeniden örneklenmiş
lg = logo(512, 512).convert('RGB')
for q in (10, 30):
    bio = io.BytesIO(); lg.save(bio, 'JPEG', quality=q); open(os.path.join(out, f'logo-q{q}.jpg'), 'wb').write(bio.getvalue()); print(f'logo-q{q}.jpg')
save(lg.filter(ImageFilter.GaussianBlur(2.5)), 'logo-blur.png')
noisy = np.clip(np.asarray(lg).astype(np.int16) + nrng.normal(0, 18, (512, 512, 3)), 0, 255).astype(np.uint8)
save(Image.fromarray(noisy), 'logo-noise.png')
save(lg.resize((128, 128), Image.BILINEAR).resize((512, 512), Image.BILINEAR), 'logo-upscaled-blurry.png')
# ekran görüntüsü / telefon fotoğrafı benzeri: hafif perspektif + vinyet + JPEG
ph = lg.transform((512, 512), Image.QUAD, (12, 20, 0, 500, 505, 512, 498, 4), Image.BICUBIC, fillcolor=(235, 235, 230))
vig = (1 - 0.25 * (rr[:512, :512, 0] if rr.shape[0] >= 512 else np.resize(rr[:, :, 0], (512, 512))))[:, :, None]
ph = Image.fromarray(np.clip(np.asarray(ph) * vig, 0, 255).astype(np.uint8)); bio = io.BytesIO(); ph.save(bio, 'JPEG', quality=60)
open(os.path.join(out, 'photo-of-logo.jpg'), 'wb').write(bio.getvalue()); print('photo-of-logo.jpg')

# 8) Çok renk / palet / piksel sanatı / patolojik desenler
im, d = canvas(640, 640)
for i in range(8):
    for j in range(8):
        d.rounded_rectangle([(i * 80 + 4) * SS, (j * 80 + 4) * SS, (i * 80 + 76) * SS, (j * 80 + 76) * SS], 14 * SS, fill=(i * 32 + 16, j * 32 + 16, (i * j * 7) % 256, 255))
save(down(im, 640, 640), 'many-colors-64.png')
px = Image.new('RGB', (16, 16)); pp = px.load()
for i in range(16):
    for j in range(16): pp[i, j] = [(0, 0, 0), (255, 214, 0), (230, 50, 40), (255, 255, 255)][(i * 3 + j * 5 + (i * j) % 3) % 4]
save(px.resize((512, 512), Image.NEAREST), 'pixel-art.png')
cb = (np.indices((256, 256)).sum(0) % 2 * 255).astype(np.uint8)
save(Image.fromarray(cb, 'L'), 'checker-1px.png')
save(Image.fromarray((nrng.random((256, 256, 3)) * 255).astype(np.uint8)), 'pure-noise.png')
im, d = canvas(600, 600)
for k, r in enumerate(range(280, 0, -20)): d.ellipse([(300 - r) * SS, (300 - r) * SS, (300 + r) * SS, (300 + r) * SS], fill=(0, 0, 0, 255) if k % 2 == 0 else (255, 255, 255, 255))
save(down(im, 600, 600), 'concentric-rings.png')
im, d = canvas(600, 600, (20, 20, 24, 255))
for k in range(36):
    t = k / 36 * 2 * math.pi; d.polygon([(300 * SS, 300 * SS), ((300 + 280 * math.cos(t)) * SS, (300 + 280 * math.sin(t)) * SS), ((300 + 280 * math.cos(t + .06)) * SS, (300 + 280 * math.sin(t + .06)) * SS)], fill=(255, 200, 0, 255))
save(down(im, 600, 600), 'starburst-spikes.png')

# 9) Biçimler / renk kipleri
lg.save(os.path.join(out, 'fmt.webp'), 'WEBP', quality=80); print('fmt.webp')
lg.save(os.path.join(out, 'fmt-lossless.webp'), 'WEBP', lossless=True); print('fmt-lossless.webp')
lg.convert('P', palette=Image.ADAPTIVE, colors=16).save(os.path.join(out, 'fmt.gif')); print('fmt.gif')
lg.save(os.path.join(out, 'fmt.bmp')); print('fmt.bmp')
lg.save(os.path.join(out, 'fmt.tiff')); print('fmt.tiff')
lg.convert('L').save(os.path.join(out, 'fmt-gray.png')); print('fmt-gray.png')
lg.convert('P', palette=Image.ADAPTIVE, colors=8).save(os.path.join(out, 'fmt-palette.png')); print('fmt-palette.png')
Image.fromarray((np.asarray(lg.convert('L')).astype(np.uint16) * 257)).save(os.path.join(out, 'fmt-16bit.png')); print('fmt-16bit.png')
lg.convert('CMYK').save(os.path.join(out, 'fmt-cmyk.jpg'), quality=92); print('fmt-cmyk.jpg')
ex = lg.rotate(-90, expand=True); exif = Image.Exif(); exif[0x0112] = 6  # 90° döndür etiketi: doğru yön = orijinal logo
ex.save(os.path.join(out, 'fmt-exif-rotated.jpg'), quality=92, exif=exif); print('fmt-exif-rotated.jpg')
lg.convert('1').save(os.path.join(out, 'fmt-1bit.png')); print('fmt-1bit.png')

# 10) Bozuk dosyalar (zarif hata beklenir)
raw = open(os.path.join(out, 'huge-3000.png'), 'rb').read()
open(os.path.join(out, 'bad-truncated.png'), 'wb').write(raw[: len(raw) // 3]); print('bad-truncated.png')
open(os.path.join(out, 'bad-garbage.png'), 'wb').write(bytes(rng.randrange(256) for _ in range(4096))); print('bad-garbage.png')
open(os.path.join(out, 'bad-empty.png'), 'wb').write(b''); print('bad-empty.png')

# 11) Taranmış PDF'ler: eğik tarama, çok sayfa, gri tonlu
scan = lg.rotate(2.2, resample=Image.BICUBIC, fillcolor=(250, 250, 245)).filter(ImageFilter.GaussianBlur(.6))
scan = Image.fromarray(np.clip(np.asarray(scan).astype(np.int16) + nrng.normal(0, 6, (512, 512, 3)), 0, 255).astype(np.uint8))
scan.save(os.path.join(out, 'scan-tilted.pdf'), resolution=150); print('scan-tilted.pdf')
pages = [logo(400, 560).convert('RGB'), Image.open(os.path.join(out, 'text-sizes.png')).convert('RGB'), Image.open(os.path.join(out, 'hairlines.png')).convert('RGB')]
pages[0].save(os.path.join(out, 'scan-multipage.pdf'), save_all=True, append_images=pages[1:], resolution=100); print('scan-multipage.pdf')
