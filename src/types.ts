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
