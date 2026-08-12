import { getByIndex, get, put, getAll } from "./db";
import { newId, localDate } from "./id";
import type { Punch, PunchMethod, PayrollPunch, PayrollEmployee } from "../types";

export async function getPunchesForEmployeeDate(employeeId: string, date: string): Promise<Punch[]> {
  const rows = await getByIndex<Punch>("punches", "byEmployeeDate", [employeeId, date]);
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getPunchesForEmployee(employeeId: string): Promise<Punch[]> {
  const rows = await getByIndex<Punch>("punches", "byEmployee", employeeId);
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getAllPunches(): Promise<Punch[]> {
  return getAll<Punch>("punches");
}

/** What the NEXT punch for this employee today should be, based on the last
 * punch recorded today. First punch of the day is always "in". */
export async function nextPunchType(employeeId: string, date = localDate()): Promise<"in" | "out"> {
  const today = await getPunchesForEmployeeDate(employeeId, date);
  const last = today[today.length - 1];
  return !last || last.punchType === "out" ? "in" : "out";
}

export async function recordPunch(input: {
  employeeId: string;
  method: PunchMethod;
  matchScore?: number | null;
  capturedPhotoDataUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
}): Promise<Punch> {
  const now = new Date();
  const date = localDate(now);
  const type = await nextPunchType(input.employeeId, date);
  const punch: Punch = {
    id: newId(),
    employeeId: input.employeeId,
    punchType: type,
    timestamp: now.getTime(),
    punchDate: date,
    method: input.method,
    matchScore: input.matchScore ?? null,
    capturedPhotoDataUrl: input.capturedPhotoDataUrl ?? null,
    note: null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    accuracy: input.accuracy ?? null,
  };
  await put("punches", punch);
  return punch;
}

/** HR correction: insert a manual punch (e.g. backfilling a missed out-punch).
 * No location — this is a desk correction after the fact, not a live punch. */
export async function addManualPunch(input: {
  employeeId: string;
  punchType: "in" | "out";
  timestamp: number;
  note: string;
}): Promise<Punch> {
  const punch: Punch = {
    id: newId(),
    employeeId: input.employeeId,
    punchType: input.punchType,
    timestamp: input.timestamp,
    punchDate: localDate(new Date(input.timestamp)),
    method: "manual",
    matchScore: null,
    capturedPhotoDataUrl: null,
    note: input.note,
    latitude: null,
    longitude: null,
    accuracy: null,
  };
  await put("punches", punch);
  return punch;
}

// ── Payroll (salaried employee) punches ─────────────────────────────────────
// Same in/out sequencing rule as Wages punches above, but evaluated against
// this device's local records AND the server's own view of today (carried on
// the roster as lastPunchToday) — a payroll employee can equally punch at the
// main app's browser gate kiosk or on another phone, which this device never
// sees locally. The server also guards the sequence when the punches are
// pushed, and reconciles both sources when it recomputes the day (see
// server/routes/payroll-attendance-sync.ts).

export async function getPayrollPunchesForEmployeeDate(employeeId: string, date: string): Promise<PayrollPunch[]> {
  const rows = await getByIndex<PayrollPunch>("payrollPunches", "byEmployeeDate", [employeeId, date]);
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

async function nextPayrollPunchType(employeeId: string, date = localDate()): Promise<"in" | "out"> {
  const today = await getPayrollPunchesForEmployeeDate(employeeId, date);
  const localLast = today[today.length - 1] ?? null;

  // A payroll employee can also punch at the main app's browser gate kiosk,
  // or on a second phone — neither of which this device ever sees locally.
  // Going on local punches alone, a morning kiosk IN looks like a blank day
  // here, so the evening punch would be recorded as a second IN, leaving the
  // day unclosed and therefore unmarked by the server's recomputeEmployeeDay.
  // The roster (refreshed every sync) carries the server's own view, so take
  // whichever punch is genuinely the most recent.
  const roster = await get<PayrollEmployee>("payrollEmployees", employeeId);
  const remoteLast =
    roster?.lastPunchToday && roster.lastPunchToday.punchDate === date ? roster.lastPunchToday : null;

  const last =
    localLast && remoteLast
      ? remoteLast.timestamp > localLast.timestamp
        ? remoteLast
        : localLast
      : localLast ?? remoteLast;

  return !last || last.punchType === "out" ? "in" : "out";
}

export async function recordPayrollPunch(input: {
  employeeId: string;
  empCode: string;
  method: PunchMethod;
  matchScore?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
}): Promise<PayrollPunch> {
  const now = new Date();
  const date = localDate(now);
  const type = await nextPayrollPunchType(input.employeeId, date);
  const punch: PayrollPunch = {
    id: newId(),
    employeeId: input.employeeId,
    empCode: input.empCode,
    punchType: type,
    timestamp: now.getTime(),
    punchDate: date,
    method: input.method,
    matchScore: input.matchScore ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    accuracy: input.accuracy ?? null,
  };
  await put("payrollPunches", punch);
  return punch;
}
