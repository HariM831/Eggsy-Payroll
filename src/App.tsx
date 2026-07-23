import { useState } from "react";
import LockScreen from "./components/LockScreen";
import BottomNav, { type View } from "./components/BottomNav";
import PunchPage from "./pages/PunchPage";
import EmployeesPage from "./pages/EmployeesPage";
import EmployeeFormPage from "./pages/EmployeeFormPage";
import CalendarPage from "./pages/CalendarPage";
import SettingsPage from "./pages/SettingsPage";
import { isUnlocked } from "./lib/pin";

type Screen = View | "employee-form";

// Punch is intentionally always open — anyone should be able to walk up and
// punch attendance without a PIN. Everything else (worker enrollment,
// attendance history, sync settings) is behind the lock.
const PROTECTED: Screen[] = ["employees", "calendar", "settings", "employee-form"];

export default function App() {
  const [screen, setScreen] = useState<Screen>("punch");
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
  const [pendingScreen, setPendingScreen] = useState<Screen | null>(null);

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

  if (pendingScreen) {
    return <LockScreen onUnlock={handleUnlocked} />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {screen === "punch" && <PunchPage />}
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
