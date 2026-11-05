import {
  BACKUP_THRESHOLD,
  addVouchers,
  clearBackupReminder,
  deleteVoucher,
  exportBackup,
  getState,
  markAvailable,
  markUsed,
  requestPersistence,
  restoreBackup,
  saveSettings,
} from './store.js';
import { extractVouchers } from './pdf-import.js';

const $ = (id) => document.getElementById(id);

// Zona di rispetto del barcode, in moduli, per lato.
const QUIET_MODULES = 10;

const state = {
  vouchers: [],
  settings: { ordered: 0, usedBeforeApp: 0 },
  changesSinceBackup: 0,
  tab: 'available',
};

const pay = {
  open: false,
  current: null,
  skipped: new Set(),
  history: [], // buoni segnati usati in questa sessione, per Annulla
  wakeLock: null,
};

// --- Formattazione e calcoli ---

function euro(cents) {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function formatDateTime(iso) {
  if (!iso) return 'data non disponibile';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function byExpiry(a, b) {
  return a.expiry.localeCompare(b.expiry) || a.seq - b.seq;
}

function isSpendable(voucher, today = todayIso()) {
  return voucher.status === 'available' && voucher.expiry >= today;
}

function spendable() {
  const today = todayIso();
  return state.vouchers.filter((v) => isSpendable(v, today)).sort(byExpiry);
}

function expired() {
  const today = todayIso();
  return state.vouchers.filter((v) => v.status === 'available' && v.expiry < today);
}

// --- Stato e schermata principale ---

async function refresh() {
  const next = await getState();
  state.vouchers = next.vouchers;
  state.settings = next.settings;
  state.changesSinceBackup = next.changesSinceBackup;
  renderHome();
}

function renderHome() {
  const available = spendable();
  const lapsed = expired();
  const usedInApp = state.vouchers.filter((v) => v.status === 'used').length;
  const received = state.settings.usedBeforeApp + state.vouchers.length;
  const missing = Math.max(0, state.settings.ordered - received);

  $('count-available').textContent = available.length;
  $('value-available').textContent = euro(available.reduce((sum, v) => sum + v.valueCents, 0));
  $('btn-use').disabled = available.length === 0;
  $('stat-ordered').textContent = state.settings.ordered;
  $('stat-received').textContent = received;
  $('stat-used').textContent = state.settings.usedBeforeApp + usedInApp;
  $('stat-missing').textContent = missing;

  const noticeExpired = $('notice-expired');
  noticeExpired.hidden = lapsed.length === 0;
  noticeExpired.textContent = `Buoni scaduti, esclusi dai disponibili: ${lapsed.length}.`;

  const noticeBackup = $('notice-backup');
  noticeBackup.hidden = state.changesSinceBackup < BACKUP_THRESHOLD;
  noticeBackup.textContent = `${state.changesSinceBackup} modifiche senza backup. Tocca per salvarlo.`;

  renderList();
}

function renderList() {
  const list = $('list');
  list.replaceChildren();
  const showUsed = state.tab === 'used';
  $('tab-available').classList.toggle('is-active', !showUsed);
  $('tab-used').classList.toggle('is-active', showUsed);
  $('tab-available').setAttribute('aria-selected', String(!showUsed));
  $('tab-used').setAttribute('aria-selected', String(showUsed));

  const today = todayIso();
  const rows = showUsed
    ? state.vouchers.filter((v) => v.status === 'used')
      .sort((a, b) => (b.usedAt || '').localeCompare(a.usedAt || ''))
    : state.vouchers.filter((v) => v.status === 'available').sort(byExpiry);

  const empty = $('empty');
  empty.hidden = rows.length > 0;
  empty.textContent = showUsed
    ? 'Nessun buono segnato come usato.'
    : 'Nessun buono. Importa un PDF per iniziare.';

  for (const voucher of rows) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'list-code';
    text.textContent = voucher.code;
    const meta = document.createElement('span');
    meta.className = 'list-meta';
    const isExpired = voucher.status === 'available' && voucher.expiry < today;
    const when = voucher.status === 'used'
      ? `usato ${formatDateTime(voucher.usedAt)}`
      : `${isExpired ? 'scaduto il' : 'scade il'} ${formatDate(voucher.expiry)}`;
    meta.textContent = `${euro(voucher.valueCents)} - ${when}`;
    text.append(meta);

    const actions = document.createElement('div');
    actions.className = 'list-actions';
    if (voucher.status === 'used') {
      actions.append(actionButton('Rimetti', () => restoreVoucher(voucher.code)));
    } else if (!isExpired) {
      actions.append(actionButton('Mostra', () => openPay(voucher.code)));
    }
    if (voucher.source === 'manuale') {
      const del = actionButton('Elimina', () => removeVoucher(voucher.code));
      del.classList.add('btn-danger');
      actions.append(del);
    }
    li.append(text, actions);
    list.append(li);
  }
}

function actionButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-link';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

async function restoreVoucher(code) {
  const ok = await confirmAction(`Rimettere tra i disponibili il buono ${code}?`);
  if (!ok) return;
  await markAvailable(code);
  await refresh();
}

async function removeVoucher(code) {
  const ok = await confirmAction(`Eliminare il buono ${code} aggiunto a mano?`);
  if (!ok) return;
  await deleteVoucher(code);
  await refresh();
}

// --- Finestre di dialogo ---

function showMessage(title, body, items = []) {
  $('message-title').textContent = title;
  $('message-body').textContent = body;
  $('message-list').replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    return li;
  }));
  $('dlg-message').showModal();
}

