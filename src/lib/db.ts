// Local storage layer — IndexedDB, entirely on-device, no network or native
// plugin dependency. Chosen over a native SQLite plugin so the exact same
// code runs in `npm run dev` (desktop browser) and inside the Capacitor
// Android WebView with zero platform-specific branches.
//
// Stores:
//   employees  — keyPath "id"
//   punches    — keyPath "id", index "byEmployeeDate" on [employeeId, punchDate]
//   overrides  — keyPath "key" ("<employeeId>|<date>"), manual day-status corrections
//   meta       — keyPath "key", arbitrary settings (PIN hash, etc.)

const DB_NAME = "niko-payroll";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("employees")) {
        db.createObjectStore("employees", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("punches")) {
        const store = db.createObjectStore("punches", { keyPath: "id" });
        store.createIndex("byEmployeeDate", ["employeeId", "punchDate"], { unique: false });
        store.createIndex("byEmployee", "employeeId", { unique: false });
      }
      if (!db.objectStoreNames.contains("overrides")) {
        db.createObjectStore("overrides", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    if (result instanceof IDBRequest) {
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    } else {
      result.then(resolve, reject);
    }
    t.onerror = () => reject(t.error);
  });
}

export async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  return reqToPromise(store.getAll());
}

export async function get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  return reqToPromise(store.get(key));
}

export async function put<T>(storeName: string, value: T): Promise<void> {
  await tx(storeName, "readwrite", (store) => store.put(value as any));
}

export async function del(storeName: string, key: IDBValidKey): Promise<void> {
  await tx(storeName, "readwrite", (store) => store.delete(key));
}

export async function getByIndex<T>(
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  const db = await openDb();
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  const index = store.index(indexName);
  return reqToPromise(index.getAll(query));
}
