// Read-only local mirror of the main app's payroll (salaried employee)
// roster — pulled by sync.ts from GET /api/attendance-sync/employees. This
// device never creates or edits these rows; identity/enrollment is
// server-owned (main app's face-enrollment page). See types.ts and
// README.md for the full ownership rationale.
import { getAll, get } from "./db";
import type { PayrollEmployee } from "../types";

export async function listPayrollEmployees(): Promise<PayrollEmployee[]> {
  const all = await getAll<PayrollEmployee>("payrollEmployees");
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPayrollEmployee(id: string): Promise<PayrollEmployee | undefined> {
  return get<PayrollEmployee>("payrollEmployees", id);
}
