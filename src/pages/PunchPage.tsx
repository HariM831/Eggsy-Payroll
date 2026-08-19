import { useEffect, useMemo, useRef, useState } from "react";
import CameraCapture, { type CaptureResult } from "../components/CameraCapture";
import { listEmployees } from "../lib/employees";
import { listPayrollEmployees } from "../lib/payrollEmployees";
import { recordPunch, recordPayrollPunch } from "../lib/punches";
import { syncSoon, syncPayrollSoon, getSyncStatus, getPayrollSyncStatus, getDeviceConfig, getVersionInfo, VERSION_INFO_EVENT } from "../lib/sync";
import { getAppVersion } from "../lib/device";
import { PAIRING_CHANGE_EVENT } from "../lib/pairing";
import { primeLocation, getCachedLocation } from "../lib/location";
import { findBestMatchInGalleries, DEFAULT_MATCH_THRESHOLD, MIN_MATCH_MARGIN, type MatchGallery } from "../lib/face";
import { getByIndex } from "../lib/db";
import { localDate } from "../lib/id";
import type { Employee, Punch, PayrollEmployee, PayrollPunch } from "../types";

const DUPE_WINDOW_MS = 10_000;

type Outcome =
  | { kind: "success"; origin: "wage"; employee: Employee; punch: Punch }
  | { kind: "success"; origin: "payroll"; employee: PayrollEmployee; punch: PayrollPunch }
  | { kind: "no-match"; score: number }
  | { kind: "ambiguous"; topName: string; score: number; secondScore: number }
  | { kind: "duplicate"; name: string; punchType: string; secondsAgo: number };

