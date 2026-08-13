import { useEffect, useMemo, useState } from "react";
import CameraCapture, { type CaptureResult } from "../components/CameraCapture";
import { listEmployees } from "../lib/employees";
import { listPayrollEmployees } from "../lib/payrollEmployees";
import { recordPunch, recordPayrollPunch } from "../lib/punches";
import { syncSoon, syncPayrollSoon, getSyncStatus, getPayrollSyncStatus } from "../lib/sync";
import { primeLocation, getCachedLocation } from "../lib/location";
import { findBestMatchInGalleries, DEFAULT_MATCH_THRESHOLD, MIN_MATCH_MARGIN, type MatchGallery } from "../lib/face";
import { getAll } from "../lib/db";
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

export default function PunchPage() {
  const [wageEmployees, setWageEmployees] = useState<Employee[]>([]);
  const [payrollEmployees, setPayrollEmployees] = useState<PayrollEmployee[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [captureKey, setCaptureKey] = useState(0);

  const [wagePresent, setWagePresent] = useState(0);
  const [payrollPresent, setPayrollPresent] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  useEffect(() => {
    listEmployees().then(setWageEmployees);
    listPayrollEmployees().then(setPayrollEmployees);
    primeLocation();
    loadStats();
  }, [captureKey]);

  async function loadStats() {
    const today = localDate();
    const [allWagePunches, allPayrollPunches, wagesSync, payrollSync] = await Promise.all([
      getAll<Punch>("punches"),
      getAll<PayrollPunch>("payrollPunches"),
      getSyncStatus(),
      getPayrollSyncStatus(),
    ]);

    const wageIds = new Set(allWagePunches.filter(p => p.punchDate === today).map(p => p.employeeId));
    setWagePresent(wageIds.size);

    const payrollIds = new Set(allPayrollPunches.filter(p => p.punchDate === today).map(p => p.employeeId));
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
    const [wagePunches, payrollPunches] = await Promise.all([
      getAll<Punch>("punches"),
      getAll<PayrollPunch>("payrollPunches"),
    ]);
    const allTodayPunches = [
      ...wagePunches.filter(p => p.punchDate === today),
      ...payrollPunches.filter(p => p.punchDate === today),
    ];
    const lastForWorker = allTodayPunches
      .filter(p => p.employeeId === match.id)
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

  const totalWage = wageEmployees.length;
  const totalPayroll = payrollEmployees.length;

  if (wageEmployees.length === 0 && payrollEmployees.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500">
        No one enrolled yet. Add a wage worker from the Employees tab, or sync a payroll device token in Settings.
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
            <p className="text-sm text-gray-500">Best match {(outcome.score * 100).toFixed(0)}% — make sure this person is enrolled.</p>
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
      <div className="flex-1 p-4 flex flex-col items-center gap-3">
        <h1 className="text-lg font-semibold">Punch attendance</h1>
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
        </div>
      </div>
    </div>
  );
}
