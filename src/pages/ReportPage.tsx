import { useState } from "react";
import { listEmployees } from "../lib/employees";
import { countPresentDaysInRange } from "../lib/attendance";
import { buildWageCsv, exportAndShareCsv, type WageRow } from "../lib/export";
import { localDate } from "../lib/id";

function firstOfMonth(): string {
  const d = new Date();
  return localDate(new Date(d.getFullYear(), d.getMonth(), 1));
}

export default function ReportPage() {
  const [fromDate, setFromDate] = useState(firstOfMonth());
  const [toDate, setToDate] = useState(localDate());
  const [rows, setRows] = useState<WageRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);

  async function generate() {
    if (fromDate > toDate) return;
    setLoading(true);
    const employees = await listEmployees();
    const result: WageRow[] = [];
    for (const employee of employees) {
      const presentDays = await countPresentDaysInRange(employee.id, fromDate, toDate);
      result.push({ employee, presentDays, amount: presentDays * employee.dailyWage });
    }
    setRows(result);
    setLoading(false);
  }

  async function share() {
    if (!rows) return;
    setSharing(true);
    try {
      const csv = buildWageCsv(rows, fromDate, toDate);
      await exportAndShareCsv(csv, `wage-report-${fromDate}-to-${toDate}.csv`);
    } finally {
      setSharing(false);
    }
  }

  const total = rows?.reduce((s, r) => s + r.amount, 0) ?? 0;

  return (
    <div className="p-4 pb-24">
      <h1 className="text-lg font-semibold mb-3">Wage settlement report</h1>

      <div className="flex gap-2 mb-3">
        <label className="flex-1 text-sm">
          From
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="mt-1 w-full border rounded-lg px-2 py-2" />
        </label>
        <label className="flex-1 text-sm">
          To
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="mt-1 w-full border rounded-lg px-2 py-2" />
        </label>
      </div>

      <button onClick={generate} disabled={loading} className="w-full py-3 rounded-lg bg-brand text-white font-medium disabled:opacity-50 mb-4">
        {loading ? "Calculating…" : "Generate report"}
      </button>

      {rows && (
        <>
          {rows.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-6">No employees enrolled.</p>
          ) : (
            <div className="flex flex-col gap-2 mb-4">
              {rows.map((r) => (
                <div key={r.employee.id} className="flex items-center justify-between border rounded-lg p-3">
                  <div>
                    <p className="font-medium">{r.employee.name}</p>
                    <p className="text-xs text-gray-500">{r.presentDays} days × ₹{r.employee.dailyWage}</p>
                  </div>
                  <p className="font-semibold">₹{r.amount.toLocaleString("en-IN")}</p>
                </div>
              ))}
              <div className="flex items-center justify-between border-t pt-3 mt-1">
                <p className="font-semibold">Total</p>
                <p className="font-semibold text-lg">₹{total.toLocaleString("en-IN")}</p>
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <button onClick={share} disabled={sharing} className="w-full py-3 rounded-lg border border-brand text-brand font-medium disabled:opacity-50">
              {sharing ? "Preparing…" : "Export & share CSV"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
