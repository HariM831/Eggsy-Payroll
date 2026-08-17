// Pairing: an 8-character code typed on the phone becomes a device token,
// replacing the old "paste a long token" flow. The contract is fixed — see
// §3 of the pairing plan; do not rename fields or invent status strings.
//
// The device is the source of truth for wage workers, punches and day
// overrides, so pairing (and revocation) never clears those stores. It only
// writes/clears the sync-config token.
import {
  apiBase,
  DEFAULT_SERVER_URL,
  fetchWithTimeout,
  getDeviceConfig,
  setDeviceConfig,
  clearDeviceConfig,
  syncNow,
  syncPayrollNow,
  wipeLocalDeviceData,
} from "./sync";
import { get, put, del } from "./db";
import { getInstallId, getDeviceModelAndOs, getAppVersion } from "./device";
import { getCachedLocation } from "./location";

export const PAIRING_CHANGE_EVENT = "pairing-change";

function notifyPairingChanged(): void {
  window.dispatchEvent(new Event(PAIRING_CHANGE_EVENT));
}

// ── Code handling ──────────────────────────────────────────────────────────

/** "ab3k-9qx7" / " ab3k9qx7 " / "AB3K-9QX7" all become "AB3K9QX7". */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

/** "AB3K9QX7" → "AB3K-9QX7". */
export function formatCode(normalized: string): string {
  const clean = normalizeCode(normalized);
  return clean.length <= 4 ? clean : `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

// ── Persisted pending request ──────────────────────────────────────────────

interface PendingPairing {
  key: "pairing-pending";
  pendingId: string;
  code: string;
}

/** The pending request survives an app kill so the wait screen can resume
 * polling and still show the code's last 4 characters. */
export async function getPendingPairing(): Promise<{ pendingId: string; code: string } | null> {
  const p = await get<PendingPairing>("meta", "pairing-pending");
  return p?.pendingId ? { pendingId: p.pendingId, code: p.code } : null;
}

export async function setPendingPairing(pendingId: string, code: string): Promise<void> {
  await put<PendingPairing>("meta", { key: "pairing-pending", pendingId, code });
  notifyPairingChanged();
}

async function clearPendingPairingInternal(): Promise<void> {
  await del("meta", "pairing-pending");
}

export async function clearPendingPairing(): Promise<void> {
  await clearPendingPairingInternal();
  notifyPairingChanged();
}

// ── Last paired identity ───────────────────────────────────────────────────
// Deliberately NOT stored in sync-config: clearDeviceConfig() drops deviceId,
// so after an unpair there would be no way to tell that the next pairing is a
// different device identity. This marker outlives an unpair and is only ever
// used for that comparison (see applyPairingApproved).

interface LastDeviceMarker {
  key: "last-paired-device-id";
  deviceId: string;
}

async function getLastPairedDeviceId(): Promise<string | null> {
  const m = await get<LastDeviceMarker>("meta", "last-paired-device-id");
  return m?.deviceId ?? null;
}

async function setLastPairedDeviceId(deviceId: string): Promise<void> {
  await put<LastDeviceMarker>("meta", { key: "last-paired-device-id", deviceId });
}

// ── Module-level notice (survives the wait screen unmounting) ──────────────
// The wait screen sets this on reject/expire so the code input can show WHY
// pairing failed once the person is back looking at it.

let pairingNotice: string | null = null;

export function setPairingNotice(message: string | null): void {
  pairingNotice = message;
}

export function getPairingNotice(): string | null {
  return pairingNotice;
}

async function pairingServerUrl(): Promise<string> {
  return (await getDeviceConfig())?.serverUrl || DEFAULT_SERVER_URL;
}

// ── §3.1 claim ─────────────────────────────────────────────────────────────

export type PairClaimResult =
  | { status: "approved"; token: string; deviceId: string; name: string; mode: "new" | "replace" }
  | { status: "pending"; pendingId: string }
  | { status: "invalid" }
  | { status: "rate_limited" }
  | { status: "error"; message: string };

export async function claimPairingCode(rawCode: string): Promise<PairClaimResult> {
  const code = normalizeCode(rawCode);
  const serverUrl = await pairingServerUrl();

  const [installId, device, version] = await Promise.all([
    getInstallId(),
    getDeviceModelAndOs(),
    getAppVersion(),
  ]);

  // Only code + installId are required; the rest ride along when we have
  // them. Location is best-effort from whatever the punch flow already
  // cached — never prompt for it, never block on it.
  const body: Record<string, unknown> = { code, installId };
  if (device.deviceModel) body.deviceModel = device.deviceModel;
  if (device.osVersion) body.osVersion = device.osVersion;
  body.appVersionCode = version.versionCode;
  const loc = getCachedLocation();
  if (loc?.latitude != null && loc?.longitude != null) {
    body.lat = loc.latitude;
    body.lng = loc.longitude;
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${apiBase(serverUrl)}/api/wages/devices/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    return { status: "error", message: err?.message ?? String(err) };
  }

  if (res.status === 429) return { status: "rate_limited" };
  if (!res.ok) return { status: "error", message: `Server responded ${res.status}` };

  const data = await res.json().catch(() => null);
  if (!data) return { status: "error", message: "Unexpected response from server" };

  if (data.status === "approved") {
    return {
      status: "approved",
      token: data.token,
      deviceId: data.deviceId,
      name: data.name,
      mode: data.mode === "replace" ? "replace" : "new",
    };
  }
  if (data.status === "pending") return { status: "pending", pendingId: data.pendingId };
  return { status: "invalid" };
}

// ── §3.2 poll ──────────────────────────────────────────────────────────────

export type PairPollResult =
  | { status: "pending" }
  | { status: "approved"; token: string; deviceId: string; name: string; mode: "new" | "replace" }
  | { status: "rejected"; reason: string }
  | { status: "expired"; reason: string }
  | { status: "rate_limited" }
  | { status: "error"; message: string };

export async function pollPairing(pendingId: string): Promise<PairPollResult> {
  const serverUrl = await pairingServerUrl();

  let res: Response;
  try {
    res = await fetchWithTimeout(`${apiBase(serverUrl)}/api/wages/devices/pair/${encodeURIComponent(pendingId)}`);
  } catch (err: any) {
    return { status: "error", message: err?.message ?? String(err) };
  }

  if (res.status === 429) return { status: "rate_limited" };
  if (!res.ok) return { status: "error", message: `Server responded ${res.status}` };

  const data = await res.json().catch(() => null);
  if (!data) return { status: "error", message: "Unexpected response from server" };

  switch (data.status) {
    case "pending":
      return { status: "pending" };
    case "approved":
      return {
        status: "approved",
        token: data.token,
        deviceId: data.deviceId,
        name: data.name,
        mode: data.mode === "replace" ? "replace" : "new",
      };
    case "rejected":
      return { status: "rejected", reason: data.reason ?? "Rejected by the office" };
    case "expired":
      return { status: "expired", reason: data.reason ?? "Code expired" };
    default:
      return { status: "error", message: "Unexpected response from server" };
  }
}

// ── §5.5 apply approval ────────────────────────────────────────────────────

/** Persist the token, clear the pending request, then await the first sync
 * BEFORE handing off — in "replace" mode that first sync is what restores the
 * previous phone's workers and attendance history. The caller must not render
 * the next screen until this resolves. */
export async function applyPairingApproved(payload: {
  token: string;
  deviceId: string;
  name: string;
  mode: "new" | "replace";
}): Promise<void> {
  const serverUrl = (await getDeviceConfig())?.serverUrl || DEFAULT_SERVER_URL;

  // Pairing into a DIFFERENT device identity than this phone last held means
  // the local stores belong to someone else's device — sync would otherwise
  // re-push another farm's workers under this new deviceId. Wipe first.
  //   - "replace" returns the same deviceId, so nothing is wiped: that is
  //     exactly the restore case, and the first sync pulls the data back.
  //   - A first-ever pairing has no marker, so workers enrolled offline
  //     before pairing are kept — they do belong to this phone.
  const lastDeviceId = await getLastPairedDeviceId();
  if (lastDeviceId && lastDeviceId !== payload.deviceId) {
    await wipeLocalDeviceData();
  }

  await setDeviceConfig(serverUrl, payload.token, payload.deviceId, payload.name);
  await setLastPairedDeviceId(payload.deviceId);
  // Clear the pending request silently — we only emit pairing-change once, at
  // the very end, so the app keeps showing the wait screen through the first
  // sync instead of flipping to the normal tree (and an empty roster) early.
  await clearPendingPairingInternal();
  // Await both scopes, one at a time (not Promise.all — see syncAllNow's
  // comment in sync.ts), so a replace restores wage workers AND the payroll
  // roster before the app hands back to the Punch screen. This is the
  // heaviest possible restore (a full roster in each scope, first sync ever
  // on this token), so running them concurrently here would be the worst
  // place to double the peak memory.
  await syncNow();
  await syncPayrollNow();
  notifyPairingChanged();
}

/** Unpair: drop the token (local stores are kept — see §2). */
export async function unpair(): Promise<void> {
  await clearDeviceConfig();
  await clearPendingPairing();
  setPairingNotice(null);
  notifyPairingChanged();
}
