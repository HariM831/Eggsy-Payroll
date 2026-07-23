import { getByIndex, put, getAll } from "./db";
import { newId, localDate } from "./id";
import type { Punch, PunchMethod } from "../types";

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
  };
  await put("punches", punch);
  return punch;
}

/** HR correction: insert a manual punch (e.g. backfilling a missed out-punch). */
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
  };
  await put("punches", punch);
  return punch;
}
