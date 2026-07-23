// Attendance resolution — deliberately simple, matching the "no shifts, no
// holidays, no leave" scope: a day is Present if the employee punched in at
// all that day, Absent otherwise. HR can override either way after the fact.
import { get, put } from "./db";
import { getPunchesForEmployeeDate } from "./punches";
import { localDate } from "./id";
import type { DayResolution, Punch } from "../types";

export interface DayOverride {
  key: string; // "<employeeId>|<date>"
  employeeId: string;
  date: string;
  status: "P" | "A";
  note: string;
  setAt: number;
  /** Set once this record has been pushed to aminofarms.replit.app. Absent/false = pending sync. */
  syncedAt?: number;
}

function overrideKey(employeeId: string, date: string): string {
  return `${employeeId}|${date}`;
}

export async function setDayOverride(
  employeeId: string,
  date: string,
  status: "P" | "A",
  note = "",
): Promise<void> {
  const row: DayOverride = { key: overrideKey(employeeId, date), employeeId, date, status, note, setAt: Date.now() };
  await put("overrides", row);
}

export async function clearDayOverride(employeeId: string, date: string): Promise<void> {
  await put("overrides", {
    key: overrideKey(employeeId, date),
    employeeId,
    date,
    status: null,
    note: "",
    setAt: Date.now(),
  } as any);
}

function summarizeDay(punches: Punch[]): { hours: number; firstIn: number | null; lastOut: number | null; openIn: boolean } {
  const sorted = [...punches].sort((a, b) => a.timestamp - b.timestamp);
  let ms = 0;
  let anchor: Punch | null = null;
  let firstIn: number | null = null;
  let lastOut: number | null = null;
  for (const p of sorted) {
    if (p.punchType === "in") {
      if (!anchor) anchor = p;
      if (firstIn === null) firstIn = p.timestamp;
    } else if (p.punchType === "out" && anchor) {
      ms += p.timestamp - anchor.timestamp;
      anchor = null;
      lastOut = p.timestamp;
    }
  }
  return { hours: ms / 3_600_000, firstIn, lastOut, openIn: anchor !== null };
}

export async function resolveDay(employeeId: string, date: string): Promise<DayResolution> {
  const override = await get<DayOverride>("overrides", overrideKey(employeeId, date));
  const punches = await getPunchesForEmployeeDate(employeeId, date);
  const summary = summarizeDay(punches);

  if (override?.status) {
    return {
      date,
      status: override.status,
      firstIn: summary.firstIn,
      lastOut: summary.lastOut,
      hours: Math.round(summary.hours * 100) / 100,
      openIn: summary.openIn,
      manual: true,
    };
  }

  const status: "P" | "A" = punches.length > 0 ? "P" : "A";
  return {
    date,
    status,
    firstIn: summary.firstIn,
    lastOut: summary.lastOut,
    hours: Math.round(summary.hours * 100) / 100,
    openIn: summary.openIn,
    manual: false,
  };
}

/** Resolve every day in a month for one employee. Days after today are
 * omitted (nothing has happened yet); days before the employee existed are
 * left to the caller (this app doesn't track a joining date). */
export async function resolveMonth(
  employeeId: string,
  month: number, // 1-12
  year: number,
): Promise<Record<string, DayResolution>> {
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = localDate();
  const out: Record<string, DayResolution> = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (date > today) continue;
    out[String(d)] = await resolveDay(employeeId, date);
  }
  return out;
}

/** Count present days for one employee within [fromDate, toDate] inclusive
 * (both "YYYY-MM-DD"), used by the wage report. */
export async function countPresentDaysInRange(
  employeeId: string,
  fromDate: string,
  toDate: string,
): Promise<number> {
  let cursor = fromDate;
  let count = 0;
  while (cursor <= toDate) {
    const day = await resolveDay(employeeId, cursor);
    if (day.status === "P") count++;
    const [y, m, d] = cursor.split("-").map(Number);
    const next = new Date(y, m - 1, d + 1);
    cursor = localDate(next);
  }
  return count;
}
