// Confronta il barcode generato dalla libreria dell'app con quello del PDF.
// Legge da stdin l'output di pdf_bars.py. Stampa solo conteggi, mai i codici.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'vendor/JsBarcode.code128.min.js'), 'utf8');
const sandbox = { window: {}, document: undefined };
sandbox.self = sandbox.window;
vm.runInNewContext(source, sandbox);
const JsBarcode = sandbox.window.JsBarcode || sandbox.JsBarcode;

let input = '';
for await (const chunk of process.stdin) input += chunk;
const rows = JSON.parse(input);

let same = 0;
let worstError = 0;
for (const row of rows) {
  const encoded = {};
  JsBarcode(encoded, row.code, { format: 'CODE128' });
  const generated = encoded.encodings[0].data;
  if (generated === row.modules) same += 1;
  worstError = Math.max(worstError, row.maxError);
}

console.log('barcode confrontati:', rows.length);
console.log('identici:', same);
console.log('moduli per barcode (PDF):', [...new Set(rows.map((r) => r.modules.length))].join(', '));
console.log('errore massimo di allineamento (moduli):', worstError);
const ok = rows.length > 0 && same === rows.length;
console.log(ok ? 'ESITO: OK' : 'ESITO: DIFFERENZE');
process.exit(ok ? 0 : 1);
