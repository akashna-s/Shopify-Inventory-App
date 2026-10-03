const DATABASE_NAME = "audit-bot-analytics-cache";
const DATABASE_VERSION = 1;
const FILE_STORE = "monthly-files";
const META_STORE = "metadata";
const DOWNLOAD_CONCURRENCY = 3;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FILE_STORE)) {
        database.createObjectStore(FILE_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getRecord(database, storeName, key) {
  const transaction = database.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).get(key));
}

async function putRecord(database, storeName, value) {
  const transaction = database.transaction(storeName, "readwrite");
  await requestResult(transaction.objectStore(storeName).put(value));
}

async function deleteRecord(database, storeName, key) {
  const transaction = database.transaction(storeName, "readwrite");
  await requestResult(transaction.objectStore(storeName).delete(key));
}

async function mapConcurrent(items, limit, worker) {
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const error = new Error(`Analytics browser cache request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function refreshAnalyticsBrowserCache() {
  if (typeof indexedDB === "undefined") return { supported: false };
  let manifest;
  try {
    manifest = await fetchJson("/app/analytics-cache");
  } catch (error) {
    if (error.status === 404 || error.status === 409) {
      return { supported: true, ready: false, reason: error.status };
    }
    throw error;
  }

  const database = await openDatabase();
  try {
    const storeId = String(manifest.storeId);
    const desiredKeys = new Set(
      manifest.months.map((entry) => `${storeId}:${entry.month}`),
    );
    let downloaded = 0;
    await mapConcurrent(manifest.months, DOWNLOAD_CONCURRENCY, async (entry) => {
      const key = `${storeId}:${entry.month}`;
      const existing = await getRecord(database, FILE_STORE, key);
      if (existing?.checksum === entry.checksum) return;
      const payload = await fetchJson(
        `/app/analytics-cache?month=${encodeURIComponent(entry.month)}`,
      );
      await putRecord(database, FILE_STORE, {
        key,
        storeId,
        month: entry.month,
        checksum: entry.checksum,
        payload,
        cachedAt: new Date().toISOString(),
      });
      downloaded += 1;
    });

    const previousManifest = await getRecord(
      database,
      META_STORE,
      `${storeId}:manifest`,
    );
    for (const entry of previousManifest?.manifest?.months || []) {
      const key = `${storeId}:${entry.month}`;
      if (!desiredKeys.has(key)) await deleteRecord(database, FILE_STORE, key);
    }
    await putRecord(database, META_STORE, {
      key: `${storeId}:manifest`,
      storeId,
      manifest,
      cachedAt: new Date().toISOString(),
    });
    return {
      supported: true,
      ready: true,
      storeId,
      months: manifest.months.length,
      downloaded,
    };
  } finally {
    database.close();
  }
}

export async function readCachedAnalyticsMonth(storeId, month) {
  if (typeof indexedDB === "undefined") return null;
  const database = await openDatabase();
  try {
    const record = await getRecord(
      database,
      FILE_STORE,
      `${String(storeId)}:${String(month)}`,
    );
    return record?.payload || null;
  } finally {
    database.close();
  }
}
