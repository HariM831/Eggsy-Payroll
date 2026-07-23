// Wage settlement report — CSV export, shared via the native share sheet on
// Android (so it can go straight to WhatsApp/email/Drive) or downloaded
// directly when running in a desktop browser during development.
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Capacitor } from "@capacitor/core";
import type { Employee } from "../types";

export interface WageRow {
  employee: Employee;
  presentDays: number;
  amount: number;
}

function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildWageCsv(rows: WageRow[], fromDate: string, toDate: string): string {
  const header = ["Employee", "Aadhar", "Period", "Present Days", "Daily Wage", "Amount Payable"];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.employee.name,
        r.employee.aadharNumber,
        `${fromDate} to ${toDate}`,
        r.presentDays,
        r.employee.dailyWage,
        r.amount,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const total = rows.reduce((s, r) => s + r.amount, 0);
  lines.push(["", "", "", "", "Total", total].map(csvEscape).join(","));
  return lines.join("\n");
}

export async function exportAndShareCsv(csv: string, filename: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const result = await Filesystem.writeFile({
      path: filename,
      data: csv,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({
      title: "Wage settlement report",
      url: result.uri,
      dialogTitle: "Share wage report",
    });
    return;
  }
  // Desktop browser dev fallback: trigger a normal file download.
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
