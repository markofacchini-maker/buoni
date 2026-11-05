"""Genera le icone dell'app e un PDF di prova con codici finti.

Uso: python tests/make_assets.py (dalla cartella buoni-app)
"""
from pathlib import Path

import fitz
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ACCENT = (20, 68, 63)
WHITE = (255, 255, 255)


def draw_icon(size, content_ratio):
    img = Image.new("RGB", (size, size), ACCENT)
    draw = ImageDraw.Draw(img)
    # Sequenza di barre, simbolo generico di un codice a barre.
    widths = [2, 1, 1, 3, 1, 2, 1, 1, 2, 3, 1, 2]
    gaps = [1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 0]
    total = sum(widths) + sum(gaps)
    span = size * content_ratio
    unit = span / total
    x = (size - span) / 2
    top = size * (1 - content_ratio * 0.8) / 2
    bottom = size - top
    for w, g in zip(widths, gaps):
        draw.rectangle([x, top, x + w * unit - 1, bottom], fill=WHITE)
        x += (w + g) * unit
    return img


def make_icons():
    out = ROOT / "icons"
    out.mkdir(exist_ok=True)
    draw_icon(192, 0.62).save(out / "icon-192.png")
    draw_icon(512, 0.62).save(out / "icon-512.png")
    draw_icon(512, 0.46).save(out / "icon-maskable-512.png")


def make_fixtures():
    out = ROOT / "tests" / "fixtures"
    out.mkdir(parents=True, exist_ok=True)
    euro = "\u20ac"
    fontfile = "C:/Windows/Fonts/arial.ttf"

    def build(path, rows):
        doc = fitz.open()
        for code, value, expiry in rows:
            page = doc.new_page(width=612, height=792)
            lines = [
                ((43, 255), "SCADENZA NOME COGNOME VALORE"),
                ((130, 275), f"{euro} {value}"),
                ((230, 275), expiry),
                ((150, 300), "BARCODE"),
                ((128, 335), code),
                ((420, 300), "CODICE"),
                ((400, 320), code),
            ]
            for pos, text in lines:
                page.insert_text(pos, text, fontsize=9, fontname="arial", fontfile=fontfile)
        doc.save(path)
        doc.close()

    # Codici finti: non corrispondono a buoni reali.
    build(out / "prova-a.pdf", [
        ("99000000000001", 10, "30/11/2027"),
        ("99000000000002", 10, "31/01/2027"),
        ("99000000000003", 25, "30/11/2027"),
    ])
    # Contiene un duplicato di prova-a e un buono nuovo.
    build(out / "prova-b.pdf", [
        ("99000000000001", 10, "30/11/2027"),
        ("99000000000004", 10, "30/11/2027"),
    ])


if __name__ == "__main__":
    make_icons()
    make_fixtures()
    print("Icone e PDF di prova generati.")
