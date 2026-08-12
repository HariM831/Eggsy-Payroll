// GPS tagging for punches — mirrors what the main app's browser kiosk
// already sends (see server/routes.ts gate-attendance/punches on the Amino
// Farms side), so a punch from this device carries the same proof-of-location
// as one made at the kiosk.
//
// Deliberately decoupled from the punch itself: a GPS fix can take several
// seconds, and a punch must never wait on it. Instead, primeLocation() is
// fired the moment the Punch screen is ready to recognise someone — well
// before anyone's actually been matched — so a fix has time to arrive in the
// background. getCachedLocation() then just returns whatever's already
// available, synchronously, with no risk of blocking.
import { Geolocation } from "@capacitor/geolocation";

interface CachedFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  at: number;
}

// A fix older than this is more likely to describe where the phone was
// earlier than where it is now (e.g. carried home) than to be a stale-but-
// still-accurate read of the same spot — so it's treated as no fix at all.
const MAX_AGE_MS = 5 * 60_000;

let latest: CachedFix | null = null;
let requesting = false;

export interface LocationStatus {
  ok: boolean;
  /** Human-readable outcome — either the native error (e.g. "Location
   * services are not enabled") or a success summary. This is exactly what
   * used to be swallowed silently; keeping it is what makes a GPS problem
   * visible on the phone itself instead of only traceable from source. */
  message: string;
  at: number;
}

let lastStatus: LocationStatus | null = null;

/** Whatever the last attempt (from either primeLocation or checkLocationNow)
 * actually found, or null if nothing has run yet this session. Settings
 * reads this to show a diagnostic instead of a silent failure. */
export function getLocationStatus(): LocationStatus | null {
  return lastStatus;
}

/** The actual fix attempt, shared by both entry points below so the
 * diagnostic always reflects the real permission/GPS-off/timeout path a
 * punch would have hit — not a separate, possibly-different check. */
async function attemptFix(): Promise<void> {
  try {
    const perm = await Geolocation.checkPermissions();
    if (perm.location !== "granted") {
      const result = await Geolocation.requestPermissions();
      if (result.location !== "granted") {
        lastStatus = { ok: false, message: "Location permission denied", at: Date.now() };
        return;
      }
    }

    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
    latest = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      at: Date.now(),
    };
    lastStatus = { ok: true, message: `Accurate to ${Math.round(pos.coords.accuracy)}m`, at: Date.now() };
  } catch (err: any) {
    // The one place this used to be a bare `catch {}` — e.g. Android's
    // Geolocation plugin rejects with "Location services are not enabled"
    // when the phone's system Location toggle is off, *before* it would
    // ever show a permission dialog. That reason is worth keeping.
    lastStatus = { ok: false, message: err?.message ?? String(err), at: Date.now() };
  }
}

/** Kicks off a location fix in the background. Call once per punch-screen
 * visit (and again after each punch, so the next person gets a fresh-ish
 * fix) — never awaited, never throws; a punch must never be blocked or
 * broken by location trouble. The outcome still lands in getLocationStatus()
 * for Settings to show, even though nothing here waits on it. */
export function primeLocation(): void {
  if (requesting) return;
  requesting = true;
  attemptFix().finally(() => {
    requesting = false;
  });
}

/** For Settings' "Check location" button — runs the same attempt as
 * primeLocation() but awaited, so the UI can show a definitive result
 * immediately instead of polling getLocationStatus(). */
export async function checkLocationNow(): Promise<LocationStatus> {
  await attemptFix();
  return lastStatus!;
}

/** Whatever fix is currently available and fresh enough, or null. Pure,
 * synchronous, side-effect-free — safe to call at the exact moment of a
 * punch without it ever waiting or failing. */
export function getCachedLocation(): { latitude: number; longitude: number; accuracy: number } | null {
  if (!latest) return null;
  if (Date.now() - latest.at > MAX_AGE_MS) return null;
  return { latitude: latest.latitude, longitude: latest.longitude, accuracy: latest.accuracy };
}
