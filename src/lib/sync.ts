// Opportunistic sync to the central Amino Farms server — an outbox pattern,
// not a live connection. Punching still works with zero connectivity; this
// module just pushes whatever accumulated locally whenever a connection
// happens to be available, so HR doesn't have to manually export/share data.
//
// Mostly one-way: device -> server for identity and attendance. The device
// is the source of truth for worker identity (name/aadhar/photo/face/role)
// and all attendance data — every sync pushes local changes up. Two
// exceptions come back down, both piggybacked on the sync response rather
// than needing their own poll: role *names* (the server owns the rate card,
// Amino Farms Wages > Roles — the rate itself is never sent here), and, via
// pullWorkerRoster() below, the full worker roster for THIS token, so a
// reinstalled app / replacement phone can restore itself by re-entering the
// same token instead of every worker being re-enrolled by hand. See
// server/routes/wages.ts on the Amino Farms side for the receiving end.
import { getAll, get, put, del, clear } from "./db";
import { localDate } from "./id";
import { getAppVersion } from "./device";
import type { Employee, Punch, PayrollEmployee, PayrollPunch, LastPunchToday, PunchType, PunchMethod } from "../types";
import type { DayOverride } from "./attendance";
import { saveBackup } from "./backup";

export const DEFAULT_SERVER_URL = "https://aminofarms.replit.app";

// In dev (npm run dev), route through Vite's own /api proxy (see
// vite.config.ts) instead of hitting the server directly from the browser.
// The Amino Farms server rejects any request carrying a browser Origin
// header, so a direct browser fetch always fails with "Failed to fetch"
// even with a valid token — going through the proxy keeps the request
// same-origin in the browser, and the proxy strips Origin before
// forwarding server-side. Production builds still call serverUrl directly.
export function apiBase(serverUrl: string): string {
  return import.meta.env.DEV ? "" : serverUrl;
}

/** A 401 carrying { code: "device_revoked" } from any authenticated endpoint —
 * the server has revoked this device's token. Distinct from a network error or
 * any other 401 so a flaky connection can never unpair a working phone. */
export class DeviceRevokedError extends Error {
  constructor() {
    super("Device revoked");
    this.name = "DeviceRevokedError";
  }
}

/** Dispatched on the window when the device has been revoked mid-sync, so the
 * app can drop to the pairing state while keeping every local store. */
export const DEVICE_REVOKED_EVENT = "device-revoked";
/** Dispatched on the window after version info has been refreshed, so the
 * update banner can re-evaluate without waiting out a scheduler tick. */
export const VERSION_INFO_EVENT = "version-info-updated";

/** fetch() wrapper for authenticated endpoints: passes the request through
 * unchanged except that a revoked-device 401 is surfaced as a
 * DeviceRevokedError. Callers still check `!res.ok` for everything else. */
