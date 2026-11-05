// Controlla la lettura di un PDF con lo stesso codice usato dall'app.
// Stampa solo conteggi, mai i codici.
// Uso: node tests/verify_pdf.mjs "percorso/file.pdf" [buoni attesi]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractPageTexts, parsePageText } from '../pdf-import.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdfjs = await import(pathToFileURL(join(root, 'vendor/pdf.min.mjs')).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, 'vendor/pdf.worker.min.mjs')).href;

const [path, expectedArg] = process.argv.slice(2);
const expected = Number(expectedArg || 30);
const data = new Uint8Array(await readFile(path));
const texts = await extractPageTexts(data, pdfjs);

const parsed = texts.map(parsePageText);
const vouchers = parsed.filter((p) => p.kind === 'voucher');
const codes = new Set(vouchers.map((p) => p.voucher.code));
const twoFields = vouchers.filter((p) => p.codeOccurrences === 2).length;
const count = (key) => vouchers.reduce((map, p) => {
  const value = p.voucher[key];
  map[value] = (map[value] || 0) + 1;
  return map;
}, {});

console.log('pagine:', texts.length);
console.log('buoni letti:', vouchers.length);
console.log('codici unici:', codes.size);
console.log('pagine con codice uguale nei due campi:', twoFields);
console.log('errori:', parsed.filter((p) => p.kind === 'error').length);
console.log('valori (centesimi):', count('valueCents'));
console.log('scadenze:', count('expiry'));

const ok = vouchers.length === expected && codes.size === expected && twoFields === expected;
console.log(ok ? 'ESITO: OK' : 'ESITO: DIFFERENZE');
process.exit(ok ? 0 : 1);
