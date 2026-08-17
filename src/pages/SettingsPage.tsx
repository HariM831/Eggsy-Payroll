import { useEffect, useState } from "react";
import {
  DEFAULT_SERVER_URL,
  getDeviceConfig,
  getSyncStatus,
  pendingCounts,
  syncNow,
  getPayrollSyncStatus,
  payrollPendingCounts,
  syncPayrollNow,
  type SyncStatus,
  type PayrollSyncStatus,
} from "../lib/sync";
import {
  claimPairingCode,
  applyPairingApproved,
  setPendingPairing,
  unpair,
  normalizeCode,
  formatCode,
  getPairingNotice,
  setPairingNotice,
} from "../lib/pairing";
import { checkBackup, restoreFromBackup, type BackupMetadata, type RestoreResult } from "../lib/backup";
import { checkLocationNow, getLocationStatus, type LocationStatus } from "../lib/location";
import { getAppVersion } from "../lib/device";
import { lock } from "../lib/pin";

function formatWhen(ts: number | null): string {
  if (!ts) return "never";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return new Date(ts).toLocaleString("en-IN");
}

export default function SettingsPage() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [paired, setPaired] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [counts, setCounts] = useState({ employees: 0, punches: 0, overrides: 0, total: 0 });
  const [syncing, setSyncing] = useState(false);

  // Payroll (salaried employee) sync state
  const [payrollStatus, setPayrollStatus] = useState<PayrollSyncStatus | null>(null);
  const [payrollCounts, setPayrollCounts] = useState({ punches: 0 });
  const [payrollSyncing, setPayrollSyncing] = useState(false);

  // Pairing
  const [pairCode, setPairCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairResult, setPairResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [backupMeta, setBackupMeta] = useState<BackupMetadata | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [locationStatus, setLocationStatus] = useState<LocationStatus | null>(getLocationStatus());
  const [checkingLocation, setCheckingLocation] = useState(false);

  const [appVersion, setAppVersion] = useState<string>("");

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
      setPaired(true);
      if (config.deviceName) setDeviceName(config.deviceName);
    } else {
      setPaired(false);
      setDeviceName(null);
    }
    setStatus(s);
    setCounts(c);
    setPayrollStatus(ps);
    setPayrollCounts(pc);
  }

  useEffect(() => {
    // Show any reason the wait screen left behind (reject/expire) on the code
    // input, exactly once.
    const notice = getPairingNotice();
    if (notice) {
      setPairResult({ ok: false, message: notice });
      setPairingNotice(null);
    }
    getAppVersion().then((v) => setAppVersion(`v${v.versionName} (build ${v.versionCode})`));
    refresh();
  }, []);

  useEffect(() => {
    getDeviceConfig().then((config) => {
      if (!config?.deviceId) {
        setBackupMeta(null);
        return;
      }
      checkBackup(config.deviceId).then(setBackupMeta);
    });
  }, [paired]);

  function handleCodeChange(raw: string) {
    const normalized = normalizeCode(raw);
    setPairCode(formatCode(normalized));
  }

  async function handlePair() {
    const normalized = normalizeCode(pairCode);
    if (normalized.length !== 8) {
      setPairResult({ ok: false, message: "Enter the full 8-character code." });
      return;
    }

    setPairing(true);
    setPairResult(null);
    try {
      const result = await claimPairingCode(normalized);
      if (result.status === "approved") {
        await applyPairingApproved(result);
        setPairResult({
          ok: true,
          message:
            result.mode === "replace"
              ? `Paired as ${result.name}. This phone has taken over ${result.name} — its workers are being restored.`
              : `Paired as ${result.name}.`,
        });
        setPairCode("");
        refresh();
      } else if (result.status === "pending") {
        // Persist the pending request; App.tsx now shows the wait screen.
        await setPendingPairing(result.pendingId, normalized);
      } else if (result.status === "invalid") {
        setPairResult({ ok: false, message: "That code didn't work. Ask the office for a new one." });
      } else if (result.status === "rate_limited") {
        setPairResult({ ok: false, message: "Too many attempts, wait a few minutes." });
      } else {
        setPairResult({ ok: false, message: result.message });
      }
    } finally {
      setPairing(false);
    }
  }

  async function handleUnpair() {
    if (!confirm("Unpair this phone? Sync will stop until you pair again. Enrolled workers and punches stay on the phone.")) return;
    await unpair();
    setPairResult(null);
    refresh();
  }

  async function handleSyncNow() {
    setSyncing(true);
    await syncNow();
    setSyncing(false);
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
        message: `Restored${parts.length > 0 ? ": " + parts.join(", ") : " — nothing to restore"}.`,
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
          <h2 className="text-sm font-medium text-gray-700">Device & connection</h2>
          <p className="text-xs text-gray-400">
            Pair this phone with the 8-character code from the office (Payroll &gt; Wages &gt;
            Devices). One pairing covers both Wages workers and payroll employees.
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

          {paired ? (
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-brand/10 text-brand text-xs font-bold shrink-0">
                {(deviceName ?? "?")[0].toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-800 truncate">{deviceName ?? "Paired device"}</p>
                <p className="text-[10px] text-gray-400">Paired</p>
              </div>
              <button
                onClick={handleUnpair}
                className="ml-auto px-3 py-1.5 rounded-lg border text-sm text-red-600"
              >
                Unpair
              </button>
            </div>
          ) : (
            <>
              <label className="text-sm block">
                Pairing code
                <input
                  value={pairCode}
                  onChange={(e) => handleCodeChange(e.target.value)}
                  placeholder="AB3K-9QX7"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-mono tracking-widest"
                />
              </label>

              <button
                onClick={handlePair}
                disabled={normalizeCode(pairCode).length !== 8 || pairing}
                className="w-full py-2.5 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-50"
              >
                {pairing ? "Pairing…" : "Pair device"}
              </button>
            </>
          )}

          {pairing && (
            <div className="p-3 bg-blue-50 border border-blue-200 text-blue-700 text-xs rounded-lg flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></span>
              Contacting the office…
            </div>
          )}

          {!pairing && pairResult && (
            <div
              className={`p-3 border text-xs rounded-lg font-medium ${
                pairResult.ok
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {pairResult.ok ? "✓ " : "✕ "}
              {pairResult.message}
            </div>
          )}
        </section>

        <section className="space-y-3 border-t pt-4">
          <h2 className="text-sm font-medium text-gray-700">Diagnostics</h2>
          <p className="text-xs text-gray-400">
            Punches carry GPS the same way the browser kiosk does. If this shows an error,
            that's exactly why recent punches from this device have no location attached.
          </p>

          {appVersion && (
            <p className="text-sm text-gray-600">
              App version <span className="text-gray-400">·</span> {appVersion}
            </p>
          )}

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
          <h2 className="text-sm font-medium text-gray-700">Backup & recovery</h2>

          <div className="text-sm text-gray-600 space-y-1">
            {backupMeta?.exists ? (
              backupMeta.readable ? (
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
                <>
                  <p className="text-amber-600 font-medium">Backup file found but inaccessible</p>
                  {backupMeta.savedAt && <p>Saved: {formatWhen(backupMeta.savedAt)}</p>}
                  <p className="text-xs text-amber-600">
                    This happens when the app was reinstalled with a different signing key.
                    Re-pair the phone and sync to restore your data from the server instead.
                  </p>
                </>
              )
            ) : (
              <p className="text-gray-400">
                No backup yet — one is saved automatically after pairing and syncing.
              </p>
            )}
          </div>

          <p className="text-xs text-gray-500 bg-gray-50 border rounded-lg p-2.5 leading-relaxed">
            Backup is saved automatically to the phone's Documents folder — it survives uninstall.
            Your data is encrypted so only this device can read it.
          </p>

          <button
            onClick={handleRestoreBackup}
            disabled={!backupMeta?.readable || counts.employees > 0 || restoringBackup}
            className="w-full py-2.5 rounded-lg border border-brand text-brand text-sm font-medium disabled:opacity-50"
            title={
              !backupMeta?.readable
                ? "Backup is inaccessible due to signing key change — sync from server instead"
                : counts.employees > 0
                  ? "Restore works best on a fresh install (no existing workers)"
                  : undefined
            }
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
          <h2 className="text-sm font-medium text-gray-700">Sync — Wages</h2>
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
            disabled={syncing || !paired}
            className="w-full py-2.5 rounded-lg border border-brand text-brand text-sm font-medium disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </section>

        <section className="space-y-2 border-t pt-4">
          <h2 className="text-sm font-medium text-gray-700">Sync — Payroll</h2>
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
            disabled={payrollSyncing || !paired}
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