function confirmAction(text) {
  const dialog = $('dlg-confirm');
  $('confirm-body').textContent = text;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
  });
}

// --- Schermata di pagamento ---

function nextCandidate() {
  const queue = spendable();
  if (queue.length === 0) return null;
  const fresh = queue.find((v) => !pay.skipped.has(v.code));
  if (fresh) return fresh;
  // Tutti saltati: ricomincia dall'inizio della coda.
  pay.skipped.clear();
  return queue[0];
}

function openPay(code) {
  pay.open = true;
  pay.skipped.clear();
  pay.history = [];
  pay.current = code ? state.vouchers.find((v) => v.code === code) : nextCandidate();
  $('pay').hidden = false;
  history.pushState({ pay: true }, '');
  acquireWakeLock();
  renderPay();
}

function closePay() {
  if (!pay.open) return;
  pay.open = false;
  pay.current = null;
  $('pay').hidden = true;
  releaseWakeLock();
  renderHome();
}

function renderPay() {
  const voucher = pay.current;
  const count = pay.history.length;
  const total = pay.history.reduce((sum, v) => sum + v.valueCents, 0);
  $('pay-session').textContent = count > 0
    ? `${count} ${count === 1 ? 'buono' : 'buoni'} = ${euro(total)}`
    : '';
  $('pay-undo').disabled = count === 0;
  $('pay-next').disabled = !voucher;
  $('pay-skip').disabled = !voucher || spendable().length < 2;
  $('pay-body').hidden = !voucher;
  $('pay-finished').hidden = Boolean(voucher);
  if (!voucher) return;

  $('pay-code').textContent = voucher.code;
  const remaining = spendable().length;
  $('pay-meta').textContent = `${euro(voucher.valueCents)} - scade il ${formatDate(voucher.expiry)} - ${remaining} ${remaining === 1 ? 'disponibile' : 'disponibili'}`;
  $('pay-copy').textContent = 'Copia codice';
  drawBarcode(voucher.code);
}

// Disegna con moduli di larghezza intera in pixel fisici, per barre nitide.
function drawBarcode(code) {
  const canvas = $('barcode');
  const dpr = window.devicePixelRatio || 1;
  const encoded = {};
  window.JsBarcode(encoded, code, { format: 'CODE128' });
  const modules = encoded.encodings[0].data.length + QUIET_MODULES * 2;
  const area = $('pay-body');
  const availableWidth = Math.floor(area.clientWidth * dpr);
  const moduleWidth = Math.max(1, Math.floor(availableWidth / modules));
  const height = Math.round(Math.min(area.clientHeight * dpr * 0.55, moduleWidth * modules * 0.5));

  window.JsBarcode(canvas, code, {
    format: 'CODE128',
    width: moduleWidth,
    height,
    margin: QUIET_MODULES * moduleWidth,
    displayValue: false,
    background: '#ffffff',
    lineColor: '#000000',
  });
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
}

async function payNext() {
  const voucher = pay.current;
  if (!voucher) return;
  await markUsed(voucher.code);
  pay.history.push(voucher);
  await refresh();
  pay.current = nextCandidate();
  renderPay();
}

async function payUndo() {
  const last = pay.history.pop();
  if (!last) return;
  await markAvailable(last.code);
  await refresh();
  pay.current = state.vouchers.find((v) => v.code === last.code);
  renderPay();
}

function paySkip() {
  if (!pay.current) return;
  pay.skipped.add(pay.current.code);
  pay.current = nextCandidate();
  renderPay();
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    pay.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    pay.wakeLock = null; // Non bloccante: lo schermo segue le impostazioni del telefono.
  }
}

function releaseWakeLock() {
  if (pay.wakeLock) pay.wakeLock.release().catch(() => {});
  pay.wakeLock = null;
}

// --- Import PDF ---

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

async function importPdfFiles(files) {
  const button = $('btn-import');
  button.disabled = true;
  button.textContent = 'Lettura...';
  const lines = [];
  const details = [];
  let totals = { pages: 0, added: 0, duplicates: 0, errors: 0 };
  try {
    const pdfjs = await loadPdfjs();
    for (const file of files) {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const result = await extractVouchers(data, pdfjs);
        const saved = await addVouchers(result.vouchers, file.name);
        totals = {
          pages: totals.pages + result.pages,
          added: totals.added + saved.added,
          duplicates: totals.duplicates + saved.duplicates + result.repeated,
          errors: totals.errors + result.errors.length,
        };
        for (const error of result.errors) {
          details.push(`${file.name}, pagina ${error.page}: ${error.reason}`);
        }
      } catch (error) {
        totals.errors += 1;
        details.push(`${file.name}: file non leggibile`);
        console.error(error);
      }
    }
  } catch (error) {
    console.error(error);
    showMessage('Import non riuscito', 'Non è stato possibile avviare la lettura dei PDF.');
    return;
  } finally {
    button.disabled = false;
    button.textContent = 'Importa PDF';
  }
  lines.push(`Pagine: ${totals.pages}. Importati: ${totals.added}. Duplicati: ${totals.duplicates}. Errori: ${totals.errors}.`);
  await refresh();
  showMessage(totals.errors ? 'Import con errori' : 'Import completato', lines.join(' '), details);
}

