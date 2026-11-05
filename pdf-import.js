// Estrae i buoni da un PDF, pagina per pagina. Il file non lascia il dispositivo.

const CODE_RE = /(?<![0-9])[0-9]{14}(?![0-9])/g;
const VALUE_RE = /€\s*([0-9]+(?:[.,][0-9]{1,2})?)/;
const DATE_RE = /(?<![0-9])([0-9]{2})\/([0-9]{2})\/([0-9]{4})(?![0-9])/;

function toCents(text) {
  const [whole, decimals = ''] = text.replace(',', '.').split('.');
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
}

function toIsoDate(day, month, year) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const valid = date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
  return valid ? `${year}-${month}-${day}` : null;
}

// Interpreta il testo di una pagina. kind: voucher, blank (pagina senza buono), error.
export function parsePageText(text) {
  const codes = text.match(CODE_RE) || [];
  const looksLikeVoucher = /BARCODE|CODICE/.test(text);
  if (codes.length === 0) {
    return looksLikeVoucher
      ? { kind: 'error', reason: 'codice non trovato' }
      : { kind: 'blank' };
  }
  const unique = new Set(codes);
  if (unique.size !== 1) return { kind: 'error', reason: 'più codici diversi nella stessa pagina' };

  const valueMatch = text.match(VALUE_RE);
  if (!valueMatch) return { kind: 'error', reason: 'valore non trovato' };
  const valueCents = toCents(valueMatch[1]);
  if (!(valueCents > 0)) return { kind: 'error', reason: 'valore non valido' };

  const dateMatch = text.match(DATE_RE);
  const expiry = dateMatch && toIsoDate(dateMatch[1], dateMatch[2], dateMatch[3]);
  if (!expiry) return { kind: 'error', reason: 'scadenza non trovata' };

  return {
    kind: 'voucher',
    voucher: { code: codes[0], valueCents, expiry },
    codeOccurrences: codes.length,
  };
}

export async function extractPageTexts(data, pdfjs) {
  const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const texts = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    texts.push(content.items.map((item) => (item.hasEOL ? `${item.str}\n` : item.str)).join(' '));
    page.cleanup();
  }
  await loadingTask.destroy();
  return texts;
}

// Risultato: voucher unici nel file, numero di pagine, errori con numero di pagina.
export async function extractVouchers(data, pdfjs) {
  const texts = await extractPageTexts(data, pdfjs);
  const vouchers = [];
  const errors = [];
  const seen = new Set();
  let blank = 0;
  let repeated = 0;
  texts.forEach((text, index) => {
    const parsed = parsePageText(text);
    if (parsed.kind === 'blank') {
      blank += 1;
    } else if (parsed.kind === 'error') {
      errors.push({ page: index + 1, reason: parsed.reason });
    } else if (seen.has(parsed.voucher.code)) {
      repeated += 1;
    } else {
      seen.add(parsed.voucher.code);
      vouchers.push(parsed.voucher);
    }
  });
  return { pages: texts.length, vouchers, errors, blank, repeated };
}
