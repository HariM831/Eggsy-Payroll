export type View = "punch" | "employees" | "calendar" | "report";

function IconCamera() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 8h3l2-2h6l2 2h3v11H4z" strokeLinejoin="round" />
      <circle cx="12" cy="14" r="3.2" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" strokeLinecap="round" />
      <circle cx="17" cy="9" r="2.3" />
      <path d="M15.5 14.3c2.2.5 4 2.2 4.5 4.7" strokeLinecap="round" />
    </svg>
  );
}
function IconCalendar() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}
function IconReport() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 3h9l3 3v15H6z" strokeLinejoin="round" />
      <path d="M9 12h6M9 16h6M9 8h3" strokeLinecap="round" />
    </svg>
  );
}

const TABS: { id: View; label: string; Icon: () => JSX.Element }[] = [
  { id: "punch", label: "Punch", Icon: IconCamera },
  { id: "employees", label: "Employees", Icon: IconUsers },
  { id: "calendar", label: "Calendar", Icon: IconCalendar },
  { id: "report", label: "Report", Icon: IconReport },
];

export default function BottomNav({ active, onChange }: { active: View; onChange: (v: View) => void }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t flex pb-[env(safe-area-inset-bottom)] z-20">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex-1 flex flex-col items-center py-2 text-xs gap-0.5 ${
            active === id ? "text-brand font-medium" : "text-gray-500"
          }`}
        >
          <Icon />
          {label}
        </button>
      ))}
    </nav>
  );
}
