import { useEffect, useState } from "react";
import { listEmployees, deactivateEmployee } from "../lib/employees";
import type { Employee } from "../types";

export default function EmployeesPage({ onAdd, onEdit }: { onAdd: () => void; onEdit: (id: string) => void }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setEmployees(await listEmployees());
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="p-4 pb-24">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Employees</h1>
        <button onClick={onAdd} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium">
          + Add
        </button>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : employees.length === 0 ? (
        <p className="text-gray-500 text-sm">No employees yet. Tap "Add" to enroll the first one.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {employees.map((e) => (
            <div key={e.id} className="flex items-center gap-3 border rounded-lg p-3">
              <img src={e.photoDataUrl} className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
              <div className="flex-1 min-w-0" onClick={() => onEdit(e.id)}>
                <p className="font-medium truncate">{e.name}</p>
                <p className="text-xs text-gray-500">
                  Aadhar {e.aadharNumber}
                  {e.role ? ` · ${e.role}` : ""}
                </p>
              </div>
              <button
                onClick={async () => {
                  if (confirm(`Remove ${e.name} from active employees?`)) {
                    await deactivateEmployee(e.id);
                    refresh();
                  }
                }}
                className="text-red-600 text-xs px-2 py-1"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
