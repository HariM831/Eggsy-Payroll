import { useState } from "react";
import LockScreen from "./components/LockScreen";
import BottomNav, { type View } from "./components/BottomNav";
import PunchPage from "./pages/PunchPage";
import EmployeesPage from "./pages/EmployeesPage";
import EmployeeFormPage from "./pages/EmployeeFormPage";
import CalendarPage from "./pages/CalendarPage";
import ReportPage from "./pages/ReportPage";
import { isUnlocked } from "./lib/pin";

type Screen = View | "employee-form";

export default function App() {
  const [unlocked, setUnlocked] = useState(isUnlocked());
  const [screen, setScreen] = useState<Screen>("punch");
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);

  if (!unlocked) {
    return <LockScreen onUnlock={() => setUnlocked(true)} />;
  }

  function openAddEmployee() {
    setEditingEmployeeId(null);
    setScreen("employee-form");
  }
  function openEditEmployee(id: string) {
    setEditingEmployeeId(id);
    setScreen("employee-form");
  }
  function closeEmployeeForm() {
    setScreen("employees");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {screen === "punch" && <PunchPage />}
      {screen === "employees" && <EmployeesPage onAdd={openAddEmployee} onEdit={openEditEmployee} />}
      {screen === "employee-form" && (
        <EmployeeFormPage employeeId={editingEmployeeId} onDone={closeEmployeeForm} onCancel={closeEmployeeForm} />
      )}
      {screen === "calendar" && <CalendarPage />}
      {screen === "report" && <ReportPage />}

      {screen !== "employee-form" && (
        <BottomNav active={screen as View} onChange={setScreen} />
      )}
    </div>
  );
}
