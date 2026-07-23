// Local device PIN lock — single supervisor device, no session server.
// Hash + salt are stored in IndexedDB; nothing to authenticate against
// remotely. This is a screen lock, not a multi-user permission system.
import { get, put } from "./db";

interface PinRecord {
  key: "pin";
  saltHex: string;
  hashHex: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const data = new Uint8Array(salt.length + enc.encode(pin).length);
  data.set(salt, 0);
  data.set(enc.encode(pin), salt.length);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export async function isPinSet(): Promise<boolean> {
  const record = await get<PinRecord>("meta", "pin");
  return !!record;
}

export async function setPin(pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashHex = await hashPin(pin, salt);
  const record: PinRecord = { key: "pin", saltHex: bytesToHex(salt), hashHex };
  await put("meta", record);
}

export async function verifyPin(pin: string): Promise<boolean> {
  const record = await get<PinRecord>("meta", "pin");
  if (!record) return false;
  const hashHex = await hashPin(pin, hexToBytes(record.saltHex));
  return hashHex === record.hashHex;
}

const SESSION_KEY = "niko-payroll-unlocked-at";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // re-lock after 15 minutes idle

export function markUnlocked(): void {
  sessionStorage.setItem(SESSION_KEY, String(Date.now()));
}

export function isUnlocked(): boolean {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return false;
  return Date.now() - Number(raw) < IDLE_TIMEOUT_MS;
}

export function lock(): void {
  sessionStorage.removeItem(SESSION_KEY);
}
