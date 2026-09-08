#!/usr/bin/env python3
"""
Generate the images the landing page references but a browser cannot draw:
og.png, apple-touch-icon.png and favicon.ico.

Run by hand, not by CI, and only when the wordmark, the headline or the brand
colours change:

    pip install pillow fonttools brotli
    python packages/viewer/scripts/make-brand-images.py

It draws in the real typeface rather than a stand-in: the shipped
fonts/*.woff2 are decompressed in memory and rendered at the same variable
axes the CSS asks for (Archivo wght 800 / wdth 75 for the wordmark). The
Vietnamese demo line needs the vietnamese subset AND the latin one - neither
covers it alone - so glyphs are drawn one at a time from whichever subset has
them. Same typeface, same axes, so the metrics line up.

favicon.svg is hand-written and lives next to the output; it is not generated.
"""
import io
import os
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "..", "public")
FONTS = os.path.join(PUBLIC, "fonts")

INK = (239, 234, 224)        # #efeae0
BG = (19, 19, 19)            # #131313
AMBER = (224, 164, 58)       # #e0a43a
MUTED = (138, 135, 127)      # #8a877f

HEADLINE = ["What you say,", "on their screen,", "in their language."]
SAID = "Two pushing B main, one’s low"
HEARD = "Hai đứa đẩy B main, một đứa yếu máu"


def ttf(name: str) -> bytes:
    """the shipped woff2, decompressed - FreeType will not read woff2"""
    f = TTFont(os.path.join(FONTS, name))
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    return buf.getvalue()


ARCHIVO_LATIN = ttf("archivo-latin.woff2")
ARCHIVO_VIET = ttf("archivo-vietnamese.woff2")
MARTIAN = ttf("martian-mono-latin.woff2")


def face(data: bytes, size: int, axes):
    f = ImageFont.truetype(io.BytesIO(data), size)
    f.set_variation_by_axes(axes)
    return f


def archivo(size: int, wght=500, wdth=100):
    """(latin, vietnamese) at the same size and axes; callers try latin first"""
    return face(ARCHIVO_LATIN, size, [wght, wdth]), face(ARCHIVO_VIET, size, [wght, wdth])


def martian(size: int, wght=500):
    return face(MARTIAN, size, [wght])


def text(draw, xy, s, pair, fill, tracking=0.0):
    """
    Draw `s` a glyph at a time, from whichever subset carries it.

    Per-glyph because no single shipped subset covers the demo line, and
    because the wordmark's .14em tracking has no equivalent in PIL. Returns
    the x it ended at.
    """
    latin, viet = pair if isinstance(pair, tuple) else (pair, pair)
    have = set(TTFont(io.BytesIO(ARCHIVO_LATIN)).getBestCmap()) if latin is not viet else None
    x, y = xy
    for ch in s:
        f = latin
        if have is not None and ord(ch) not in have:
            f = viet
        draw.text((x, y), ch, font=f, fill=fill)
        x += f.getlength(ch) + tracking
    return x


def wordmark(draw, xy, size, fill=INK):
    """RELAY, at the weight, width and tracking the page sets inline"""
    f = archivo(size, wght=800, wdth=75)
    return text(draw, xy, "RELAY", f, fill, tracking=size * 0.14)


def og():
    """1200x630 - the size every scraper crops to, so nothing is left to chance"""
    im = Image.new("RGB", (1200, 630), BG)
    d = ImageDraw.Draw(im)

    end = wordmark(d, (72, 64), 26)
    d.text((end + 16, 70), "TEXTRELAY.CC", font=martian(14, 500), fill=MUTED)

    # ON AIR, top right, the same amber dot the app shows
    on = "ON AIR"
    f_on = archivo(15, wght=600, wdth=75)[0]
    w = f_on.getlength(on) + 15 * 0.14 * len(on)
    d.ellipse((1128 - w - 20, 71, 1128 - w - 8, 83), fill=AMBER)
    text(d, (1128 - w, 66), on, f_on, AMBER, tracking=15 * 0.14)

    y = 150
    for line in HEADLINE:
        text(d, (72, y), line, archivo(66, wght=500, wdth=100), INK, tracking=-0.9)
        y += 82

    # the caption block, which is the product: what was said, and what a viewer reads
    box = (72, 432, 1128, 566)
    d.rounded_rectangle(box, radius=10, fill=(26, 26, 26), outline=(58, 56, 52))
    text(d, (104, 456), SAID, archivo(26, wght=400, wdth=100), MUTED)
    text(d, (104, 502), HEARD, archivo(30, wght=500, wdth=100), AMBER)

    im.save(os.path.join(PUBLIC, "og.png"), optimize=True)
    return im


def icon(size: int):
    """
    Two caption bars on the app's own black.

    Not the wordmark: RELAY is unreadable at 16px, and a tab icon has to survive
    16px. Two stacked bars - one cream, one amber, the second shorter - is what
    a subtitle looks like at any size, and it says the same thing the product
    does.
    """
    s = size * 8  # drawn large, downsampled - no AA on rectangles otherwise
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BG)
    bar_h = int(s * 0.11)
    r = bar_h // 2
    d.rounded_rectangle((int(s * 0.17), int(s * 0.36), int(s * 0.83), int(s * 0.36) + bar_h), radius=r, fill=INK)
    d.rounded_rectangle((int(s * 0.17), int(s * 0.56), int(s * 0.62), int(s * 0.56) + bar_h), radius=r, fill=AMBER)
    return im.resize((size, size), Image.LANCZOS)


def main():
    og()
    # apple-touch-icon is composited on white by iOS if it has alpha, so flatten
    touch = Image.new("RGB", (180, 180), BG)
    touch.paste(icon(180), (0, 0), icon(180))
    touch.save(os.path.join(PUBLIC, "apple-touch-icon.png"), optimize=True)
    icon(64).save(os.path.join(PUBLIC, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    print("wrote og.png, apple-touch-icon.png, favicon.ico")


if __name__ == "__main__":
    main()
