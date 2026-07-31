import { useEffect, useState } from "react";
import {
  DEFAULT_SERVER_URL,
  getDeviceConfig,
  setDeviceConfig,
  clearDeviceConfig,
  getSyncStatus,
  pendingCounts,
  syncNow,
  getPayrollDeviceConfig,
  setPayrollDeviceConfig,
  clearPayrollDeviceConfig,
  getPayrollSyncStatus,
  payrollPendingCounts,
  syncPayrollNow,
  type SyncStatus,
  type PayrollSyncStatus,
} from "../lib/sync";
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

  // Payroll (salaried employee) sync — an independent device-token
  // registration from Wages above; a phone may hold either token, both, or
  // neither. See src/lib/sync.ts.
  const [payrollServerUrl, setPayrollServerUrl] = useState(DEFAULT_SERVER_URL);
  const [payrollToken, setPayrollToken] = useState("");
  const [payrollSavedToken, setPayrollSavedToken] = useState<string | null>(null);
  const [payrollStatus, setPayrollStatus] = useState<PayrollSyncStatus | null>(null);
  const [payrollCounts, setPayrollCounts] = useState({ punches: 0 });
  const [payrollSyncing, setPayrollSyncing] = useState(false);
  const [payrollSaved, setPayrollSaved] = useState(false);

  async function refresh() {
    const [config, s, c, payrollConfig, ps, pc] = await Promise.all([
      getDeviceConfig(),
      getSyncStatus(),
      pendingCounts(),
      getPayrollDeviceConfig(),
      getPayrollSyncStatus(),
      payrollPendingCounts(),
    ]);
    if (config) {
      setServerUrl(config.serverUrl);
      setSavedToken(config.token);
    }
    setStatus(s);
    setCounts(c);
    if (payrollConfig) {
      setPayrollServerUrl(payrollConfig.serverUrl);
      setPayrollSavedToken(payrollConfig.token);
    }
    setPayrollStatus(ps);
    setPayrollCounts(pc);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSaveConfig() {
    if (!token.trim() && !savedToken) return;
    await setDeviceConfig(serverUrl.trim() || DEFAULT_SERVER_URL, token.trim() || savedToken!);
    setSaved(true);
    setToken("");
    setTimeout(() => setSaved(false), 2000);
    refresh();
  }

  async function handleSyncNow() {
    setSyncing(true);
    await syncNow();
    setSyncing(false);
    refresh();
  }

  async function handleForget() {
    if (!confirm("Remove the saved device token? Syncing will stop until a new one is entered.")) return;
    await clearDeviceConfig();
    setSavedToken(null);
    refresh();
  }

  async function handleSavePayrollConfig() {
    if (!payrollToken.trim() && !payrollSavedToken) return;
    await setPayrollDeviceConfig(payrollServerUrl.trim() || DEFAULT_SERVER_URL, payrollToken.trim() || payrollSavedToken!);
    setPayrollSaved(true);
    setPayrollToken("");
    setTimeout(() => setPayrollSaved(false), 2000);
    refresh();
  }

  async function handlePayrollSyncNow() {
    setPayrollSyncing(true);
    await syncPayrollNow();
    setPayrollSyncing(false);
    refresh();
  }

  async function handleForgetPayroll() {
    if (!confirm("Remove the saved payroll device token? Payroll sync will stop until a new one is entered.")) return;
    await clearPayrollDeviceConfig();
    setPayrollSavedToken(null);
    refresh();
  }

  return (
    <div className="p-4 pb-24">
      <h1 className="text-lg font-semibold mb-4">Settings</h1>

      <div className="max-w-sm space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-gray-700">Sync to Amino Farms</h2>

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

          <div className="flex gap-2">
            <button
              onClick={handleSaveConfig}
              disabled={!token.trim() && !savedToken}
              className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-50"
            >
              {saved ? "Saved" : "Save"}
            </button>
            {savedToken && (
              <button onClick={handleForget} className="px-3 py-2.5 rounded-lg border text-sm text-red-600">
                Forget
              </button>
            )}
          </div>
        </section>

        <section className="space-y-2 border-t pt-4">
          <h2 className="text-sm font-medium text-gray-700">Sync status</h2>
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

        <section className="space-y-3 border-t pt-4">
          <h2 className="text-sm font-medium text-gray-700">Payroll sync</h2>
          <p className="text-xs text-gray-400">
            For salaried employees, separate from Wages above. This device only pulls the
            roster (read-only) and pushes punches — enrollment stays in Amino Farms.
          </p>

          <label className="text-sm block">
            Server URL
            <input
              value={payrollServerUrl}
              onChange={(e) => setPayrollServerUrl(e.target.value)}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <label className="text-sm block">
            Device token
            {payrollSavedToken && !payrollToken && (
              <p className="text-xs text-green-600 mb-1">A token is saved (hidden). Enter a new one to replace it.</p>
            )}
            <input
              value={payrollToken}
              onChange={(e) => setPayrollToken(e.target.value)}
              placeholder={payrollSavedToken ? "•••• saved — paste a new token to replace" : "Paste the token from Payroll > Attendance > Devices"}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-mono"
              type="password"
            />
          </label>

          <div className="flex gap-2">
            <button
              onClick={handleSavePayrollConfig}
              disabled={!payrollToken.trim() && !payrollSavedToken}
              className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-50"
            >
              {payrollSaved ? "Saved" : "Save"}
            </button>
            {payrollSavedToken && (
              <button onClick={handleForgetPayroll} className="px-3 py-2.5 rounded-lg border text-sm text-red-600">
                Forget
              </button>
            )}
          </div>

          <div className="text-sm text-gray-600 space-y-1 pt-1">
            <p>Last attempt: {formatWhen(payrollStatus?.lastAttemptAt ?? null)}</p>
            <p>Last success: {formatWhen(payrollStatus?.lastSuccessAt ?? null)}</p>
            <p>
              Pending: {payrollCounts.punches === 0 ? "nothing — fully synced" : `${payrollCounts.punches} punch${payrollCounts.punches === 1 ? "" : "es"}`}
            </p>
            {payrollStatus?.lastError && <p className="text-red-600">Last error: {payrollStatus.lastError}</p>}
          </div>
          <button
            onClick={handlePayrollSyncNow}
            disabled={payrollSyncing || !payrollSavedToken}
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