// --- Inserimento manuale ---

async function submitManual(event) {
  event.preventDefault();
  const code = $('manual-code').value.trim();
  const valueCents = Math.round(Number($('manual-value').value.replace(',', '.')) * 100);
  const expiry = $('manual-expiry').value;
  if (!(valueCents > 0) || !expiry) return;
  const { added } = await addVouchers([{ code, valueCents, expiry }], 'manuale');
  $('dlg-manual').close();
  $('form-manual').reset();
  await refresh();
  if (!added) showMessage('Già presente', `Il buono ${code} è già in archivio.`);
}

// --- Backup ---

async function exportBackupFile() {
  const backup = await exportBackup();
  const json = JSON.stringify(backup, null, 2);
  const stamp = todayIso();
  const candidates = [
    new File([json], `buoni-backup-${stamp}.json`, { type: 'application/json' }),
    new File([json], `buoni-backup-${stamp}.txt`, { type: 'text/plain' }),
  ];
  const shareable = navigator.canShare && candidates.find((file) => navigator.canShare({ files: [file] }));
  if (shareable) {
    try {
      await navigator.share({ files: [shareable], title: 'Backup buoni' });
    } catch (error) {
      if (error.name === 'AbortError') return; // Condivisione annullata: il promemoria resta.
      downloadFile(candidates[0]);
    }
  } else {
    downloadFile(candidates[0]);
  }
  await clearBackupReminder();
  await refresh();
  $('dlg-backup').close();
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function restoreBackupFile(file) {
  $('dlg-backup').close();
  try {
    const backup = JSON.parse(await file.text());
    const result = await restoreBackup(backup);
    await refresh();
    showMessage('Ripristino completato', `Buoni aggiunti: ${result.added}. Segnati come usati: ${result.markedUsed}.`);
  } catch (error) {
    const known = error instanceof SyntaxError ? 'Il file non è un backup di questa app.' : error.message;
    showMessage('Ripristino non riuscito', known);
  }
}

function openBackupDialog() {
  $('setting-ordered').value = state.settings.ordered;
  $('setting-used').value = state.settings.usedBeforeApp;
  $('dlg-backup').showModal();
}

async function submitSettings(event) {
  event.preventDefault();
  await saveSettings({
    ordered: Number($('setting-ordered').value),
    usedBeforeApp: Number($('setting-used').value),
  });
  $('dlg-backup').close();
  await refresh();
}

// --- Collegamento eventi ---

function bindEvents() {
  $('btn-use').addEventListener('click', () => openPay());
  $('tab-available').addEventListener('click', () => { state.tab = 'available'; renderList(); });
  $('tab-used').addEventListener('click', () => { state.tab = 'used'; renderList(); });

  $('pay-close').addEventListener('click', () => history.back());
  $('pay-next').addEventListener('click', payNext);
  $('pay-undo').addEventListener('click', payUndo);
  $('pay-skip').addEventListener('click', paySkip);
  $('pay-copy').addEventListener('click', async () => {
    if (!pay.current) return;
    try {
      await navigator.clipboard.writeText(pay.current.code);
      $('pay-copy').textContent = 'Copiato';
    } catch {
      $('pay-copy').textContent = 'Copia non riuscita';
    }
  });
  // Il tasto Indietro di Android chiude il pagamento senza uscire dall'app.
  window.addEventListener('popstate', closePay);
  window.addEventListener('resize', () => {
    if (pay.open && pay.current) drawBarcode(pay.current.code);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pay.open) acquireWakeLock();
  });

  $('btn-import').addEventListener('click', () => $('file-pdf').click());
  $('file-pdf').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) await importPdfFiles(files);
  });

  $('btn-manual').addEventListener('click', () => $('dlg-manual').showModal());
  $('manual-cancel').addEventListener('click', () => $('dlg-manual').close());
  $('form-manual').addEventListener('submit', submitManual);

  $('btn-backup').addEventListener('click', openBackupDialog);
  $('notice-backup').addEventListener('click', openBackupDialog);
  $('backup-close').addEventListener('click', () => $('dlg-backup').close());
  $('backup-export').addEventListener('click', exportBackupFile);
  $('backup-restore').addEventListener('click', () => $('file-backup').click());
  $('file-backup').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) await restoreBackupFile(file);
  });
  $('form-settings').addEventListener('submit', submitSettings);
}

async function start() {
  bindEvents();
  await refresh();
  requestPersistence();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((error) => console.error(error));
  }
}

start();
