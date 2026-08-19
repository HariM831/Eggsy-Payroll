// Local storage layer — IndexedDB, entirely on-device, no network or native
// plugin dependency. Chosen over a native SQLite plugin so the exact same
// code runs in `npm run dev` (desktop browser) and inside the Capacitor
// Android WebView with zero platform-specific branches.
//
// Stores:
//   employees        — keyPath "id" — Wages workers, enrolled on-device
//   punches          — keyPath "id", index "byEmployeeDate" on [employeeId, punchDate] — Wages punches
//   overrides        — keyPath "key" ("<employeeId>|<date>"), manual day-status corrections (Wages only)
//   payrollEmployees — keyPath "id" — read-only mirror of the main app's payroll roster
//                      (this device never enrolls a payroll employee; see sync.ts)
//   payrollPunches   — keyPath "id", index "byEmployeeDate" on [employeeId, punchDate]
//   meta             — keyPath "key", arbitrary settings (PIN hash, sync config, etc.)

const DB_NAME = "niko-payroll";
// v3 adds the "byDate" indexes — see the upgrade block below.
const DB_VERSION = 3;

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
      if (!db.objectStoreNames.contains("payrollEmployees")) {
        db.createObjectStore("payrollEmployees", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("payrollPunches")) {
        const store = db.createObjectStore("payrollPunches", { keyPath: "id" });
        store.createIndex("byEmployeeDate", ["employeeId", "punchDate"], { unique: false });
        store.createIndex("byEmployee", "employeeId", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }

      // v3: "byDate" on both punch stores. The Punch screen needs today's
      // punches after every capture (present-count, duplicate guard) and was
      // reading the whole store — every punch ever taken — to do it. On a
      // low-end phone that scan runs while the camera and face engine are
      // live, which is exactly when there is no memory to spare. Added
      // outside the create-if-missing blocks above so existing installs pick
      // it up on upgrade, not just fresh ones.
      const upgradeTx = req.transaction!;
      for (const name of ["punches", "payrollPunches"]) {
        const store = upgradeTx.objectStore(name);
        if (!store.indexNames.contains("byDate")) {
          store.createIndex("byDate", "punchDate", { unique: false });
        }
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

/** Keys only — no values. For "does this store have rows, and which ids?"
 * checks on stores whose rows are large (payrollEmployees carries a face
 * descriptor and up to a week of embeddings each), where getAll() would pull
 * all of that into memory just to count. */
export async function getAllKeys(storeName: string): Promise<IDBValidKey[]> {
  const db = await openDb();
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  return reqToPromise(store.getAllKeys());
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

export async function clear(storeName: string): Promise<void> {
  await tx(storeName, "readwrite", (store) => store.clear());
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
