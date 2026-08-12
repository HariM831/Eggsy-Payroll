import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { getAll, put } from './db';
import type { Employee, Punch } from '../types';
import type { DayOverride } from './attendance';

// ExternalStorage (/storage/emulated/0) — NOT External, which maps to
// getExternalFilesDir() and is deleted by Android on uninstall along with the
// app. This directory sits outside the app's own folder, so the backup file
// genuinely survives an uninstall/reinstall, which is the whole point of it.
//
// The trade-off: on Android 11+ writing here needs the "All files access"
// special permission (MANAGE_EXTERNAL_STORAGE, declared in
// scripts/patch-android-manifest.mjs). Android deliberately does not let an
// app request that from a normal permission dialog — it has to be switched on
// once per device under Settings > Apps > Niko-Payroll > Special app access.
// Until it is, saveBackup() fails silently (it already swallows errors) and
// checkBackup() simply reports no backup; nothing else breaks. Settings shows
// a hint explaining this.
const BACKUP_DIRECTORY = Directory.ExternalStorage;

// We hash the deviceId to use as the filename, so the raw ID isn't exposed
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
      salt: enc.encode("niko-payroll-backup-salt-v1"), // static salt is fine here, key is deterministic per device
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(deviceId: string, data: string): Promise<{ iv: string, cipher: string }> {
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

// ────────────────────────────────────────────────────────────────────────────

export interface BackupMetadata {
  exists: boolean;
  savedAt?: number;
}

export async function checkBackup(deviceId: string): Promise<BackupMetadata> {
  if (!deviceId) return { exists: false };
  try {
    const path = await getBackupPath(deviceId);
    const stat = await Filesystem.stat({
      path,
      directory: BACKUP_DIRECTORY,
    });
    if (stat.size === 0) return { exists: false };
    return { 
      exists: true, 
      savedAt: stat.mtime 
    };
  } catch (e) {
    return { exists: false };
  }
}

export async function saveBackup(deviceId: string): Promise<void> {
  if (!deviceId) return;
  try {
    const [employees, punches, overrides] = await Promise.all([
      getAll<Employee>('employees'),
      getAll<Punch>('punches'),
      getAll<DayOverride>('overrides'),
    ]);

    const rawData = JSON.stringify({
      savedAt: Date.now(),
      appVersion: "0.1.0",
      employees,
      punches,
      overrides,
    });

    const encrypted = await encryptData(deviceId, rawData);
    const fileContent = JSON.stringify(encrypted); // { iv: "...", cipher: "..." }

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
    // best-effort, swallow
  }
}

export async function restoreFromBackup(deviceId: string): Promise<{ employees: number; punches: number; overrides: number }> {
  if (!deviceId) throw new Error("No device ID provided");
  
  const path = await getBackupPath(deviceId);
  const result = await Filesystem.readFile({
    path,
    directory: BACKUP_DIRECTORY,
    encoding: Encoding.UTF8,
  });

  const fileData = JSON.parse(result.data as string);
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

  const localEmployees = new Map((await getAll<Employee>('employees')).map(e => [e.id, e]));
  const toWriteEmployees = backupEmployees.filter(b => {
    const local = localEmployees.get(b.id);
    return !local || local.syncedAt;
  });

  const localPunches = new Map((await getAll<Punch>('punches')).map(p => [p.id, p]));
  const toWritePunches = backupPunches.filter(b => {
    const local = localPunches.get(b.id);
    return !local || local.syncedAt;
  });

  const localOverrides = new Map((await getAll<DayOverride>('overrides')).map(o => [o.key, o]));
  const toWriteOverrides = backupOverrides.filter(b => {
    const local = localOverrides.get(b.key);
    return !local || local.syncedAt;
  });

  await Promise.all([
    ...toWriteEmployees.map(e => put('employees', e)),
    ...toWritePunches.map(p => put('punches', p)),
    ...toWriteOverrides.map(o => put('overrides', o)),
  ]);

  return {
    employees: toWriteEmployees.length,
    punches: toWritePunches.length,
    overrides: toWriteOverrides.length
  };
}
