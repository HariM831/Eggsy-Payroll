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

/** Kicks off a location fix in the background. Call once per punch-screen
 * visit (and again after each punch, so the next person gets a fresh-ish
 * fix) — never awaited, never throws. Every failure mode (permission
 * denied, GPS off, no signal, timeout) is swallowed here so a punch can
 * never be blocked or broken by location trouble. */
export function primeLocation(): void {
  if (requesting) return;
  requesting = true;

  (async () => {
    try {
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== "granted") {
        const result = await Geolocation.requestPermissions();
        if (result.location !== "granted") return;
      }

      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
      latest = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: Date.now(),
      };
    } catch {
      // Permission denied / GPS off / no signal / timed out — leave
      // `latest` as whatever it already was; staleness is handled by
      // getCachedLocation(), not by clearing it here.
    } finally {
      requesting = false;
    }
  })();
}

/** Whatever fix is currently available and fresh enough, or null. Pure,
 * synchronous, side-effect-free — safe to call at the exact moment of a
 * punch without it ever waiting or failing. */
export function getCachedLocation(): { latitude: number; longitude: number; accuracy: number } | null {
  if (!latest) return null;
  if (Date.now() - latest.at > MAX_AGE_MS) return null;
  return { latitude: latest.latitude, longitude: latest.longitude, accuracy: latest.accuracy };
}
