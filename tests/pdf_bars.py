"""Scrive su stdout, per ogni pagina, codice e sequenza di moduli del barcode vettoriale.

Da usare solo in pipe verso verify_barcode.mjs, che non stampa i codici.
Uso: python tests/pdf_bars.py "percorso/file.pdf" | node tests/verify_barcode.mjs
"""
import json
import re
import sys

import fitz

CODE_RE = re.compile(r"(?<![0-9])[0-9]{14}(?![0-9])")


def page_bars(page):
    bars = []
    for drawing in page.get_drawings():
        fill = drawing.get("fill")
        rect = drawing["rect"]
        if fill is None or max(fill) > 0.05:
            continue
        # Barre verticali nere: strette e alte.
        if rect.height > 20 and rect.width < 10:
            bars.append((rect.x0, rect.x1))
    return sorted(bars)


def to_modules(bars):
    """Converte le barre in una stringa 1/0, ricavando la larghezza del modulo."""
    span = bars[-1][1] - bars[0][0]
    # Code 128: la lunghezza totale è 11 moduli per simbolo più 2 per lo stop.
    symbols = (len(bars) - 1) // 3
    total_modules = symbols * 11 + 2
    module = span / total_modules
    out = []
    cursor = bars[0][0]
    max_error = 0.0
    for x0, x1 in bars:
        gap = (x0 - cursor) / module
        width = (x1 - x0) / module
        max_error = max(max_error, abs(gap - round(gap)), abs(width - round(width)))
        out.append("0" * round(gap))
        out.append("1" * round(width))
        cursor = x1
    return "".join(out), max_error


def main():
    doc = fitz.open(sys.argv[1])
    rows = []
    for page in doc:
        codes = CODE_RE.findall(page.get_text())
        modules, max_error = to_modules(page_bars(page))
        rows.append({"code": codes[0], "modules": modules, "maxError": round(max_error, 3)})
    json.dump(rows, sys.stdout)


if __name__ == "__main__":
    main()