function playPunchSound() {
  try {
    const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch { /* audio blocked — best effort */ }
}

function vibratePunch() {
  try {
    if (navigator.vibrate) navigator.vibrate(150);
  } catch { /* nop */ }
}

function formatWhenAgo(ts: number | null): string {
  if (!ts) return "never";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export default function PunchPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [wageEmployees, setWageEmployees] = useState<Employee[]>([]);
  const [payrollEmployees, setPayrollEmployees] = useState<PayrollEmployee[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [captureKey, setCaptureKey] = useState(0);

  const [wagePresent, setWagePresent] = useState(0);
  const [payrollPresent, setPayrollPresent] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const [paired, setPaired] = useState(false);
  const [update, setUpdate] = useState<{ latestVersionCode: number; apkUrl: string | null } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      const config = await getDeviceConfig();
      if (active) setPaired(!!config);
    }
    load();
    const onChange = () => load();
    window.addEventListener(PAIRING_CHANGE_EVENT, onChange);
    return () => {
      active = false;
      window.removeEventListener(PAIRING_CHANGE_EVENT, onChange);
    };
  }, []);

  // Update banner: compute once on mount AND on every version-info refresh so
  // it doesn't wait out the first scheduler tick.
  useEffect(() => {
    let active = true;
    async function compute() {
      const [version, info] = await Promise.all([getAppVersion(), getVersionInfo()]);
      if (!active) return;
      if (info && info.latestVersionCode > version.versionCode) {
        setUpdate({ latestVersionCode: info.latestVersionCode, apkUrl: info.apkUrl });
      } else {
        setUpdate(null);
      }
    }
    compute();
    const onVersion = () => compute();
    window.addEventListener(VERSION_INFO_EVENT, onVersion);
    return () => {
      active = false;
      window.removeEventListener(VERSION_INFO_EVENT, onVersion);
    };
  }, []);

  useEffect(() => {
    listEmployees().then(setWageEmployees);
    listPayrollEmployees().then(setPayrollEmployees);
    primeLocation();
    loadStats();
  }, [captureKey]);

  useEffect(() => {
    const updateConnection = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  // Keep the gate moving: successful punches return to the camera on their
  // own, while the visible Next button remains available for immediate use.
  useEffect(() => {
    if (!outcome || outcome.kind !== "success") return;
    const timer = window.setTimeout(reset, 4_000);
    return () => window.clearTimeout(timer);
  }, [outcome]);

  async function loadStats() {
    const today = localDate();
    // Today's rows only, via the byDate index — this re-runs after every
    // punch, and reading the whole punch history to count today's is the
    // kind of thing that gets a 3GB phone OOM-killed mid-capture.
    const [todayWagePunches, todayPayrollPunches, wagesSync, payrollSync] = await Promise.all([
      getByIndex<Punch>("punches", "byDate", today),
      getByIndex<PayrollPunch>("payrollPunches", "byDate", today),
      getSyncStatus(),
      getPayrollSyncStatus(),
    ]);

    const wageIds = new Set(todayWagePunches.map(p => p.employeeId));
    setWagePresent(wageIds.size);

    const payrollIds = new Set(todayPayrollPunches.map(p => p.employeeId));
    setPayrollPresent(payrollIds.size);

    const times = [wagesSync.lastSuccessAt, payrollSync.lastSuccessAt].filter(Boolean) as number[];
    setLastSyncAt(times.length > 0 ? Math.max(...times) : null);
  }

  async function handleCapture({ face }: CaptureResult) {
    if (!face.embedding) return;

    const galleries: MatchGallery[] = [
      ...wageEmployees.map((e) => ({ id: e.id, descriptors: [e.faceDescriptor] })),
      ...payrollEmployees.map((e) => ({
        id: e.id,
        descriptors: [e.faceDescriptor, ...e.recentEmbeddings].filter(
          (d): d is number[] => Array.isArray(d) && d.length > 0,
        ),
      })),
    ];
    const match = findBestMatchInGalleries(face.embedding, galleries);

    if (!match.id || match.score < DEFAULT_MATCH_THRESHOLD) {
      setOutcome({ kind: "no-match", score: match.score });
      return;
    }
    if (match.score - match.secondScore < MIN_MATCH_MARGIN && match.secondScore > 0) {
      const topName =
        wageEmployees.find((e) => e.id === match.id)?.name ??
        payrollEmployees.find((e) => e.id === match.id)?.name ??
        "Unknown";
      setOutcome({ kind: "ambiguous", topName, score: match.score, secondScore: match.secondScore });
      return;
    }

    // ── Duplicate punch guard ────────────────────────────────────
    const today = localDate();
    // Only this worker's punches for today, straight off the byEmployeeDate
    // index — the guard only ever looks at their most recent punch, so
    // loading every punch in the store to find it was pure waste at the
    // worst possible moment (camera + face engine still live).
    const [wagePunches, payrollPunches] = await Promise.all([
      getByIndex<Punch>("punches", "byEmployeeDate", [match.id, today]),
      getByIndex<PayrollPunch>("payrollPunches", "byEmployeeDate", [match.id, today]),
    ]);
    const lastForWorker = [...wagePunches, ...payrollPunches]
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (lastForWorker) {
      const ago = Date.now() - lastForWorker.timestamp;
      if (ago < DUPE_WINDOW_MS) {
        const w = wageEmployees.find(e => e.id === match.id);
        const p = payrollEmployees.find(e => e.id === match.id);
        const name = w?.name ?? p?.name ?? "Worker";
        setOutcome({ kind: "duplicate", name, punchType: lastForWorker.punchType, secondsAgo: Math.round(ago / 1000) });
        return;
      }
    }

    const location = getCachedLocation();

    const wageEmployee = wageEmployees.find((e) => e.id === match.id);
    if (wageEmployee) {
      const punch = await recordPunch({
        employeeId: wageEmployee.id,
        method: "face",
        matchScore: match.score,
        latitude: location?.latitude,
        longitude: location?.longitude,
        accuracy: location?.accuracy,
      });
      playPunchSound();
      vibratePunch();
      setOutcome({ kind: "success", origin: "wage", employee: wageEmployee, punch });
      syncSoon();
      return;
    }

    const payrollEmployee = payrollEmployees.find((e) => e.id === match.id)!;
    const punch = await recordPayrollPunch({
      employeeId: payrollEmployee.id,
      latitude: location?.latitude,
      longitude: location?.longitude,
      accuracy: location?.accuracy,
      empCode: payrollEmployee.empCode,
      method: "face",
      matchScore: match.score,
    });
    playPunchSound();
    vibratePunch();
    setOutcome({ kind: "success", origin: "payroll", employee: payrollEmployee, punch });
    syncPayrollSoon();
  }

  function reset() {
    setOutcome(null);
    setCaptureKey((k) => k + 1);
  }

  // Hidden Settings entry point: a long-press (~800ms) on the Punch header.
  // Settings is still PIN-gated via requestScreen("settings"), so this is not
  // a bypass — just a way in without a visible Settings tab.
  function startLongPress() {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => onOpenSettings(), 800);
  }
  function cancelLongPress() {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  }

  const totalWage = wageEmployees.length;
  const totalPayroll = payrollEmployees.length;

  if (wageEmployees.length === 0 && payrollEmployees.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500 space-y-3">
        <p>No one enrolled yet. Add a wage worker from the Employees tab, or pair this phone to pull payroll employees.</p>
        {!paired && (
          <button onClick={onOpenSettings} className="text-sm text-brand underline">
            Pair this phone
          </button>
        )}
      </div>
    );
  }

  if (outcome) {
    return (
      <div className="p-6 flex flex-col items-center gap-4 text-center">
        {outcome.kind === "success" && outcome.origin === "wage" && (
          <>
            <img src={outcome.employee.photoDataUrl} className="w-24 h-24 rounded-full object-cover border-4 border-green-400" />
            <div>
              <p className="text-xl font-semibold">{outcome.employee.name}</p>
              <p className={`text-lg font-bold ${outcome.punch.punchType === "in" ? "text-green-600" : "text-amber-600"}`}>
                {outcome.punch.punchType === "in" ? "IN" : "OUT"}
              </p>
              <p className="text-sm text-gray-500">
                {new Date(outcome.punch.timestamp).toLocaleTimeString()} · match {(outcome.punch.matchScore! * 100).toFixed(0)}%
              </p>
              {outcome.punch.punchType === "in" && (
                <p className="text-xs text-green-500 mt-1">Have a great day!</p>
              )}
              {outcome.punch.punchType === "out" && (
                <p className="text-xs text-blue-500 mt-1">See you tomorrow!</p>
              )}
            </div>
          </>
        )}
        {outcome.kind === "success" && outcome.origin === "payroll" && (
          <div>
            <p className="text-xl font-semibold">{outcome.employee.name}</p>
            <p className="text-sm text-gray-400">
              {outcome.employee.empCode}
              {outcome.employee.designation ? ` · ${outcome.employee.designation}` : ""}
            </p>
            <p className={`text-lg font-bold ${outcome.punch.punchType === "in" ? "text-green-600" : "text-amber-600"}`}>
              {outcome.punch.punchType === "in" ? "IN" : "OUT"}
            </p>
            <p className="text-sm text-gray-500">
              {new Date(outcome.punch.timestamp).toLocaleTimeString()} · match {(outcome.punch.matchScore! * 100).toFixed(0)}%
            </p>
            {outcome.punch.punchType === "in" && (
              <p className="text-xs text-green-500 mt-1">Have a great day!</p>
            )}
            {outcome.punch.punchType === "out" && (
              <p className="text-xs text-blue-500 mt-1">See you tomorrow!</p>
            )}
          </div>
        )}
        {outcome.kind === "no-match" && (
          <div>
            <p className="text-xl font-semibold text-red-600">Not recognized</p>
            <p className="text-sm text-gray-500">Best match {(outcome.score * 100).toFixed(0)}%.</p>
            <p className="text-sm text-gray-600 mt-2">Move closer, face the camera, and make sure only one person is in the frame.</p>
            <p className="text-xs text-gray-500 mt-1">Try better light, and remove a helmet or mask if it is safe to do so.</p>
          </div>
        )}
        {outcome.kind === "ambiguous" && (
          <div>
            <p className="text-xl font-semibold text-amber-600">Not sure — too close</p>
            <p className="text-sm text-gray-500">
              "{outcome.topName}" at {(outcome.score * 100).toFixed(0)}% vs {(outcome.secondScore * 100).toFixed(0)}%. Try again with better light.
            </p>
          </div>
        )}
        {outcome.kind === "duplicate" && (
          <div>
            <p className="text-xl font-semibold text-blue-600">Already punched</p>
            <p className="text-sm text-gray-500">
              {outcome.name} just punched {outcome.punchType.toUpperCase()} {outcome.secondsAgo}s ago — no need to scan again.
            </p>
          </div>
        )}
        <button onClick={reset} className="mt-2 w-full max-w-sm py-3 rounded-lg bg-brand text-white font-medium">
          {outcome.kind === "duplicate" ? "OK" : "Next"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      {update && !updateDismissed && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-xs px-4 py-2 flex items-center gap-2">
          <span className="flex-1">
            Update available — ask your supervisor.
            {update.apkUrl && (
              <a href={update.apkUrl} target="_blank" rel="noreferrer" className="underline ml-1">
                Download
              </a>
            )}
          </span>
          <button onClick={() => setUpdateDismissed(true)} className="text-amber-600" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 p-4 flex flex-col items-center gap-3">
        <div
          className="select-none"
          onPointerDown={startLongPress}
          onPointerUp={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onContextMenu={(e) => e.preventDefault()}
        >
          <h1 className="text-lg font-semibold">Punch attendance</h1>
        </div>
        <CameraCapture key={captureKey} onCapture={handleCapture} captureLabel="Punch" />
      </div>

      <div className="border-t bg-gray-50 px-4 py-3 text-xs text-gray-500">
        <div className="max-w-sm mx-auto space-y-2">
          {(totalWage > 0 || totalPayroll > 0) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {totalWage > 0 && (
                <span>
                  <span className="text-green-600 font-medium">{wagePresent}</span>/{totalWage} wage workers in
                </span>
              )}
              {totalPayroll > 0 && (
                <span>
                  <span className="text-blue-600 font-medium">{payrollPresent}</span>/{totalPayroll} payroll in
                </span>
              )}
            </div>
          )}
          <p>Last sync: <span className="text-gray-600">{formatWhenAgo(lastSyncAt)}</span></p>
          {!paired && (
            <p>
              <button onClick={onOpenSettings} className="text-brand underline">
                Pair this phone
              </button>
            </p>
          )}
          {!isOnline && (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-amber-800">
              Offline — punches are saved on this phone and will sync automatically.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
