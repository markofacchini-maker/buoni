"""Blocca la pubblicazione se i file del repository contengono dati personali o codici.

Uso: python tests/check_publish.py "percorso/file.pdf" [altri PDF]
Stampa solo il nome del file e il tipo di problema, mai il codice trovato.
"""
import re
import subprocess
import sys
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
CODE_RE = re.compile(r"(?<![0-9])[0-9]{14}(?![0-9])")
FAKE_PREFIX = "99000000000"
PERSONAL = ["facchini", "marko.facchini", "marcofacchini"]


def real_codes(paths):
    codes = set()
    for path in paths:
        with fitz.open(path) as doc:
            for page in doc:
                codes.update(CODE_RE.findall(page.get_text()))
    return codes


def repo_files():
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return [ROOT / line for line in out.splitlines() if line]


def main():
    codes = real_codes(sys.argv[1:])
    if not codes:
        print("Nessun codice letto dai PDF: controllo non valido.")
        return 1
    problems = []
    files = repo_files()
    for path in files:
        relative = path.relative_to(ROOT).as_posix()
        data = path.read_bytes()
        text = data.decode("utf-8", errors="ignore")
        lowered = text.lower()
        if relative.lower().endswith(".pdf"):
            problems.append((relative, "file PDF"))
        if any(code in text for code in codes):
            problems.append((relative, "codice reale"))
        if any(term in lowered for term in PERSONAL) and relative != "tests/check_publish.py":
            problems.append((relative, "dato personale"))
        if not relative.startswith("vendor/"):
            found = [c for c in CODE_RE.findall(text) if not c.startswith(FAKE_PREFIX)]
            if found:
                problems.append((relative, "sequenza di 14 cifre"))
    print(f"File controllati: {len(files)}. Codici reali confrontati: {len(codes)}.")
    for relative, kind in problems:
        print(f"PROBLEMA: {relative}: {kind}")
    print("ESITO: BLOCCATO" if problems else "ESITO: OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