async function authedFetch(serverUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${apiBase(serverUrl)}${path}`, init);
  if (res.status === 401) {
    const body = await res.json().catch(() => null);
    if (body && (body.code === "device_revoked" || body.error === "Device revoked")) {
      throw new DeviceRevokedError();
    }
  }
  return res;
}

interface DeviceConfig {
  key: "sync-config";
  serverUrl: string;
  token: string;
  deviceId?: string;
  deviceName?: string;
}

export interface SyncStatus {
  key: "sync-status";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export async function getDeviceConfig(): Promise<{ serverUrl: string; token: string; deviceId?: string; deviceName?: string } | null> {
  const cfg = await get<DeviceConfig>("meta", "sync-config");
  if (!cfg?.token) return null;
  return { serverUrl: cfg.serverUrl || DEFAULT_SERVER_URL, token: cfg.token, deviceId: cfg.deviceId, deviceName: cfg.deviceName };
}

export async function setDeviceConfig(serverUrl: string, token: string, deviceId?: string, deviceName?: string): Promise<void> {
  await put<DeviceConfig>("meta", { key: "sync-config", serverUrl: serverUrl || DEFAULT_SERVER_URL, token, deviceId, deviceName });
}

export async function clearDeviceConfig(): Promise<void> {
  await put<DeviceConfig>("meta", { key: "sync-config", serverUrl: DEFAULT_SERVER_URL, token: "", deviceId: undefined, deviceName: undefined });
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

interface ServerWorker {
  id: string;
  name: string;
  aadharNumber: string;
  photoDataUrl: string;
  faceDescriptor: number[];
  role: string | null;
  isActive: boolean;
  createdAt: string;
}

export async function getDeviceInfo(
  serverUrl: string,
  token: string,
): Promise<{
  deviceId: string;
  name: string;
  latestVersionCode?: number;
  minVersionCode?: number;
  apkUrl?: string | null;
}> {
  const res = await authedFetch(serverUrl, "/api/wages/device-sync/info", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Device info fetch failed ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

// ── Update/version banner data ─────────────────────────────────────────────
// The server tells us (on the existing device-sync/info endpoint) what the
// newest build is, what the minimum still-supported build is, and where to
// get the APK. Stored in meta so the Punch screen can compute the banner
// from local state without a network round-trip on mount.

interface VersionInfo {
  key: "version-info";
  latestVersionCode: number;
  minVersionCode: number;
  apkUrl: string | null;
  fetchedAt: number;
}

export interface VersionInfoView {
  latestVersionCode: number;
  minVersionCode: number;
  apkUrl: string | null;
}

export async function getVersionInfo(): Promise<VersionInfoView | null> {
  const v = await get<VersionInfo>("meta", "version-info");
  return v
    ? { latestVersionCode: v.latestVersionCode, minVersionCode: v.minVersionCode, apkUrl: v.apkUrl }
    : null;
}

/** Best-effort refresh of the update-banner numbers after a sync/info fetch.
 * Never throws — a missing/older server just leaves the stored info stale. */
async function refreshVersionInfo(): Promise<void> {
  const config = await getDeviceConfig();
  if (!config) return;
  try {
    const info = await getDeviceInfo(config.serverUrl, config.token);
    await put<VersionInfo>("meta", {
      key: "version-info",
      latestVersionCode: info.latestVersionCode ?? 0,
      minVersionCode: info.minVersionCode ?? 0,
      apkUrl: info.apkUrl ?? null,
      fetchedAt: Date.now(),
    });
    window.dispatchEvent(new Event(VERSION_INFO_EVENT));
  } catch {
    // best-effort — an old server or transient error just keeps the last values
  }
}

/** Blocks sync (never punching) when the server has declared this build too
 * old. Returns a user-facing reason, or null when sync may proceed. */
async function tooOldToSync(): Promise<string | null> {
  const info = await getVersionInfo();
  if (!info || info.minVersionCode <= 0) return null;
  const current = await getAppVersion();
  if (info.minVersionCode > current.versionCode) {
    return "This app version is too old to sync — update the phone. Punches are still saved locally.";
  }
  return null;
}

/** Read-only preview of how many workers exist on the server for a token,
 * WITHOUT writing anything locally — for showing "N workers will be
 * restored" before committing to a token switch. Uses the same roster
 * endpoint as pullWorkerRoster(); best-effort callers should catch. */
export async function peekWorkerRosterCount(serverUrl: string, token: string): Promise<number> {
  const res = await authedFetch(serverUrl, "/api/wages/device-sync/workers", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Roster check responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const workers = await res.json();
  return Array.isArray(workers) ? workers.length : 0;
}

/** Clears every store scoped to "this device's identity" — Wages workers,
 * punches, corrections, the cached role list, and the payroll roster
 * mirror + its punches (payroll data is keyed by the same shared token,
 * see the module comment below on syncPayrollNow). Called when the saved
 * token is being replaced with a genuinely different one, so a previous
 * farm/device's data never lingers mixed in with the new one. Does NOT
 * touch the PIN or the device config itself — callers overwrite that
 * separately right after. */
export async function wipeLocalDeviceData(): Promise<void> {
  await Promise.all([
    clear("employees"),
    clear("punches"),
    clear("overrides"),
    clear("payrollEmployees"),
    clear("payrollPunches"),
  ]);
  await Promise.all([
    del("meta", "cached-roles"),
    // so the new identity restores its own attendance history
    del("meta", "attendance-pulled"),
  ]);
}

/** How far back attendance history is restored. The server caps the window
 * at 90 days (MAX_HISTORY_DAYS in server/routes/wages.ts) — asking for more
 * is a 400, so these two must stay in step. */
const HISTORY_DAYS = 90;

interface AttendancePulledFlag {
  key: "attendance-pulled";
  deviceId: string;
  at: number;
}

interface ServerPunch {
  id: string;
  employeeId: string;
  punchType: PunchType;
  punchDate: string;
  timestamp: number;
  method: PunchMethod;
  matchScore: number | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
}

interface ServerOverride {
  key: string;
  employeeId: string;
  date: string;
  status: "P" | "A";
  note: string;
  setAt: number;
}

/** Restores attendance history so a rebuilt device's Calendar isn't blank —
 * the roster pull brings back WHO was enrolled, this brings back their days.
 *
 * Deliberately not run on every sync like the roster is: this is up to 90
 * days of punches for every worker, and the scheduler ticks every 10s during
 * a rush window. It runs once per device instead, tracked by the
 * "attendance-pulled" meta flag, which wipeLocalDeviceData() clears so a
 * token switch re-pulls for the new identity.
 *
 * Punches restored this way have no capturedPhotoDataUrl — the per-punch
 * audit photo is never uploaded, so it only ever exists on the phone that
 * took it (the local encrypted backup does preserve it; see backup.ts). */
async function pullAttendanceHistory(serverUrl: string, token: string): Promise<{ punches: number; overrides: number }> {
  const to = localDate();
  const from = localDate(new Date(Date.now() - (HISTORY_DAYS - 1) * 86_400_000));

  const res = await authedFetch(
    serverUrl,
    `/api/wages/device-sync/punches?from=${from}&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Attendance pull responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const body = await res.json();
  const serverPunches: ServerPunch[] = Array.isArray(body?.punches) ? body.punches : [];
  const serverOverrides: ServerOverride[] = Array.isArray(body?.overrides) ? body.overrides : [];

  // Same rule as the roster pull: a local row with no syncedAt is a pending
  // local change that hasn't reached the server yet, so it must win.
  const localPunches = new Map((await getAll<Punch>("punches")).map((p) => [p.id, p]));
  const localOverrides = new Map((await getAll<DayOverride>("overrides")).map((o) => [o.key, o]));

  const punchesToWrite = serverPunches.filter((p) => {
    const local = localPunches.get(p.id);
    return !local || local.syncedAt;
  });
  const overridesToWrite = serverOverrides.filter((o) => {
    const local = localOverrides.get(o.key);
    return !local || local.syncedAt;
  });

  const pulledAt = Date.now();
  await Promise.all([
    ...punchesToWrite.map((p) =>
      put<Punch>("punches", {
        id: p.id,
        employeeId: p.employeeId,
        punchType: p.punchType,
        timestamp: p.timestamp,
        punchDate: p.punchDate,
        method: p.method,
        matchScore: p.matchScore,
        capturedPhotoDataUrl: null, // never uploaded — see the note above
        note: null,
        latitude: p.latitude,
        longitude: p.longitude,
        accuracy: p.accuracy,
        syncedAt: pulledAt, // came from the server, so already synced by definition
      }),
    ),
    ...overridesToWrite.map((o) =>
      put<DayOverride>("overrides", {
        key: o.key,
        employeeId: o.employeeId,
        date: o.date,
        status: o.status,
        note: o.note ?? "",
        setAt: o.setAt,
        syncedAt: pulledAt,
      }),
    ),
  ]);

  return { punches: punchesToWrite.length, overrides: overridesToWrite.length };
}

