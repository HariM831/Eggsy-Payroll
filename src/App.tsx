import { useEffect, useRef, useState } from "react";
import LockScreen from "./components/LockScreen";
import BottomNav, { type View } from "./components/BottomNav";
import PunchPage from "./pages/PunchPage";
import EmployeesPage from "./pages/EmployeesPage";
import EmployeeFormPage from "./pages/EmployeeFormPage";
import CalendarPage from "./pages/CalendarPage";
import SettingsPage from "./pages/SettingsPage";
import PairingWaitPage from "./pages/PairingWaitPage";
import { isUnlocked } from "./lib/pin";
import { startWatchingLocation } from "./lib/location";
import { getDeviceConfig, DEVICE_REVOKED_EVENT } from "./lib/sync";
import { getPendingPairing, PAIRING_CHANGE_EVENT } from "./lib/pairing";

type Screen = View | "employee-form";

// Punch is intentionally always open — anyone should be able to walk up and
// punch attendance without a PIN. Everything else (worker enrollment,
// attendance history, sync settings) is behind the lock.
const PROTECTED: Screen[] = ["employees", "calendar", "settings", "employee-form"];

export default function App() {
  const [screen, setScreen] = useState<Screen>("punch");
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
  const [pendingScreen, setPendingScreen] = useState<Screen | null>(null);

  // Pairing state, re-read whenever pairing or revocation changes.
  const [paired, setPaired] = useState(false);
  const [pendingPairing, setPendingPairing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const prevPendingRef = useRef(false);

  // Warm GPS for the whole app session, starting the moment the app opens —
  // not just when the Punch screen mounts — so a fix is already cached by
  // the time someone actually punches (see src/lib/location.ts).
  useEffect(() => {
    startWatchingLocation();
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      const [config, pending] = await Promise.all([getDeviceConfig(), getPendingPairing()]);
      if (!active) return;
      const wasPending = prevPendingRef.current;
      const nowPending = !!pending?.pendingId;
      setPaired(!!config);
      setPendingPairing(nowPending ? pending!.pendingId : null);
      // A device that was waiting for approval and just got paired lands on
      // Punch — where the first sync's restored data is visible. This runs in
      // the same commit as the paired/pending state, so there's no flash of
      // Settings in between.
      if (wasPending && !nowPending && !!config) {
        setScreen("punch");
      }
      prevPendingRef.current = nowPending;
      setLoading(false);
    }
    load();
    const onPairingChange = () => load();
    const onRevoked = () => {
      // Token was cleared by the sync path; drop to the pairing (unpaired)
      // state. Local workers/punches/overrides are left untouched.
      load();
    };
    window.addEventListener(PAIRING_CHANGE_EVENT, onPairingChange);
    window.addEventListener(DEVICE_REVOKED_EVENT, onRevoked);
    return () => {
      active = false;
      window.removeEventListener(PAIRING_CHANGE_EVENT, onPairingChange);
      window.removeEventListener(DEVICE_REVOKED_EVENT, onRevoked);
    };
  }, []);

  function requestScreen(target: Screen) {
    if (PROTECTED.includes(target) && !isUnlocked()) {
      setPendingScreen(target);
      return;
    }
    setScreen(target);
  }

  function handleUnlocked() {
    const target = pendingScreen ?? "employees";
    setPendingScreen(null);
    setScreen(target);
  }

  function openAddEmployee() {
    setEditingEmployeeId(null);
    requestScreen("employee-form");
  }
  function openEditEmployee(id: string) {
    setEditingEmployeeId(id);
    requestScreen("employee-form");
  }
  function closeEmployeeForm() {
    setScreen("employees");
  }

  if (loading) return null;

  // A pending pairing request (and no token yet) takes over the whole app.
  // A paired device must never see this screen.
  if (!paired && pendingPairing) {
    return (
      <PairingWaitPage
        pendingId={pendingPairing}
        onCancel={() => requestScreen("settings")}
      />
    );
  }

  if (pendingScreen) {
    return <LockScreen onUnlock={handleUnlocked} />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {screen === "punch" && <PunchPage onOpenSettings={() => requestScreen("settings")} />}
      {screen === "employees" && <EmployeesPage onAdd={openAddEmployee} onEdit={openEditEmployee} />}
      {screen === "employee-form" && (
        <EmployeeFormPage employeeId={editingEmployeeId} onDone={closeEmployeeForm} onCancel={closeEmployeeForm} />
      )}
      {screen === "calendar" && <CalendarPage />}
      {screen === "settings" && <SettingsPage />}

      {screen !== "employee-form" && (
        <BottomNav active={screen as View} onChange={requestScreen} unlocked={isUnlocked()} />
      )}
    </div>
  );
}
