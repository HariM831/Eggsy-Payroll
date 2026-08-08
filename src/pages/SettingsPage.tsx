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
  type SyncStatus,
  type PayrollSyncStatus,
} from "../lib/sync";
import { checkBackup, restoreFromBackup, type BackupMetadata } from "../lib/backup";
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
    }
    setStatus(s);
    setCounts(c);
    setPayrollStatus(ps);
    setPayrollCounts(pc);
    
    if (config?.token) {
      setBackupMeta(await checkBackup(config.token));
    } else {
      setBackupMeta(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    // Only check backup if we have a saved config with a deviceId
    getDeviceConfig().then(config => {
      if (config?.deviceId) {
        checkBackup(config.deviceId).then(setBackupMeta);
      } else {
        setBackupMeta(null);
      }
    });
  }, [savedToken]);

  async function handleVerifyToken() {
    const finalUrl = serverUrl.trim() || DEFAULT_SERVER_URL;
    const finalToken = token.trim() || savedToken;
    if (!finalToken) return;

    setVerifying(true);
    setVerifyResult(null);
    try {
      const devInfo = await getDeviceInfo(finalUrl, finalToken);
      await setDeviceConfig(finalUrl, finalToken, devInfo.deviceId);
      
      const bMeta = await checkBackup(devInfo.deviceId);
      setBackupMeta(bMeta);
      
      setVerifyResult({ ok: true, message: `Verified device: ${devInfo.name}.` });
      setToken(""); // Clear input, it is now saved
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
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
      const restored = resWages.restored ?? 0;
      const message = restored > 0
        ? `Synced successfully! Restored ${restored} worker${restored === 1 ? "" : "s"} from the server.`
        : "Synced successfully!";
      setVerifyResult({ ok: true, message });
    } else {
      const err = resWages.error || resPayroll.error || "Sync failed";
      setVerifyResult({ ok: false, message: `Sync failed: ${err}` });
    }
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

  async function handleRestoreBackup() {
    const config = await getDeviceConfig();
    if (!config?.deviceId) return;
    
    setRestoringBackup(true);
    try {
      const res = await restoreFromBackup(config.deviceId);
      setRestoreResult({ 
        ok: true, 
        message: `Restored ${res.employees} workers, ${res.punches} punches, and ${res.overrides} corrections from local backup.` 
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
              onChange={(e) => setServerUrl(e.target.value)}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <label className="text-sm block">
            Device token
            {savedToken && !token && (
              <p className="text-xs text-green-600 mb-1">A token is saved (hidden). Enter a new one to replace it.</p>
            )}
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={savedToken ? "•••• saved — paste a new token to replace" : "Paste the token from Wages > Devices"}
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
          <h2 className="text-sm font-medium text-gray-700">Local Backup</h2>
          
          <div className="text-sm text-gray-600">
            {backupMeta?.exists ? (
              <>
                <p className="text-green-600 font-medium">✓ Backup found for this token</p>
                {backupMeta.savedAt && <p>Saved: {formatWhen(backupMeta.savedAt)}</p>}
              </>
            ) : (
              <p>No local backup found for this device.</p>
            )}
          </div>
          
          <button
            onClick={handleRestoreBackup}
            disabled={!backupMeta?.exists || counts.employees > 0 || restoringBackup}
            className="w-full py-2.5 rounded-lg border border-brand text-brand text-sm font-medium disabled:opacity-50"
            title={counts.employees > 0 ? "Cannot restore when app already has workers" : undefined}
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
              {restoreResult.ok ? "✓ " : "✕ "}
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
