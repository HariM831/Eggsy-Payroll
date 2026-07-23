import { useEffect, useState } from "react";
import {
  DEFAULT_SERVER_URL,
  getDeviceConfig,
  setDeviceConfig,
  clearDeviceConfig,
  getSyncStatus,
  pendingCounts,
  syncNow,
  type SyncStatus,
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

  async function refresh() {
    const [config, s, c] = await Promise.all([getDeviceConfig(), getSyncStatus(), pendingCounts()]);
    if (config) {
      setServerUrl(config.serverUrl);
      setSavedToken(config.token);
    }
    setStatus(s);
    setCounts(c);
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

        <section className="border-t pt-4">
          <button onClick={() => { lock(); window.location.reload(); }} className="text-sm text-gray-500 underline">
            Lock this device
          </button>
        </section>
      </div>
    </div>
  );
}
