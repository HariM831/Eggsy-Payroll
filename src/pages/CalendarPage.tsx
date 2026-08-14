import { useEffect, useMemo, useState } from "react";
import { listEmployees } from "../lib/employees";
import { resolveMonth, setDayOverride, resolveDay } from "../lib/attendance";
import { syncSoon } from "../lib/sync";
import { getAll } from "../lib/db";
import type { Employee, DayResolution, Punch } from "../types";
import type { DayOverride } from "../lib/attendance";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function CalendarPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [days, setDays] = useState<Record<string, DayResolution>>({});
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unsyncedDates, setUnsyncedDates] = useState<Set<string>>(new Set());

  useEffect(() => {
    listEmployees().then(setEmployees);
  }, []);

  async function refresh() {
    if (!employeeId) return;
    setLoading(true);
    const monthPrefix = `${year}-${String(month).padStart(2, "0")}-`;
    const [resolvedDays, punches, overrides] = await Promise.all([
      resolveMonth(employeeId, month, year),
      getAll<Punch>("punches"),
      getAll<DayOverride>("overrides"),
    ]);
    setDays(resolvedDays);
    setUnsyncedDates(new Set([
      ...punches.filter((p) => p.employeeId === employeeId && p.punchDate.startsWith(monthPrefix) && !p.syncedAt).map((p) => p.punchDate),
      ...overrides.filter((o) => o.employeeId === employeeId && o.date.startsWith(monthPrefix) && o.status && !o.syncedAt).map((o) => o.date),
    ]));
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, month, year]);

  function shiftMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m);
    setYear(y);
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const dateStr = (d: string) => `${year}-${String(month).padStart(2, "0")}-${d.padStart(2, "0")}`;
  const selectedInfo = selectedDay ? days[selectedDay] : null;

  async function override(status: "P" | "A") {
    if (!selectedDay || !employeeId) return;
    await setDayOverride(employeeId, dateStr(selectedDay), status, "Manually corrected");
    const updated = await resolveDay(employeeId, dateStr(selectedDay));
    setDays((d) => ({ ...d, [selectedDay]: updated }));
    syncSoon();
  }

  return (
    <div className="p-4 pb-24">
      <h1 className="text-lg font-semibold mb-3">Calendar</h1>

      <select
        value={employeeId}
        onChange={(e) => setEmployeeId(e.target.value)}
        className="w-full border rounded-lg px-3 py-2 mb-3"
      >
        <option value="">Select employee…</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>{e.name}</option>
        ))}
      </select>

      {!employeeId ? (
        <p className="text-gray-500 text-sm text-center py-8">Select an employee to see their calendar.</p>
      ) : (
        <>
          <div className="flex items-center justify-center gap-4 mb-3">
            <button onClick={() => shiftMonth(-1)} className="px-3 py-1 border rounded-lg">‹</button>
            <span className="font-medium w-36 text-center">{MONTHS[month - 1]} {year}</span>
            <button onClick={() => shiftMonth(1)} className="px-3 py-1 border rounded-lg">›</button>
          </div>

          {loading ? (
            <p className="text-center text-gray-500 py-8">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-7 gap-1 text-center text-xs text-gray-500 mb-1">
                {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
                {Array.from({ length: daysInMonth }, (_, i) => String(i + 1)).map((d) => {
                  const info = days[d];
                  const date = dateStr(d);
                  const hasException = !!info && (info.openIn || info.manual || unsyncedDates.has(date));
                  return (
                    <button
                      key={d}
                      disabled={!info}
                      onClick={() => setSelectedDay(d)}
                      className={`relative aspect-square rounded-md text-xs flex flex-col items-center justify-center ${
                        !info
                          ? "bg-gray-50 text-gray-300"
                          : info.status === "P"
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-700"
                      } ${hasException ? "ring-2 ring-amber-400 ring-inset" : ""}`}
                    >
                      <span className="opacity-70">{d}</span>
                      <span className="font-semibold">{info?.status ?? "–"}</span>
                      {hasException && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500" aria-label="Needs attention" />}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-4 mt-3 text-xs text-gray-500">
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-200 mr-1" />Present</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-200 mr-1" />Absent</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm ring-2 ring-amber-400 mr-1" />Needs attention</span>
              </div>
            </>
          )}
        </>
      )}

      {selectedDay && selectedInfo && (
        <div className="fixed inset-0 bg-black/40 flex items-end z-30" onClick={() => setSelectedDay(null)}>
          <div className="bg-white w-full rounded-t-xl p-4 pb-8" onClick={(e) => e.stopPropagation()}>
            <p className="font-semibold mb-2">{dateStr(selectedDay)}</p>
            <p className="text-sm mb-1">
              Status: <span className={selectedInfo.status === "P" ? "text-green-700" : "text-red-700"}>
                {selectedInfo.status === "P" ? "Present" : "Absent"}
              </span>
              {selectedInfo.manual && <span className="text-gray-400"> (manually set)</span>}
            </p>
            {unsyncedDates.has(dateStr(selectedDay)) && <p className="text-sm text-amber-700">Waiting to sync to Amino Farms</p>}
            {selectedInfo.firstIn && (
              <p className="text-sm text-gray-500">
                In {new Date(selectedInfo.firstIn).toLocaleTimeString()}
                {selectedInfo.lastOut ? ` · Out ${new Date(selectedInfo.lastOut).toLocaleTimeString()}` : selectedInfo.openIn ? " · not punched out" : ""}
              </p>
            )}
            {selectedInfo.openIn && <p className="text-sm text-amber-700 mt-1">Missing OUT punch — correct the day below if needed.</p>}
            <p className="text-xs text-gray-500 mt-3">Correct attendance</p>
            <div className="flex gap-2 mt-3">
              <button onClick={() => override("P")} className="flex-1 py-2 rounded-lg border border-green-600 text-green-700 text-sm">
                Mark Present
              </button>
              <button onClick={() => override("A")} className="flex-1 py-2 rounded-lg border border-red-600 text-red-700 text-sm">
                Mark Absent
              </button>
            </div>
            <button onClick={() => setSelectedDay(null)} className="w-full mt-3 py-2 text-sm text-gray-500">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
