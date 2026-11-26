// 渲染结果的磁盘缓存（IndexedDB）。
// 一首 3 分钟的曲子渲染要 20 秒、音频 3MB，重复载入同一份谱子不该再等一次。

const DB_NAME = 'piano-falls';
const DB_VERSION = 1;
const STORE = 'renders';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这个环境没有 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('事务被中断'));
        resolve(store);
      }),
  );
}

/** @returns {Promise<{audio?: Uint8Array, midi?: Uint8Array, savedAt?: number}|null>} */
export async function getRender(key) {
  try {
    const store = await tx('readonly');
    return await new Promise((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function putRender(key, value) {
  try {
    const store = await tx('readwrite');
    await new Promise((resolve, reject) => {
      const req = store.put({ ...value, savedAt: Date.now() }, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch (err) {
    console.warn('[cache] 写入缓存失败（不影响播放）：', err?.message ?? err);
    return false;
  }
}

export async function clearRenders() {
  try {
    const store = await tx('readwrite');
    await new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch {
    return false;
  }
}

/** 给界面看的：缓存了多少份、占多少空间 */
export async function cacheStats() {
  try {
    const store = await tx('readonly');
    const all = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    let bytes = 0;
    for (const item of all) {
      bytes += (item.audio?.byteLength || 0) + (item.midi?.byteLength || 0);
    }
    return { count: all.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}