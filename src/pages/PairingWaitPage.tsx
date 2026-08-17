import { useEffect, useState } from "react";
import {
  pollPairing,
  applyPairingApproved,
  clearPendingPairing,
  getPendingPairing,
  setPairingNotice,
} from "../lib/pairing";
import { getDeviceModelAndOs, getAppVersion } from "../lib/device";

const POLL_INTERVAL_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 5_000;

export default function PairingWaitPage({
  pendingId,
  onCancel,
}: {
  pendingId: string;
  onCancel: () => void;
}) {
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [versionName, setVersionName] = useState<string>("");
  const [codeTail, setCodeTail] = useState<string>("");
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let active = true;
    getDeviceModelAndOs().then((d) => {
      if (active && d.deviceModel) setDeviceLabel(d.deviceModel);
    });
    getAppVersion().then((v) => {
      if (active) setVersionName(v.versionName);
    });
    getPendingPairing().then((p) => {
      if (active && p?.code) setCodeTail(p.code.slice(-4));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPollAt = 0;
    let inFlight = false;

    async function poll() {
      if (cancelled || done || inFlight) return;
      inFlight = true;
      lastPollAt = Date.now();
      try {
        const result = await pollPairing(pendingId);
        if (cancelled) return;
        if (result.status === "approved") {
          // Persist the token first, then sync — the token is delivered
          // exactly once, so this must run to completion. applyPairingApproved
          // emits pairing-change at the very end, which App.tsx uses to land
          // on Punch with the restored data already in place.
          done = true;
          await applyPairingApproved(result);
          return;
        }
        if (result.status === "rejected" || result.status === "expired") {
          done = true;
          setPairingNotice(result.reason);
          await clearPendingPairing();
          if (!cancelled) onCancel();
          return;
        }
        // pending / rate_limited / error → keep waiting
      } finally {
        inFlight = false;
        if (!cancelled && !done) timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    function scheduleResume() {
      // Never faster than MIN_POLL_INTERVAL_MS, but poll promptly on resume.
      if (done || cancelled) return;
      const elapsed = Date.now() - lastPollAt;
      if (timer) clearTimeout(timer);
      const delay = Math.max(0, MIN_POLL_INTERVAL_MS - elapsed);
      timer = setTimeout(poll, delay);
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") scheduleResume();
    };
    const onFocus = () => scheduleResume();

    poll();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [pendingId, onCancel]);

  async function handleCancel() {
    setCancelling(true);
    await clearPendingPairing();
    onCancel();
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="w-12 h-12 rounded-full border-4 border-brand border-t-transparent animate-spin" />

      <div>
        <h1 className="text-lg font-semibold text-gray-800">Waiting for approval from the office.</h1>
        <p className="text-sm text-gray-500 mt-1">Keep this screen open — pairing completes automatically.</p>
      </div>

      <div className="text-xs text-gray-500 space-y-1">
        {deviceLabel && <p>Device: <span className="text-gray-700">{deviceLabel}</span></p>}
        {codeTail && <p>Code ending in <span className="font-mono text-gray-700">{codeTail}</span></p>}
        {versionName && <p>App version {versionName}</p>}
      </div>

      <button
        onClick={handleCancel}
        disabled={cancelling}
        className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 disabled:opacity-50"
      >
        {cancelling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  );
}
