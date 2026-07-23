export type View = "punch" | "employees" | "calendar" | "settings";

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
function IconSettings() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path
        strokeLinecap="round"
        d="M19.4 13a7.97 7.97 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a8 8 0 0 0-1.7-1L14.9 3h-4l-.4 2.9a8 8 0 0 0-1.7 1l-2.5-1-2 3.5L6.4 11a7.97 7.97 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a8 8 0 0 0 1.7 1l.4 2.9h4l.4-2.9a8 8 0 0 0 1.7-1l2.5 1 2-3.5-2.1-1.6Z"
      />
    </svg>
  );
}
function IconLock() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3Z" />
    </svg>
  );
}

const TABS: { id: View; label: string; Icon: () => JSX.Element; guarded?: boolean }[] = [
  { id: "punch", label: "Punch", Icon: IconCamera },
  { id: "employees", label: "Employees", Icon: IconUsers, guarded: true },
  { id: "calendar", label: "Calendar", Icon: IconCalendar, guarded: true },
  { id: "settings", label: "Settings", Icon: IconSettings, guarded: true },
];

export default function BottomNav({
  active,
  onChange,
  unlocked,
}: {
  active: View;
  onChange: (v: View) => void;
  unlocked: boolean;
}) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t flex pb-[env(safe-area-inset-bottom)] z-20">
      {TABS.map(({ id, label, Icon, guarded }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`relative flex-1 flex flex-col items-center py-2 text-xs gap-0.5 ${
            active === id ? "text-brand font-medium" : "text-gray-500"
          }`}
        >
          <span className="relative">
            <Icon />
            {guarded && !unlocked && (
              <span className="absolute -top-1 -right-1.5 bg-gray-400 text-white rounded-full p-[3px]">
                <IconLock />
              </span>
            )}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}