/** Device-recovery pull: re-downloads every worker this token has ever
 * enrolled (see server/routes/wages.ts device-sync/workers on the Amino
 * Farms side). Lets a reinstalled app / replacement phone restore its
 * roster just by re-entering the same token, instead of re-enrolling
 * everyone by hand. Best-effort — failing here must not fail a sync whose
 * push already succeeded, so callers swallow the error themselves.
 * Returns how many workers were written locally. */
async function pullWorkerRoster(serverUrl: string, token: string): Promise<number> {
  const res = await authedFetch(serverUrl, "/api/wages/device-sync/workers", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Roster pull responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const serverWorkers: ServerWorker[] = await res.json();

  const localById = new Map((await getAll<Employee>("employees")).map((e) => [e.id, e]));
  // A local row with no syncedAt is a pending local edit (new enrollment or
  // an edit not yet pushed) — the pull must never clobber it.
  const toWrite = serverWorkers.filter((w) => {
    const local = localById.get(w.id);
    return !local || local.syncedAt;
  });

  const pulledAt = Date.now();
  await Promise.all(
    toWrite.map((w) =>
      put<Employee>("employees", {
        id: w.id,
        name: w.name,
        aadharNumber: w.aadharNumber,
        photoDataUrl: w.photoDataUrl,
        faceDescriptor: w.faceDescriptor,
        role: w.role,
        isActive: w.isActive,
        createdAt: new Date(w.createdAt).getTime(),
        syncedAt: pulledAt, // pulled from the server, so already synced by definition
      }),
    ),
  );
  return toWrite.length;
}

/** Everything this device restores FROM the server: the worker roster, plus
 * — once per device — the attendance history behind it. Best-effort
 * throughout: a restore that fails must never turn a sync whose push already
 * succeeded into a reported failure, so each half swallows its own error and
 * simply reports having restored nothing. */
async function restoreFromServer(
  serverUrl: string,
  token: string,
  deviceId?: string,
): Promise<{ workers: number; punches: number; overrides: number }> {
  const restored = { workers: 0, punches: 0, overrides: 0 };

  try {
    restored.workers = await pullWorkerRoster(serverUrl, token);
  } catch {
    // best-effort — see above
  }

  // Attendance is up to 90 days of punches across every worker, so unlike the
  // roster it must not ride every scheduler tick (10s during a rush window).
  // Once per device is enough: nothing else writes this device's history.
  try {
    const flag = await get<AttendancePulledFlag>("meta", "attendance-pulled");
    if (!flag || (deviceId && flag.deviceId !== deviceId)) {
      const pulled = await pullAttendanceHistory(serverUrl, token);
      restored.punches = pulled.punches;
      restored.overrides = pulled.overrides;
      await put<AttendancePulledFlag>("meta", { key: "attendance-pulled", deviceId: deviceId ?? "", at: Date.now() });
    }
  } catch {
    // best-effort — the flag stays unset, so the next sync simply retries
  }

  return restored;
}

export async function syncNow(): Promise<{
  ok: boolean;
  error?: string;
  synced?: number;
  /** workers written back from the server's roster */
  restored?: number;
  /** punches written back from the server's attendance history */
  restoredPunches?: number;
}> {
  if (syncing) return { ok: false, error: "Sync already in progress" };
  const config = await getDeviceConfig();
  if (!config) return { ok: false, error: "No device token configured yet" };

  const tooOld = await tooOldToSync();
  if (tooOld) {
    await setSyncStatus({ lastAttemptAt: Date.now(), lastError: tooOld });
    return { ok: false, error: tooOld };
  }

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
      // Nothing to push, but still restore in case this is a reinstalled /
      // replacement device that needs its workers and history back.
      const restored = await restoreFromServer(config.serverUrl, config.token, config.deviceId);
      await setSyncStatus({ lastSuccessAt: Date.now(), lastError: null });
      if (config.deviceId) saveBackup(config.deviceId);
      return { ok: true, synced: 0, restored: restored.workers, restoredPunches: restored.punches };
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
        latitude: p.latitude,
        longitude: p.longitude,
        accuracy: p.accuracy,
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

    const res = await authedFetch(config.serverUrl, "/api/wages/sync", {
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

    // Device recovery: pull back this token's workers (and, once, their
    // history) only AFTER the push, so anything pending locally reaches the
    // server before the server's copy is read back. A no-op on a normal
    // device; on a reinstalled app / replacement phone it repopulates
    // everything. Best-effort — see restoreFromServer.
    const restored = await restoreFromServer(config.serverUrl, config.token, config.deviceId);

    await setSyncStatus({ lastSuccessAt: now, lastError: null });
    if (config.deviceId) saveBackup(config.deviceId);
    return {
      ok: true,
      synced: employees.length + punches.length + overrides.length,
      restored: restored.workers,
      restoredPunches: restored.punches,
    };
  } catch (err: any) {
    if (err instanceof DeviceRevokedError) {
      await clearDeviceConfig();
      window.dispatchEvent(new Event(DEVICE_REVOKED_EVENT));
      return { ok: false, error: "Device revoked" };
    }
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

// ── Payroll (salaried employee) sync ────────────────────────────────────────
// Uses the SAME device token as Wages above (getDeviceConfig) — it's one
// physical phone running one app, so one token, created/revoked from the
// existing Payroll > Wages > Devices page. Sync status is tracked
// separately from Wages below, though, since the two are independent
// network calls that can succeed/fail independently even with the same
// token (useful for telling which side broke). Two-way in a different
// sense than Wages: the roster (identity, enrollment, face descriptors) is
// server -> device only, since payroll employees are server-owned and this
// device can't enroll them; only punches go device -> server. See
// server/routes/payroll-attendance-sync.ts.

export interface PayrollSyncStatus {
  key: "payroll-sync-status";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export async function getPayrollSyncStatus(): Promise<PayrollSyncStatus> {
  const s = await get<PayrollSyncStatus>("meta", "payroll-sync-status");
  return s ?? { key: "payroll-sync-status", lastAttemptAt: null, lastSuccessAt: null, lastError: null };
}

async function setPayrollSyncStatus(patch: Partial<PayrollSyncStatus>): Promise<void> {
  const current = await getPayrollSyncStatus();
  await put<PayrollSyncStatus>("meta", { ...current, ...patch, key: "payroll-sync-status" });
}

async function getUnsyncedPayrollPunches(): Promise<PayrollPunch[]> {
  const all = await getAll<PayrollPunch>("payrollPunches");
  return all.filter((p) => !p.syncedAt);
}

export async function payrollPendingCounts(): Promise<{ punches: number }> {
  const punches = await getUnsyncedPayrollPunches();
  return { punches: punches.length };
}

interface RosterEmployee {
  id: string;
  empCode: string;
  name: string;
  department: string | null;
  designation: string | null;
  faceDescriptor: number[] | null;
  recentEmbeddings: number[][];
  /** Server's view of today's latest punch — see LastPunchToday in types.ts
   * and nextPayrollPunchType() in punches.ts. */
  lastPunchToday?: LastPunchToday | null;
}

let payrollSyncing = false;

export async function syncPayrollNow(): Promise<{ ok: boolean; error?: string; synced?: number }> {
  if (payrollSyncing) return { ok: false, error: "Sync already in progress" };
  const config = await getDeviceConfig(); // shared with Wages — see module comment above
  if (!config) return { ok: false, error: "No device token configured yet" };

  const tooOld = await tooOldToSync();
  if (tooOld) {
    await setPayrollSyncStatus({ lastAttemptAt: Date.now(), lastError: tooOld });
    return { ok: false, error: tooOld };
  }

  payrollSyncing = true;
  await setPayrollSyncStatus({ lastAttemptAt: Date.now() });
  try {
    // Pull the roster first — the punch flow can't match a payroll
    // employee's face at all until it has descriptors to compare against.
    const rosterRes = await authedFetch(config.serverUrl, "/api/attendance-sync/employees", {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!rosterRes.ok) {
      const body = await rosterRes.text().catch(() => "");
      throw new Error(`Roster fetch responded ${rosterRes.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const roster: RosterEmployee[] = await rosterRes.json();
    const now = Date.now();
    await Promise.all(
      roster.map((e) => put<PayrollEmployee>("payrollEmployees", { ...e, cachedAt: now })),
    );

    const punches = await getUnsyncedPayrollPunches();
    if (punches.length > 0) {
      const payload = {
        punches: punches.map((p) => ({
          id: p.id,
          employeeId: p.employeeId,
          punchType: p.punchType,
          punchDate: p.punchDate,
          timestamp: p.timestamp,
          method: p.method,
          matchScore: p.matchScore,
          latitude: p.latitude,
          longitude: p.longitude,
          accuracy: p.accuracy,
        })),
      };
      const res = await authedFetch(config.serverUrl, "/api/attendance-sync/punches", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Server responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }

      // The server relabels a punch whose in/out it can tell was wrong —
      // this device decides in/out from what it can see, which offline
      // excludes the kiosk and any other phone. Adopt those corrections so
      // the local record matches what was actually recorded centrally, and
      // so the next punch alternates from the corrected state rather than
      // re-deriving the same mistake. See server/routes/payroll-attendance-sync.ts.
      const body = await res.json().catch(() => null);
      const corrected: { id: string; to: PunchType }[] = Array.isArray(body?.corrected) ? body.corrected : [];
      const correctedById = new Map(corrected.map((c) => [c.id, c.to]));

      await Promise.all(
        punches.map((p) => {
          const to = correctedById.get(p.id);
          return put("payrollPunches", { ...p, punchType: to ?? p.punchType, syncedAt: now });
        }),
      );
    }

    await setPayrollSyncStatus({ lastSuccessAt: now, lastError: null });
    if (config.deviceId) saveBackup(config.deviceId);
    return { ok: true, synced: punches.length };
  } catch (err: any) {
    if (err instanceof DeviceRevokedError) {
      await clearDeviceConfig();
      window.dispatchEvent(new Event(DEVICE_REVOKED_EVENT));
      return { ok: false, error: "Device revoked" };
    }
    const message = err?.message ?? String(err);
    await setPayrollSyncStatus({ lastError: message });
    return { ok: false, error: message };
  } finally {
    payrollSyncing = false;
  }
}

/** Fire-and-forget — call after a payroll punch so it shows up centrally
 * quickly without waiting for the next scheduled tick. Never throws. */
export function syncPayrollSoon(): void {
  syncPayrollNow().catch(() => {});
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

/** Runs both sync scopes together — they share one device token (see module
 * comment above), so both fire once it's configured; before that, both are
 * cheap early-return no-ops. Saves a single backup after both complete. */
function syncAllNow(): Promise<unknown> {
  return Promise.all([syncNow(), syncPayrollNow()]).then(async () => {
    const config = await getDeviceConfig();
    if (config?.deviceId) saveBackup(config.deviceId);
    // Refresh update-banner numbers on the same cadence as the syncs, so the
    // banner shows up as soon as the server knows a newer build exists.
    refreshVersionInfo().catch(() => {});
  });
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await syncAllNow();
    scheduleNext(); // recomputed each tick so crossing a rush-window boundary re-paces immediately
  }, nextDelayMs());
}

/** Call once, on app start. Safe to call more than once — no-ops after the first. */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  scheduleNext();
  window.addEventListener("online", () => syncAllNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncAllNow();
  });
}
