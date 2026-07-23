// Opportunistic sync to the central Amino Farms server — an outbox pattern,
// not a live connection. Punching still works with zero connectivity; this
// module just pushes whatever accumulated locally whenever a connection
// happens to be available, so HR doesn't have to manually export/share data.
//
// One-way: device -> server for identity and attendance. The device is the
// source of truth for worker identity (name/aadhar/photo/face/role) and all
// attendance data. The one exception is role *names*: the server owns the
// rate card (Amino Farms Wages > Roles) and piggybacks the current list of
// role names on every sync response, purely so the enrollment form can
// suggest existing roles — the rate itself is never sent here. See
// server/routes/wages.ts on the Amino Farms side for the receiving end.
import { getAll, get, put } from "./db";
import type { Employee, Punch } from "../types";
import type { DayOverride } from "./attendance";

export const DEFAULT_SERVER_URL = "https://aminofarms.replit.app";

interface DeviceConfig {
  key: "sync-config";
  serverUrl: string;
  token: string;
}

export interface SyncStatus {
  key: "sync-status";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export async function getDeviceConfig(): Promise<{ serverUrl: string; token: string } | null> {
  const cfg = await get<DeviceConfig>("meta", "sync-config");
  if (!cfg?.token) return null;
  return { serverUrl: cfg.serverUrl || DEFAULT_SERVER_URL, token: cfg.token };
}

export async function setDeviceConfig(serverUrl: string, token: string): Promise<void> {
  await put<DeviceConfig>("meta", { key: "sync-config", serverUrl: serverUrl || DEFAULT_SERVER_URL, token });
}

export async function clearDeviceConfig(): Promise<void> {
  await put<DeviceConfig>("meta", { key: "sync-config", serverUrl: DEFAULT_SERVER_URL, token: "" });
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const s = await get<SyncStatus>("meta", "sync-status");
  return s ?? { key: "sync-status", lastAttemptAt: null, lastSuccessAt: null, lastError: null };
}

async function setSyncStatus(patch: Partial<SyncStatus>): Promise<void> {
  const current = await getSyncStatus();
  await put<SyncStatus>("meta", { ...current, ...patch, key: "sync-status" });
}

interface CachedRoles {
  key: "cached-roles";
  roles: string[];
}

/** Role names last seen from the server, for the enrollment form's suggestions. */
export async function getCachedRoles(): Promise<string[]> {
  const cached = await get<CachedRoles>("meta", "cached-roles");
  return cached?.roles ?? [];
}

async function setCachedRoles(roles: string[]): Promise<void> {
  await put<CachedRoles>("meta", { key: "cached-roles", roles });
}

async function getUnsyncedEmployees(): Promise<Employee[]> {
  const all = await getAll<Employee>("employees");
  return all.filter((e) => !e.syncedAt);
}
async function getUnsyncedPunches(): Promise<Punch[]> {
  const all = await getAll<Punch>("punches");
  return all.filter((p) => !p.syncedAt);
}
async function getUnsyncedOverrides(): Promise<DayOverride[]> {
  const all = await getAll<DayOverride>("overrides");
  return all.filter((o) => !!o.status && !o.syncedAt);
}

export async function pendingCounts(): Promise<{ employees: number; punches: number; overrides: number; total: number }> {
  const [employees, punches, overrides] = await Promise.all([
    getUnsyncedEmployees(),
    getUnsyncedPunches(),
    getUnsyncedOverrides(),
  ]);
  return {
    employees: employees.length,
    punches: punches.length,
    overrides: overrides.length,
    total: employees.length + punches.length + overrides.length,
  };
}

let syncing = false;

export async function syncNow(): Promise<{ ok: boolean; error?: string; synced?: number }> {
  if (syncing) return { ok: false, error: "Sync already in progress" };
  const config = await getDeviceConfig();
  if (!config) return { ok: false, error: "No device token configured yet" };

  syncing = true;
  await setSyncStatus({ lastAttemptAt: Date.now() });
  try {
    const [employees, punches, overrides] = await Promise.all([
      getUnsyncedEmployees(),
      getUnsyncedPunches(),
      getUnsyncedOverrides(),
    ]);

    const nothingPending = employees.length === 0 && punches.length === 0 && overrides.length === 0;
    const rolesCached = (await getCachedRoles()).length > 0;
    if (nothingPending && rolesCached) {
      await setSyncStatus({ lastSuccessAt: Date.now(), lastError: null });
      return { ok: true, synced: 0 };
    }

    const payload = {
      workers: employees.map((e) => ({
        id: e.id,
        name: e.name,
        aadharNumber: e.aadharNumber,
        photoDataUrl: e.photoDataUrl,
        faceDescriptor: e.faceDescriptor,
        role: e.role,
        isActive: e.isActive,
      })),
      punches: punches.map((p) => ({
        id: p.id,
        employeeId: p.employeeId,
        punchType: p.punchType,
        punchDate: p.punchDate,
        timestamp: p.timestamp,
        method: p.method,
        matchScore: p.matchScore,
      })),
      overrides: overrides.map((o) => ({
        key: o.key,
        employeeId: o.employeeId,
        date: o.date,
        status: o.status,
        note: o.note,
        setAt: o.setAt,
      })),
    };

    const res = await fetch(`${config.serverUrl}/api/wages/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Server responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    const responseBody = await res.json().catch(() => null);
    if (Array.isArray(responseBody?.roles)) {
      await setCachedRoles(responseBody.roles);
    }

    const now = Date.now();
    await Promise.all([
      ...employees.map((e) => put("employees", { ...e, syncedAt: now })),
      ...punches.map((p) => put("punches", { ...p, syncedAt: now })),
      ...overrides.map((o) => put("overrides", { ...o, syncedAt: now })),
    ]);

    await setSyncStatus({ lastSuccessAt: now, lastError: null });
    return { ok: true, synced: employees.length + punches.length + overrides.length };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await setSyncStatus({ lastError: message });
    return { ok: false, error: message };
  } finally {
    syncing = false;
  }
}

/** Fire-and-forget — call after a punch/enrollment so it shows up centrally
 * quickly without waiting for the next scheduled tick. Never throws. */
export function syncSoon(): void {
  syncNow().catch(() => {});
}

// ── Adaptive scheduler ──────────────────────────────────────────────────────
// Frequent (every 10s) during shift-start/shift-end rush windows when many
// workers are punching in quick succession and near-live visibility matters;
// spaced out (every 5 min) the rest of the time to save battery/data.
const RUSH_WINDOWS: [number, number, number, number][] = [
  [7, 45, 8, 30],
  [16, 45, 17, 30],
];
const RUSH_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 5 * 60_000;

function isRushWindow(d: Date): boolean {
  const mins = d.getHours() * 60 + d.getMinutes();
  return RUSH_WINDOWS.some(([fromH, fromM, toH, toM]) => {
    const from = fromH * 60 + fromM;
    const to = toH * 60 + toM;
    return mins >= from && mins <= to;
  });
}

function nextDelayMs(): number {
  return isRushWindow(new Date()) ? RUSH_INTERVAL_MS : IDLE_INTERVAL_MS;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function scheduleNext() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await syncNow();
    scheduleNext(); // recomputed each tick so crossing a rush-window boundary re-paces immediately
  }, nextDelayMs());
}

/** Call once, on app start. Safe to call more than once — no-ops after the first. */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  scheduleNext();
  window.addEventListener("online", () => syncNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNow();
  });
}
