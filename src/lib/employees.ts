import { getAll, get, put, del } from "./db";
import { newId } from "./id";
import type { Employee } from "../types";

export async function listEmployees(includeInactive = false): Promise<Employee[]> {
  const all = await getAll<Employee>("employees");
  const filtered = includeInactive ? all : all.filter((e) => e.isActive);
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getEmployee(id: string): Promise<Employee | undefined> {
  return get<Employee>("employees", id);
}

export async function createEmployee(input: {
  name: string;
  aadharNumber: string;
  photoDataUrl: string;
  faceDescriptor: number[];
}): Promise<Employee> {
  const employee: Employee = {
    id: newId(),
    name: input.name.trim(),
    aadharNumber: input.aadharNumber.trim(),
    photoDataUrl: input.photoDataUrl,
    faceDescriptor: input.faceDescriptor,
    isActive: true,
    createdAt: Date.now(),
    // left unset — the outbox (lib/sync.ts) treats a missing syncedAt as pending
  };
  await put("employees", employee);
  return employee;
}

export async function updateEmployee(id: string, patch: Partial<Employee>): Promise<void> {
  const existing = await getEmployee(id);
  if (!existing) throw new Error("Employee not found");
  await put("employees", { ...existing, ...patch, id });
}

export async function deactivateEmployee(id: string): Promise<void> {
  await updateEmployee(id, { isActive: false });
}

export async function deleteEmployee(id: string): Promise<void> {
  await del("employees", id);
}
