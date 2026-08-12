export interface Employee {
  id: string;
  name: string;
  aadharNumber: string;
  photoDataUrl: string;
  /** Face embedding captured from the enrollment photo — used to match punches. */
  faceDescriptor: number[];
  /** Work-type (e.g. "Mason", "Helper") — the daily rate for it is set centrally in Amino Farms, never here. */
  role: string | null;
  isActive: boolean;
  createdAt: number;
  /** Set once this record has been pushed to aminofarms.replit.app. Absent/false = pending sync. */
  syncedAt?: number;
}

export type PunchType = "in" | "out";
export type PunchMethod = "face" | "manual";

export interface Punch {
  id: string;
  employeeId: string;
  punchType: PunchType;
  /** unix ms */
  timestamp: number;
  /** local calendar date the punch belongs to, YYYY-MM-DD (device-local time) */
  punchDate: string;
  method: PunchMethod;
  /** cosine similarity score for a face-matched punch (0..1) */
  matchScore: number | null;
  /** small audit snapshot from the camera at punch time */
  capturedPhotoDataUrl: string | null;
  /** set when HR manually corrects/creates a punch after the fact */
  note: string | null;
  /** GPS at punch time — null if location was denied/unavailable/timed out, or
   * for a manual punch. Best-effort: never blocks the punch itself. */
  latitude: number | null;
  longitude: number | null;
  /** metres, as reported by the OS */
  accuracy: number | null;
  /** Set once this record has been pushed to aminofarms.replit.app. Absent/false = pending sync. */
  syncedAt?: number;
}

// Payroll (salaried) employees — a read-only local mirror of the main app's
// payroll roster, pulled via sync.ts. Unlike Employee (Wages workers,
// enrolled ON this device), this device never creates or edits these rows —
// the server owns identity and enrollment (main app's face-enrollment
// page); the device only pulls the roster to match punches against.
/** The employee's latest punch today according to the SERVER — so it also
 * covers punches this device never saw, made at the main app's browser gate
 * kiosk or on another phone. */
export interface LastPunchToday {
  punchType: PunchType;
  /** unix ms */
  timestamp: number;
  punchDate: string;
}

export interface PayrollEmployee {
  id: string;
  empCode: string;
  name: string;
  department: string | null;
  designation: string | null;
  faceDescriptor: number[] | null;
  /** Day-diverse recent live-capture embeddings from the server, for matching tolerance. */
  recentEmbeddings: number[][];
  /** Latest punch the server knows about for today, used to decide whether
   * the next punch is an in or an out. Optional: rows cached before this
   * field existed, and days with no punch yet, both leave it absent/null. */
  lastPunchToday?: LastPunchToday | null;
  /** unix ms this roster row was last pulled from the server. */
  cachedAt: number;
}

export interface PayrollPunch {
  id: string;
  employeeId: string;
  empCode: string;
  punchType: PunchType;
  /** unix ms */
  timestamp: number;
  /** local calendar date the punch belongs to, YYYY-MM-DD (device-local time) */
  punchDate: string;
  method: PunchMethod;
  matchScore: number | null;
  /** GPS at punch time — null if location was denied/unavailable/timed out. */
  latitude: number | null;
  longitude: number | null;
  /** metres, as reported by the OS */
  accuracy: number | null;
  /** Set once this record has been pushed to aminofarms.replit.app. Absent/false = pending sync. */
  syncedAt?: number;
}

export type DayStatus = "P" | "A";

export interface DayResolution {
  date: string; // YYYY-MM-DD
  status: DayStatus;
  firstIn: number | null;
  lastOut: number | null;
  hours: number;
  /** true when the day has an unmatched trailing "in" (forgot to punch out) */
  openIn: boolean;
  /** true when HR manually set this day's status rather than it being derived from punches */
  manual: boolean;
}
