import { useEffect, useState } from "react";
import CameraCapture, { type CaptureResult } from "../components/CameraCapture";
import { createEmployee, getEmployee, updateEmployee } from "../lib/employees";
import { getCachedRoles, syncSoon } from "../lib/sync";
import type { Employee } from "../types";

interface Props {
  employeeId: string | null; // null = creating a new employee
  onDone: () => void;
  onCancel: () => void;
}

export default function EmployeeFormPage({ employeeId, onDone, onCancel }: Props) {
  const [name, setName] = useState("");
  const [aadhar, setAadhar] = useState("");
  const [role, setRole] = useState("");
  const [roleOptions, setRoleOptions] = useState<string[]>([]);
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const [existing, setExisting] = useState<Employee | null>(null);
  const [showCamera, setShowCamera] = useState(employeeId === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCachedRoles().then(setRoleOptions);
  }, []);

  useEffect(() => {
    if (!employeeId) return;
    getEmployee(employeeId).then((e) => {
      if (!e) return;
      setExisting(e);
      setName(e.name);
      setAadhar(e.aadharNumber);
      setRole(e.role ?? "");
    });
  }, [employeeId]);

  async function handleSave() {
    setError(null);
    if (!name.trim()) return setError("Name is required");
    if (!/^\d{4}\s?\d{4}\s?\d{4}$/.test(aadhar.trim())) return setError("Aadhar should be 12 digits");
    if (!role.trim()) return setError("Role is required — this decides the daily rate in Amino Farms");
    if (!employeeId && !capture) return setError("Capture a face photo to enroll this employee");

    setSaving(true);
    try {
      if (employeeId && existing) {
        await updateEmployee(employeeId, {
          name: name.trim(),
          aadharNumber: aadhar.trim(),
          role: role.trim(),
          // Identity changed — clear syncedAt so the outbox re-pushes this record.
          syncedAt: undefined,
          ...(capture ? { photoDataUrl: capture.photoDataUrl, faceDescriptor: capture.face.embedding! } : {}),
        });
      } else if (capture) {
        await createEmployee({
          name: name.trim(),
          aadharNumber: aadhar.trim(),
          photoDataUrl: capture.photoDataUrl,
          faceDescriptor: capture.face.embedding!,
          role: role.trim(),
        });
      }
      syncSoon();
      onDone();
    } catch (err: any) {
      setError(err.message ?? "Could not save employee");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 pb-24">
      <h1 className="text-lg font-semibold mb-4">{employeeId ? "Edit employee" : "Add employee"}</h1>

      <div className="flex flex-col gap-3 max-w-sm">
        <label className="text-sm">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full border rounded-lg px-3 py-2"
            placeholder="Full name"
          />
        </label>
        <label className="text-sm">
          Aadhar number
          <input
            value={aadhar}
            onChange={(e) => setAadhar(e.target.value)}
            className="mt-1 w-full border rounded-lg px-3 py-2"
            placeholder="1234 5678 9012"
            inputMode="numeric"
          />
        </label>
        <label className="text-sm">
          Role
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="mt-1 w-full border rounded-lg px-3 py-2"
            placeholder="e.g. Mason, Helper"
            list="role-options"
          />
          <datalist id="role-options">
            {roleOptions.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <p className="text-xs text-gray-400 -mt-1">The daily rate for this role is set centrally in the Amino Farms Wages page.</p>

        {existing && !showCamera && (
          <div className="flex items-center gap-3">
            <img src={capture?.photoDataUrl ?? existing.photoDataUrl} className="w-16 h-16 rounded-full object-cover" />
            <button onClick={() => setShowCamera(true)} className="text-sm text-brand underline">
              Re-capture face
            </button>
          </div>
        )}

        {showCamera && (
          <div className="pt-2">
            {capture ? (
              <div className="flex items-center gap-3">
                <img src={capture.photoDataUrl} className="w-16 h-16 rounded-full object-cover" />
                <span className="text-sm text-green-600">Face captured</span>
                <button onClick={() => setCapture(null)} className="text-sm text-gray-500 underline">
                  Retake
                </button>
              </div>
            ) : (
              <CameraCapture captureLabel="Capture face" onCapture={setCapture} />
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-2">
          <button onClick={onCancel} className="flex-1 py-3 rounded-lg border font-medium">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-3 rounded-lg bg-brand text-white font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
