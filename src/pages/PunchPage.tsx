import { useEffect, useState } from "react";
import CameraCapture, { type CaptureResult } from "../components/CameraCapture";
import { listEmployees } from "../lib/employees";
import { recordPunch } from "../lib/punches";
import { syncSoon } from "../lib/sync";
import { findBestMatch, DEFAULT_MATCH_THRESHOLD, MIN_MATCH_MARGIN, type MatchCandidate } from "../lib/face";
import type { Employee, Punch } from "../types";

type Outcome =
  | { kind: "success"; employee: Employee; punch: Punch }
  | { kind: "no-match"; score: number }
  | { kind: "ambiguous"; topName: string; score: number; secondScore: number };

export default function PunchPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [captureKey, setCaptureKey] = useState(0); // bump to remount the camera for the next punch

  useEffect(() => {
    listEmployees().then(setEmployees);
  }, [captureKey]);

  async function handleCapture({ face }: CaptureResult) {
    if (!face.embedding) return;
    const candidates: MatchCandidate[] = employees.map((e) => ({ id: e.id, descriptor: e.faceDescriptor }));
    const match = findBestMatch(face.embedding, candidates);

    if (!match.id || match.score < DEFAULT_MATCH_THRESHOLD) {
      setOutcome({ kind: "no-match", score: match.score });
      return;
    }
    if (match.score - match.secondScore < MIN_MATCH_MARGIN && match.secondScore > 0) {
      const topName = employees.find((e) => e.id === match.id)?.name ?? "Unknown";
      setOutcome({ kind: "ambiguous", topName, score: match.score, secondScore: match.secondScore });
      return;
    }

    const employee = employees.find((e) => e.id === match.id)!;
    const punch = await recordPunch({ employeeId: employee.id, method: "face", matchScore: match.score });
    setOutcome({ kind: "success", employee, punch });
    syncSoon();
  }

  function reset() {
    setOutcome(null);
    setCaptureKey((k) => k + 1);
  }

  if (employees.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500">
        No employees enrolled yet. Add one from the Employees tab first.
      </div>
    );
  }

  if (outcome) {
    return (
      <div className="p-6 flex flex-col items-center gap-4 text-center">
        {outcome.kind === "success" && (
          <>
            <img src={outcome.employee.photoDataUrl} className="w-24 h-24 rounded-full object-cover" />
            <div>
              <p className="text-xl font-semibold">{outcome.employee.name}</p>
              <p className={`text-lg font-medium ${outcome.punch.punchType === "in" ? "text-green-600" : "text-amber-600"}`}>
                Punched {outcome.punch.punchType.toUpperCase()}
              </p>
              <p className="text-sm text-gray-500">
                {new Date(outcome.punch.timestamp).toLocaleTimeString()} · match {(outcome.punch.matchScore! * 100).toFixed(0)}%
              </p>
            </div>
          </>
        )}
        {outcome.kind === "no-match" && (
          <div>
            <p className="text-xl font-semibold text-red-600">Not recognized</p>
            <p className="text-sm text-gray-500">Best match was only {(outcome.score * 100).toFixed(0)}% — make sure this person is enrolled.</p>
          </div>
        )}
        {outcome.kind === "ambiguous" && (
          <div>
            <p className="text-xl font-semibold text-amber-600">Not sure — too close to call</p>
            <p className="text-sm text-gray-500">
              Closest match "{outcome.topName}" at {(outcome.score * 100).toFixed(0)}%, but another employee scored{" "}
              {(outcome.secondScore * 100).toFixed(0)}%. Try again with better lighting.
            </p>
          </div>
        )}
        <button onClick={reset} className="mt-2 w-full max-w-sm py-3 rounded-lg bg-brand text-white font-medium">
          Next
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col items-center gap-4">
      <h1 className="text-lg font-semibold">Punch attendance</h1>
      <CameraCapture key={captureKey} onCapture={handleCapture} captureLabel="Punch" />
    </div>
  );
}
