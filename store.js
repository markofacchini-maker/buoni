// Archivio locale dei buoni (IndexedDB). I dati restano sul dispositivo.

const DB_NAME = 'buoni';
const DB_VERSION = 1;
const VOUCHERS = 'vouchers';
const META = 'meta';

export const DEFAULT_SETTINGS = { ordered: 100, usedBeforeApp: 4 };
export const BACKUP_THRESHOLD = 10;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore(VOUCHERS, { keyPath: 'code' });
        db.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

// Esegue fn dentro una transazione su entrambi gli archivi e attende il commit.
async function transact(mode, fn) {
  const db = await openDb();
  const tx = db.transaction([VOUCHERS, META], mode);
  const result = await fn(tx.objectStore(VOUCHERS), tx.objectStore(META));
  await done(tx);
  return result;
}

async function bumpChanges(meta, by) {
  const current = (await wrap(meta.get('changesSinceBackup'))) || 0;
  meta.put(current + by, 'changesSinceBackup');
}

export function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    return navigator.storage.persist().catch(() => false);
  }
  return Promise.resolve(false);
}

export function getVouchers() {
  return transact('readonly', (vouchers) => wrap(vouchers.getAll()));
}

export function getState() {
  return transact('readonly', async (vouchers, meta) => {
    const list = await wrap(vouchers.getAll());
    const ordered = await wrap(meta.get('ordered'));
    const usedBeforeApp = await wrap(meta.get('usedBeforeApp'));
    const changes = await wrap(meta.get('changesSinceBackup'));
    return {
      vouchers: list,
      settings: {
        ordered: ordered ?? DEFAULT_SETTINGS.ordered,
        usedBeforeApp: usedBeforeApp ?? DEFAULT_SETTINGS.usedBeforeApp,
      },
      changesSinceBackup: changes || 0,
    };
  });
}

export function saveSettings({ ordered, usedBeforeApp }) {
  return transact('readwrite', async (vouchers, meta) => {
    meta.put(ordered, 'ordered');
    meta.put(usedBeforeApp, 'usedBeforeApp');
    await bumpChanges(meta, 1);
  });
}

// Aggiunge i buoni nuovi e ignora quelli già presenti.
export function addVouchers(items, source) {
  return transact('readwrite', async (vouchers, meta) => {
    const existing = new Set(await wrap(vouchers.getAllKeys()));
    const now = new Date().toISOString();
    const base = Date.now();
    let added = 0;
    let duplicates = 0;
    items.forEach((item, index) => {
      if (existing.has(item.code)) {
        duplicates += 1;
        return;
      }
      existing.add(item.code);
      vouchers.put({
        code: item.code,
        valueCents: item.valueCents,
        expiry: item.expiry,
        status: 'available',
        usedAt: null,
        source,
        importedAt: now,
        seq: base + index,
      });
      added += 1;
    });
    if (added) await bumpChanges(meta, added);
    return { added, duplicates };
  });
}

async function setStatus(code, status, usedAt) {
  return transact('readwrite', async (vouchers, meta) => {
    const voucher = await wrap(vouchers.get(code));
    if (!voucher) throw new Error('Buono non trovato');
    voucher.status = status;
    voucher.usedAt = usedAt;
    vouchers.put(voucher);
    await bumpChanges(meta, 1);
  });
}

export function markUsed(code) {
  return setStatus(code, 'used', new Date().toISOString());
}

export function markAvailable(code) {
  return setStatus(code, 'available', null);
}

export function deleteVoucher(code) {
  return transact('readwrite', async (vouchers, meta) => {
    vouchers.delete(code);
    await bumpChanges(meta, 1);
  });
}

export async function exportBackup() {
  const { vouchers, settings } = await getState();
  return {
    app: 'buoni',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    vouchers,
  };
}

export function clearBackupReminder() {
  return transact('readwrite', async (vouchers, meta) => {
    meta.put(0, 'changesSinceBackup');
  });
}

function isValidVoucher(v) {
  return v
    && typeof v.code === 'string' && /^[0-9A-Za-z]{4,40}$/.test(v.code)
    && Number.isInteger(v.valueCents) && v.valueCents > 0
    && typeof v.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.expiry)
    && (v.status === 'available' || v.status === 'used');
}

// Unisce un backup all'archivio. Un buono segnato usato resta usato.
export function restoreBackup(backup) {
  if (!backup || backup.app !== 'buoni' || backup.version !== 1 || !Array.isArray(backup.vouchers)) {
    throw new Error('Il file non è un backup di questa app.');
  }
  if (!backup.vouchers.every(isValidVoucher)) {
    throw new Error('Il backup contiene buoni non validi: nessun dato modificato.');
  }
  return transact('readwrite', async (vouchers, meta) => {
    const current = await wrap(vouchers.getAll());
    const byCode = new Map(current.map((v) => [v.code, v]));
    let added = 0;
    let markedUsed = 0;
    backup.vouchers.forEach((incoming, index) => {
      const local = byCode.get(incoming.code);
      if (!local) {
        vouchers.put({
          code: incoming.code,
          valueCents: incoming.valueCents,
          expiry: incoming.expiry,
          status: incoming.status,
          usedAt: incoming.status === 'used' ? (incoming.usedAt || null) : null,
          source: incoming.source || 'backup',
          importedAt: incoming.importedAt || new Date().toISOString(),
          seq: Number.isFinite(incoming.seq) ? incoming.seq : index,
        });
        added += 1;
      } else if (incoming.status === 'used' && local.status !== 'used') {
        local.status = 'used';
        local.usedAt = incoming.usedAt || null;
        vouchers.put(local);
        markedUsed += 1;
      }
    });
    const s = backup.settings;
    if (s && Number.isInteger(s.ordered) && Number.isInteger(s.usedBeforeApp)) {
      meta.put(s.ordered, 'ordered');
      meta.put(s.usedBeforeApp, 'usedBeforeApp');
    }
    meta.put(0, 'changesSinceBackup');
    return { added, markedUsed };
  });
}
