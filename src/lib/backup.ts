import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { getAll, put } from './db';
import type { Employee, Punch, PayrollEmployee, PayrollPunch } from '../types';
import type { DayOverride } from './attendance';

const BACKUP_DIRECTORY = Directory.Documents;

// Android requires this permission on every fresh install — even reinstalling
// the exact same signed build resets it, even though files written to
// Directory.Documents by a previous install are still on disk. Without this,
// reads/writes silently fail and the file looks "inaccessible" even though
// it's really just unreadable until the user re-grants access.
async function ensureStoragePermission(): Promise<boolean> {
  try {
    const status = await Filesystem.checkPermissions();
    if (status.publicStorage === 'granted') return true;
    const requested = await Filesystem.requestPermissions();
    return requested.publicStorage === 'granted';
  } catch {
    // Web/other platforms without this permission model — nothing to request.
    return true;
  }
}

async function hashDeviceId(deviceId: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(deviceId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

async function getBackupPath(deviceId: string): Promise<string> {
  const hash = await hashDeviceId(deviceId);
  return `niko-payroll/backup-${hash}.enc`;
}

// ── AES-GCM Encryption ──────────────────────────────────────────────────────

function buf2hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(x => ('00' + x.toString(16)).slice(-2))
    .join('');
}

function hex2buf(hexString: string): ArrayBuffer {
  const bytes = new Uint8Array(Math.ceil(hexString.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function deriveKey(deviceId: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(deviceId),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("niko-payroll-backup-salt-v1"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(deviceId: string, data: string): Promise<{ iv: string; cipher: string }> {
  const key = await deriveKey(deviceId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  return {
    iv: buf2hex(iv.buffer),
    cipher: buf2hex(cipherBuffer)
  };
}

async function decryptData(deviceId: string, ivHex: string, cipherHex: string): Promise<string> {
  const key = await deriveKey(deviceId);
  const iv = hex2buf(ivHex);
  const cipherBuffer = hex2buf(cipherHex);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    cipherBuffer
  );

  return new TextDecoder().decode(decryptedBuffer);
}

// ── File I/O with fallback paths ────────────────────────────────────────────

interface ReadResult {
  data: string;
}

async function tryReadBackupFile(deviceId: string): Promise<ReadResult> {
  const path = await getBackupPath(deviceId);

  // Primary: Directory.Documents
  try {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    return { data: result.data as string };
  } catch {
    // fall through to fallback
  }

  // Fallback: Directory.ExternalStorage with Documents/ prefix.
  // On some Android versions (especially after a signing-key change),
  // Directory.Documents blocks readFile() even when stat() succeeds.
  // ExternalStorage with the full subpath bypasses that scoped-storage quirk.
  try {
    const result = await Filesystem.readFile({
      path: `Documents/${path}`,
      directory: Directory.ExternalStorage,
      encoding: Encoding.UTF8,
    });
    return { data: result.data as string };
  } catch {
    throw new Error("File does not exist");
  }
}

async function fileExists(deviceId: string): Promise<{ exists: boolean; mtime?: number }> {
  const path = await getBackupPath(deviceId);
  try {
    const stat = await Filesystem.stat({ path, directory: Directory.Documents });
    if (stat.size > 0) return { exists: true, mtime: stat.mtime };
  } catch {
    // stat failed — try ExternalStorage path
  }
  try {
    const stat = await Filesystem.stat({
      path: `Documents/${path}`,
      directory: Directory.ExternalStorage,
    });
    if (stat.size > 0) return { exists: true, mtime: stat.mtime };
  } catch {
    // neither location has it
  }
  return { exists: false };
}

// ────────────────────────────────────────────────────────────────────────────

export interface BackupMetadata {
  exists: boolean;
  readable: boolean;
  savedAt?: number;
  employees?: number;
  punches?: number;
  overrides?: number;
  payrollEmployees?: number;
  payrollPunches?: number;
  metaKeys?: number;
}

export async function checkBackup(deviceId: string): Promise<BackupMetadata> {
  if (!deviceId) return { exists: false, readable: false };

  await ensureStoragePermission();

  const f = await fileExists(deviceId);
  if (!f.exists) return { exists: false, readable: false };

  const meta: BackupMetadata = { exists: true, readable: false, savedAt: f.mtime };

  try {
    const result = await tryReadBackupFile(deviceId);
    const fileData = JSON.parse(result.data);
    if (fileData.iv && fileData.cipher) {
      const decryptedStr = await decryptData(deviceId, fileData.iv, fileData.cipher);
      const data = JSON.parse(decryptedStr);
      meta.readable = true;
      meta.employees = Array.isArray(data.employees) ? data.employees.length : 0;
      meta.punches = Array.isArray(data.punches) ? data.punches.length : 0;
      meta.overrides = Array.isArray(data.overrides) ? data.overrides.length : 0;
      meta.payrollEmployees = Array.isArray(data.payrollEmployees) ? data.payrollEmployees.length : 0;
      meta.payrollPunches = Array.isArray(data.payrollPunches) ? data.payrollPunches.length : 0;
      meta.metaKeys = Array.isArray(data.metaEntries) ? data.metaEntries.length : 0;
    }
  } catch {
    // can't read/decode — exists on disk but inaccessible
  }

  return meta;
}

export async function saveBackup(deviceId: string): Promise<void> {
  if (!deviceId) return;
  try {
    await ensureStoragePermission();

    const [employees, punches, overrides, payrollEmployees, payrollPunches, metaEntries] = await Promise.all([
      getAll<Employee>('employees'),
      getAll<Punch>('punches'),
      getAll<DayOverride>('overrides'),
      getAll<PayrollEmployee>('payrollEmployees'),
      getAll<PayrollPunch>('payrollPunches'),
      getAll<any>('meta'),
    ]);

    const rawData = JSON.stringify({
      formatVersion: "0.2.0",
      savedAt: Date.now(),
      employees,
      punches,
      overrides,
      payrollEmployees,
      payrollPunches,
      metaEntries,
    });

    const encrypted = await encryptData(deviceId, rawData);
    const fileContent = JSON.stringify(encrypted);

    const path = await getBackupPath(deviceId);

    try {
      await Filesystem.mkdir({
        path: 'niko-payroll',
        directory: BACKUP_DIRECTORY,
        recursive: true
      });
    } catch (e) {
      // Might already exist
    }

    await Filesystem.writeFile({
      path,
      data: fileContent,
      directory: BACKUP_DIRECTORY,
      encoding: Encoding.UTF8,
    });
    console.log(`Encrypted backup saved to ${path}`);
  } catch (e) {
    console.error("Failed to save encrypted backup:", e);
  }
}

export interface RestoreResult {
  employees: number;
  punches: number;
  overrides: number;
  payrollEmployees: number;
  payrollPunches: number;
  metaKeys: number;
}

export async function restoreFromBackup(deviceId: string): Promise<RestoreResult> {
  if (!deviceId) throw new Error("No device ID provided");

  await ensureStoragePermission();

  const result = await tryReadBackupFile(deviceId);

  const fileData = JSON.parse(result.data);
  if (!fileData.iv || !fileData.cipher) {
    throw new Error("Invalid encrypted backup format");
  }

  let data;
  try {
    const decryptedStr = await decryptData(deviceId, fileData.iv, fileData.cipher);
    data = JSON.parse(decryptedStr);
  } catch (e) {
    throw new Error("Failed to decrypt backup. The file may be corrupt or belongs to a different device.");
  }

  const backupEmployees: Employee[] = data.employees || [];
  const backupPunches: Punch[] = data.punches || [];
  const backupOverrides: DayOverride[] = data.overrides || [];
  const backupPayrollEmployees: PayrollEmployee[] = data.payrollEmployees || [];
  const backupPayrollPunches: PayrollPunch[] = data.payrollPunches || [];
  const backupMetaEntries: Record<string, any>[] = data.metaEntries || [];

  function mergeList<T extends { id?: string; key?: string; syncedAt?: number }>(
    localById: Map<string, T>,
    backup: T[],
    idFn: (item: T) => string,
  ): T[] {
    return backup.filter(b => {
      const local = localById.get(idFn(b));
      return !local || local.syncedAt;
    });
  }

  const localEmployees = new Map((await getAll<Employee>('employees')).map(e => [e.id, e]));
  const localPunches = new Map((await getAll<Punch>('punches')).map(p => [p.id, p]));
  const localOverrides = new Map((await getAll<DayOverride>('overrides')).map(o => [o.key, o]));
  const localPayrollEmployees = new Map((await getAll<PayrollEmployee>('payrollEmployees')).map(e => [e.id, e]));
  const localPayrollPunches = new Map((await getAll<PayrollPunch>('payrollPunches')).map(p => [p.id, p]));

  const toWriteEmployees = mergeList(localEmployees, backupEmployees, e => e.id);
  const toWritePunches = mergeList(localPunches, backupPunches, p => p.id);
  const toWriteOverrides = mergeList(localOverrides, backupOverrides, o => o.key);
  const toWritePayrollEmployees = mergeList(localPayrollEmployees, backupPayrollEmployees, e => e.id);
  const toWritePayrollPunches = mergeList(localPayrollPunches, backupPayrollPunches, p => p.id);

  let restoredMeta = 0;
  const metaOps: Promise<void>[] = [];
  for (const entry of backupMetaEntries) {
    if (!entry.key) continue;
    metaOps.push(put('meta', entry));
    restoredMeta++;
  }

  await Promise.all([
    ...toWriteEmployees.map(e => put('employees', e)),
    ...toWritePunches.map(p => put('punches', p)),
    ...toWriteOverrides.map(o => put('overrides', o)),
    ...toWritePayrollEmployees.map(e => put('payrollEmployees', e)),
    ...toWritePayrollPunches.map(p => put('payrollPunches', p)),
    ...metaOps,
  ]);

  return {
    employees: toWriteEmployees.length,
    punches: toWritePunches.length,
    overrides: toWriteOverrides.length,
    payrollEmployees: toWritePayrollEmployees.length,
    payrollPunches: toWritePayrollPunches.length,
    metaKeys: restoredMeta,
  };
}
