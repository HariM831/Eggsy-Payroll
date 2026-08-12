import { useEffect, useState } from "react";
import {
  DEFAULT_SERVER_URL,
  getDeviceConfig,
  setDeviceConfig,
  clearDeviceConfig,
  getSyncStatus,
  pendingCounts,
  syncNow,
  getPayrollSyncStatus,
  payrollPendingCounts,
  syncPayrollNow,
  getDeviceInfo,
  peekWorkerRosterCount,
  wipeLocalDeviceData,
  type SyncStatus,
  type PayrollSyncStatus,
} from "../lib/sync";
import { checkBackup, restoreFromBackup, saveBackup, type BackupMetadata, type RestoreResult } from "../lib/backup";
import { checkLocationNow, getLocationStatus, type LocationStatus } from "../lib/location";
import { lock } from "../lib/pin";

function formatWhen(ts: number | null): string {
  if (!ts) return "never";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return new Date(ts).toLocaleString("en-IN");
}

/** Shows only enough of a token to tell devices apart at a glance — not a
 * secret reveal, this device's actual token is already sitting in its own
 * local storage regardless. */
function maskToken(t: string): string {
  if (t.length <= 4) return "•".repeat(t.length);
  return `••••••••${t.slice(-4)}`;
}

export default function SettingsPage() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [token, setToken] = useState("");
  const [savedToken, setSavedToken] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [counts, setCounts] = useState({ employees: 0, punches: 0, overrides: 0, total: 0 });
  const [syncing, setSyncing] = useState(false);
  const [saved, setSaved] = useState(false);

  // Payroll (salaried employee) sync state
  const [payrollStatus, setPayrollStatus] = useState<PayrollSyncStatus | null>(null);
  const [payrollCounts, setPayrollCounts] = useState({ punches: 0 });
  const [payrollSyncing, setPayrollSyncing] = useState(false);

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [backupMeta, setBackupMeta] = useState<BackupMetadata | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Whatever the punch flow's own location attempts have found so far (may
  // be null — nobody's opened Punch yet this session), refreshed on demand
  // by handleCheckLocation below.
  const [locationStatus, setLocationStatus] = useState<LocationStatus | null>(getLocationStatus());
  const [checkingLocation, setCheckingLocation] = useState(false);

  // The device's own name from the server (e.g. "Nabil gate") — shown next
  // to the masked token so it's obvious which physical device/identity is
  // currently configured, without having to re-verify to find out.
  const [deviceName, setDeviceName] = useState<string | null>(null);

  async function refresh() {
    const [config, s, c, ps, pc] = await Promise.all([
      getDeviceConfig(),
      getSyncStatus(),
      pendingCounts(),
      getPayrollSyncStatus(),
      payrollPendingCounts(),
    ]);
    if (config) {
      setServerUrl(config.serverUrl);
      setSavedToken(config.token);
      // Load the name from saved config — no server call needed
      if (config.deviceName) setDeviceName(config.deviceName);
    }
    setStatus(s);
    setCounts(c);
    setPayrollStatus(ps);
    setPayrollCounts(pc);
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    // Re-derive backup status whenever the saved token changes
    getDeviceConfig().then((config) => {
      if (!config?.deviceId) {
        setBackupMeta(null);
        return;
      }
      checkBackup(config.deviceId).then(setBackupMeta);
    });
  }, [savedToken]);

  async function handleVerifyToken() {
    const finalUrl = serverUrl.trim() || DEFAULT_SERVER_URL;
    const finalToken = token.trim() || savedToken;
    if (!finalToken) return;

    // A genuinely different token means a different device/farm identity —
    // not just re-verifying the one already configured.
    const isSwitch = !!savedToken && finalToken !== savedToken;

    setVerifying(true);
    setVerifyResult(null);
    try {
      const devInfo = await getDeviceInfo(finalUrl, finalToken);

      if (isSwitch) {
        const [pending, payrollPending] = await Promise.all([pendingCounts(), payrollPendingCounts()]);
        const unsyncedTotal = pending.total + payrollPending.punches;
        if (unsyncedTotal > 0) {
          const proceed = confirm(
            `This device has ${unsyncedTotal} unsynced record${unsyncedTotal === 1 ? "" : "s"} that ` +
            `${unsyncedTotal === 1 ? "hasn't" : "haven't"} been pushed yet. Switching to "${devInfo.name}" ` +
            `will permanently discard ${unsyncedTotal === 1 ? "it" : "them"}. Continue?`
          );
          if (!proceed) { setVerifying(false); return; }
        }

        let backupCount: number | null = null;
        try {
          backupCount = await peekWorkerRosterCount(finalUrl, finalToken);
        } catch {
          // best-effort — a failed preview shouldn't block the switch itself
        }
        const backupLine = backupCount === null
          ? `Switching to "${devInfo.name}".`
          : backupCount > 0
            ? `Switching to "${devInfo.name}" — ${backupCount} worker${backupCount === 1 ? "" : "s"} will be restored from the server.`
            : `Switching to "${devInfo.name}" — no workers found on the server for this token yet.`;
        if (!confirm(`${backupLine}\n\nThis device's current local data will be cleared first (already-synced data is safe on the server). Continue?`)) {
          setVerifying(false);
          return;
        }

        await wipeLocalDeviceData();
      }

      await setDeviceConfig(finalUrl, finalToken, devInfo.deviceId, devInfo.name);

      const bMeta = await checkBackup(devInfo.deviceId);
      setBackupMeta(bMeta);
      setDeviceName(devInfo.name);

      setVerifyResult({ ok: true, message: `Verified as: ${devInfo.name}.` });
      setToken("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);

      // Auto-backup whatever we have so far (full backup happens after next sync)
      saveBackup(devInfo.deviceId);
      refresh();
    } catch (err: any) {
      setVerifyResult({ ok: false, message: `Verification failed: ${err.message}` });
    } finally {
      setVerifying(false);
    }
  }

  async function handleSaveAndSync() {
    setVerifying(true);
    setVerifyResult(null);

    const [resWages, resPayroll] = await Promise.all([
      syncNow(),
      syncPayrollNow(),
    ]);

    setVerifying(false);
    if (resWages.ok && resPayroll.ok) {
      const workers = resWages.restored ?? 0;
      const punches = resWages.restoredPunches ?? 0;
      const parts = [
        workers > 0 ? `${workers} worker${workers === 1 ? "" : "s"}` : null,
        punches > 0 ? `${punches} attendance record${punches === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      const message = parts.length > 0
        ? `Synced successfully! Restored ${parts.join(" and ")} from the server.`
        : "Synced successfully!";
      setVerifyResult({ ok: true, message });
    } else {
      const err = resWages.error || resPayroll.error || "Sync failed";
      setVerifyResult({ ok: false, message: `Sync failed: ${err}` });
    }
    // Backup is refreshed after sync (syncNow already saves it internally;
    // but we also call it here so payroll data is captured too in case
    // syncPayrollNow ran after syncNow's internal saveBackup).
    const config = await getDeviceConfig();
    if (config?.deviceId) saveBackup(config.deviceId);
    refresh();
  }

  async function handleSyncNow() {
    setSyncing(true);
    await syncNow();
    setSyncing(false);
    refresh();
  }

  async function handleForget() {
    if (!confirm("Remove the saved device token? All sync (Wages and Payroll) will stop until a new one is entered.")) return;
    await clearDeviceConfig();
    setSavedToken(null);
    setVerifyResult(null);
    refresh();
  }

  async function handlePayrollSyncNow() {
    setPayrollSyncing(true);
    await syncPayrollNow();
    setPayrollSyncing(false);
    refresh();
  }

  async function handleCheckLocation() {
    setCheckingLocation(true);
    const result = await checkLocationNow();
    setLocationStatus(result);
    setCheckingLocation(false);
  }

  async function handleRestoreBackup() {
    const config = await getDeviceConfig();
    if (!config?.deviceId) return;
    
    setRestoringBackup(true);
    try {
      const res: RestoreResult = await restoreFromBackup(config.deviceId);
      const parts = [
        res.employees > 0 ? `${res.employees} workers` : null,
        res.punches > 0 ? `${res.punches} wage punches` : null,
        res.overrides > 0 ? `${res.overrides} corrections` : null,
        res.payrollEmployees > 0 ? `${res.payrollEmployees} payroll employees` : null,
        res.payrollPunches > 0 ? `${res.payrollPunches} payroll punches` : null,
        res.metaKeys > 0 ? `${res.metaKeys} settings` : null,
      ].filter(Boolean);
      setRestoreResult({ 
        ok: true, 
        message: `Restored${parts.length > 0 ? ": " + parts.join(", ") : " — nothing to restore"}.` 
      });
      refresh();
    } catch (err: any) {
      setRestoreResult({ ok: false, message: `Failed to restore: ${err.message}` });
    } finally {
      setRestoringBackup(false);
    }
  }

  return (
    <div className="p-4 pb-24">
      <h1 className="text-lg font-semibold mb-4">Settings</h1>

      <div className="max-w-sm space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-gray-700">Sync to Amino Farms</h2>
          <p className="text-xs text-gray-400">
            One token covers both Wages workers and payroll employees — it's the same
            physical device either way. Create/revoke it from Payroll &gt; Wages &gt; Devices.
          </p>

          <label className="text-sm block">
            Server URL
            <input
              value={serverUrl}
              readOnly
              disabled
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-400 cursor-not-allowed"
            />
          </label>

          <label className="text-sm block">
            Device token
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={savedToken ? "Paste a new token to replace" : "Paste the token from Wages > Devices"}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-mono"
              type="password"
            />
          </label>

          <div className="flex gap-2 flex-col sm:flex-row">
            <button
              onClick={handleVerifyToken}
              disabled={(!token.trim() && !savedToken) || verifying}
              className="flex-1 py-2.5 rounded-lg bg-gray-100 border text-gray-800 text-sm font-medium disabled:opacity-50"
            >
              {verifying ? "Verifying…" : saved ? "Verified!" : "Verify Token"}
            </button>
            <button
              onClick={handleSaveAndSync}
              disabled={!savedToken || verifying}
              className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-50"
            >
              Save & Sync
            </button>
            {savedToken && (
              <button onClick={handleForget} className="px-3 py-2.5 rounded-lg border text-sm text-red-600">
                Forget
              </button>
            )}
          </div>

          {/* Persistent device identity badge */}
          {savedToken && !token && (deviceName || savedToken) && (
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-brand/10 text-brand text-xs font-bold shrink-0">
                {(deviceName ?? "?")[0].toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-800 truncate">{deviceName ?? "Unknown device"}</p>
                <p className="text-[10px] text-gray-400 font-mono">{maskToken(savedToken)}</p>
              </div>
              <span className="ml-auto text-[10px] text-green-600 font-medium shrink-0">● Active</span>
            </div>
          )}

          {verifying && (
            <div className="p-3 bg-blue-50 border border-blue-200 text-blue-700 text-xs rounded-lg flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></span>
              Verifying connection with server…
            </div>
          )}

          {!verifying && verifyResult && (
            <div
              className={`p-3 border text-xs rounded-lg font-medium ${
                verifyResult.ok
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {verifyResult.ok ? "✓ " : "✕ "}
              {verifyResult.message}
            </div>
          )}
        </section>

        <section className="space-y-3 border-t pt-4">
          <h2 className="text-sm font-medium text-gray-700">Location</h2>
          <p className="text-xs text-gray-400">
            Punches carry GPS the same way the browser kiosk does. If this shows an error,
            that's exactly why recent punches from this device have no location attached.
          </p>

          {locationStatus && (
            <div
              className={`text-sm ${locationStatus.ok ? "text-green-600" : "text-red-600"}`}
            >
              {locationStatus.ok ? "✓ " : "✕ "}
              {locationStatus.message}
              <span className="text-gray-400"> · {formatWhen(locationStatus.at)}</span>
            </div>
          )}

          <button
            onClick={handleCheckLocation}
            disabled={checkingLocation}
            className="w-full py-2.5 rounded-lg border border-brand text-brand text-sm font-medium disabled:opacity-50"
          >
            {checkingLocation ? "Checking…" : "Check location"}
          </button>
        </section>

        <section className="space-y-3 border-t pt-4">
          <h2 className="text-sm font-medium text-gray-700">Local Backup</h2>
          
          <div className="text-sm text-gray-600 space-y-1">
            {backupMeta?.exists ? (
              <>
                <p className="text-green-600 font-medium">Backup found for this device</p>
                {backupMeta.savedAt && <p>Saved: {formatWhen(backupMeta.savedAt)}</p>}
                {backupMeta.employees !== undefined && (
                  <p className="text-xs text-gray-500">
                    Contents: {backupMeta.employees} workers, {backupMeta.punches} wage punches,{" "}
                    {backupMeta.payrollEmployees ?? 0} payroll employees, {backupMeta.payrollPunches ?? 0} payroll punches,{" "}
                    {backupMeta.metaKeys ?? 0} settings
                  </p>
                )}
              </>
            ) : (
              <p className="text-gray-400">
                No backup yet — one is saved automatically after verifying your token and syncing.
              </p>
            )}
          </div>

          <p className="text-xs text-gray-500 bg-gray-50 border rounded-lg p-2.5 leading-relaxed">
            Backup is saved automatically to the phone's Documents folder — it survives uninstall.
            Your data is encrypted so only this device can read it.
          </p>

          <button
            onClick={handleRestoreBackup}
            disabled={!backupMeta?.exists || counts.employees > 0 || restoringBackup}
            className="w-full py-2.5 rounded-lg border border-brand text-brand text-sm font-medium disabled:opacity-50"
            title={counts.employees > 0 ? "Restore works best on a fresh install (no existing workers)" : undefined}
          >
            {restoringBackup ? "Restoring…" : "Restore from Backup"}
          </button>

          {restoreResult && (
            <div
              className={`p-3 border text-xs rounded-lg font-medium ${
                restoreResult.ok
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {restoreResult.message}
            </div>
          )}
        </section>

        <section className="space-y-2 border-t pt-4">
          <h2 className="text-sm font-medium text-gray-700">Wages sync status</h2>
          <div className="text-sm text-gray-600 space-y-1">
            <p>Last attempt: {formatWhen(status?.lastAttemptAt ?? null)}</p>
            <p>Last success: {formatWhen(status?.lastSuccessAt ?? null)}</p>
            <p>
              Pending: {counts.total === 0 ? "nothing — fully synced" : `${counts.total} record${counts.total === 1 ? "" : "s"}`}
              {counts.total > 0 && (
                <span className="text-gray-400"> ({counts.employees} workers, {counts.punches} punches, {counts.overrides} corrections)</span>
              )}
            </p>
            {status?.lastError && <p className="text-red-600">Last error: {status.lastError}</p>}
          </div>
          <button
            onClick={handleSyncNow}
            disabled={syncing || !savedToken}
            className="w-full py-2.5 rounded-lg border border-brand text-brand text-sm font-medium disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </section>

        <section className="space-y-2 border-t pt-4">
          <h2 className="text-sm font-medium text-gray-700">Payroll sync status</h2>
          <div className="text-sm text-gray-600 space-y-1">
            <p>Last attempt: {formatWhen(payrollStatus?.lastAttemptAt ?? null)}</p>
            <p>Last success: {formatWhen(payrollStatus?.lastSuccessAt ?? null)}</p>
            <p>
              Pending: {payrollCounts.punches === 0 ? "nothing — fully synced" : `${payrollCounts.punches} punch${payrollCounts.punches === 1 ? "" : "es"}`}
            </p>
            {payrollStatus?.lastError && <p className="text-red-600">Last error: {payrollStatus.lastError}</p>}
          </div>
          <button
            onClick={handlePayrollSyncNow}
            disabled={payrollSyncing || !savedToken}
            className="w-full py-2.5 rounded-lg border border-brand text-brand text-sm font-medium disabled:opacity-50"
          >
            {payrollSyncing ? "Syncing…" : "Sync now"}
          </button>
        </section>

        <section className="border-t pt-4">
          <button onClick={() => { lock(); window.location.reload(); }} className="text-sm text-gray-500 underline">
            Lock this device
          </button>
        </section>
      </div>
    </div>
  );
}
