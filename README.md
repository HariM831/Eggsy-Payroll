# Niko-Payroll

An offline-first face-punch attendance app for Android. Punching, worker
enrollment, and viewing attendance all work with zero connectivity — the
phone opportunistically pushes what it collected to the central Amino Farms
server (aminofarms.replit.app) whenever it has a connection, instead of
requiring a manual export.

**What it does:** enroll a worker (name, Aadhar number, a face photo, and a
role like "Mason" or "Helper"), punch attendance by face recognition, see a
calendar of who was present/absent, and sync it all to Amino Farms' Payroll
> Wages page, where the daily rate *per role* is configured and the wage
settlement report (present days x that role's rate) is generated.

**What it deliberately does not do:** shifts, holidays, leave, statutory
deductions. If you need those, use the full Amino Farms/Niko payroll module
instead — this app is a narrow sibling to it, not a replacement.

## Who can do what

- **Punch is always open** — no PIN, anyone can walk up and punch. That's
  deliberate: attendance capture shouldn't require unlocking anything.
- **Employees, Calendar, and Settings are PIN-locked.** Enrolling workers,
  correcting attendance history, and sync configuration all require the
  device PIN (`src/lib/pin.ts`) — set once on first launch.

## How it works

- **Storage**: IndexedDB, entirely on-device (`src/lib/db.ts`). Stores:
  `employees`, `punches`, `overrides` (manual day corrections), `meta`
  (PIN, sync config/status).
- **Face recognition**: [`@vladmandic/human`](https://github.com/vladmandic/human),
  bundled locally (see `scripts/copy-face-models.mjs`) — no CDN calls.
- **Sync**: `src/lib/sync.ts` is an outbox — every employee/punch/override
  gets a `syncedAt` timestamp once successfully pushed. Unsynced records are
  retried on a schedule (see below) plus opportunistically: on `online`,
  on app foreground, and right after every punch/enrollment/correction.
  Device → server for identity and attendance, with one exception: the
  current list of role *names* (never rates) rides back on every sync
  response and gets cached locally, so the enrollment form's role field can
  suggest existing roles. See the "Ownership model" section below and
  `server/routes/wages.ts` in the Amino Farms repo for the receiving end.
- **Sync cadence**: every 10 seconds during 7:45–8:30 AM and 4:45–5:30 PM
  (device-local time — shift start/end rush windows, when near-live
  visibility matters most), every 5 minutes otherwise. Adjustable in
  `src/lib/sync.ts` (`RUSH_WINDOWS`, `RUSH_INTERVAL_MS`, `IDLE_INTERVAL_MS`).
- **Auth**: a single on-device PIN, no accounts, no server session — separate
  from the device *sync* token (see below), which authenticates the phone to
  the server, not a person to the phone.
- **Packaging**: [Capacitor](https://capacitorjs.com/) wraps the React/Vite
  web build into an Android WebView app, with `CapacitorHttp` enabled so the
  cross-origin sync requests to aminofarms.replit.app bypass WebView CORS
  restrictions (same approach the main Amino Farms Android build uses).

## Ownership model — what data lives where

| Data | Owner | Direction |
|---|---|---|
| Worker name, Aadhar, photo, face descriptor, role | This device (enrollment needs the camera) | Device → server |
| Role names (list, for the enrollment picker) | Amino Farms Wages > Roles | Server → device (piggybacked on sync response) |
| Daily rate per role | Amino Farms Wages > Roles | Never sent to the device |
| Punches, day overrides | This device | Device → server |

The split is "role on device, money on server": HR assigns each worker's
role during on-device enrollment (who does what), but the actual ₹/day rate
for that role is configured centrally in Amino Farms (what it pays) — so a
rate change applies to everyone in that role without touching the device.
Sync is additive/idempotent: the server upserts workers by their
device-generated id but **never writes a rate** on an incoming sync — rates
are exclusively edited from the Roles tab. Punches are insert-if-new;
overrides are upsert-by-id so a correction made offline overwrites cleanly
once synced. If a worker's role doesn't match any configured role name yet,
the Wages page flags them so HR notices before running payroll.

## Setting up sync on a device

1. In the Amino Farms web app, go to **Payroll > Wages > Devices**, tap
   "New device", name it (e.g. "Gate phone"), and copy the token shown —
   it's shown exactly once.
2. On the phone, unlock this app (PIN) and go to **Settings**, paste the
   token, confirm the server URL (defaults to `https://aminofarms.replit.app`),
   and save.
3. Watch the "Sync status" panel on that same screen, or tap "Sync now" to
   force an immediate push.

## First-time setup (do this once)

```bash
npm install
```

`postinstall` automatically copies the face-recognition model files from
`node_modules/@vladmandic/human/models` into `public/models/` so they ship
inside the app bundle. If that step is ever skipped (e.g. you ran
`npm install --ignore-scripts`), run it manually:

```bash
node scripts/copy-face-models.mjs
```

## Developing on a desktop browser

```bash
npm run dev
```

This runs the full app (IndexedDB, face recognition, camera) in a normal
browser tab — no Android device needed for day-to-day UI work. Grant camera
permission when the browser asks. Sync also works from the browser (the
Amino Farms `/api/wages/sync` endpoint has narrow CORS enabled specifically
for this path), so you can test the whole loop without a device build.

## Building the Android APK

**Option A — GitHub Actions (recommended, no local Android setup needed).**
Push to `main` (or run the workflow manually from the Actions tab). The
`Build Android APK` workflow (`.github/workflows/build-apk.yml`) builds a
debug-signed APK and uploads it as a downloadable artifact. Debug-signed is
fine for installing directly on your own phone via "install from unknown
sources" — you don't need this on the Play Store.

**Option B — locally, with Android Studio installed:**

```bash
npm install
npm run build
npx cap add android          # first time only — generates the android/ project (gitignored)
node scripts/patch-android-manifest.mjs   # adds the camera permission
npx cap sync android
npx cap open android         # opens Android Studio; build/run from there
```

The `android/` directory is intentionally **not committed** (see
`.gitignore`) — it's regenerated by `cap add android` each time, matching
how the reference Amino Farms Android build works. `patch-android-manifest.mjs`
re-adds the camera permission every time it's regenerated, since a fresh
`cap add` wipes any manual manifest edits.

## The one thing to verify first on a real device

Live camera access via `getUserMedia` inside an Android WebView is the
single biggest unverified risk in this build — I couldn't test it without a
device or the ability to run a build myself. Capacitor's WebView generally
supports it once the `CAMERA` permission is declared (which the manifest
patch script handles) and the user grants the runtime permission prompt, but
**test the Punch screen's camera preview on a real phone before relying on
this app**. If `getUserMedia` doesn't start the camera, the fallback is
swapping `CameraCapture.tsx` to a native camera plugin
(e.g. `capacitor-community/camera-preview`) instead of the raw browser API —
happy to make that change if needed.

## Data model

```
employees: id, name, aadharNumber, photoDataUrl, faceDescriptor, role, isActive, syncedAt?
punches:   id, employeeId, punchType (in/out), timestamp, punchDate, method, matchScore, syncedAt?
overrides: key ("<employeeId>|<date>"), employeeId, date, status (P/A), note, setAt, syncedAt?
meta:      key "cached-roles" — role names last seen from the server (enrollment suggestions only)
```

That's the whole schema — see `src/types.ts` and `src/lib/attendance.ts`.

## Known gaps / deliberate scope cuts

- **No encryption at rest.** IndexedDB data (including Aadhar numbers and
  face embeddings) is stored unencrypted on the device. Given this holds
  PII, consider adding device-level encryption (Android full-disk encryption
  is on by default on modern phones, which helps, but app-level encryption
  is stronger). Flagging this rather than silently skipping it.
- **No offline backup beyond sync.** If the phone is lost or factory-reset
  before a sync completes, whatever hasn't synced yet is gone — the sync
  cadence (10s in rush windows) is designed to keep that window small, but
  it isn't zero.
- **Sync is one-way.** If two devices ever enroll the same real person
  independently, they become two separate worker records server-side —
  there's no dedup/merge logic. Fine for one device; would need real
  thought before adding a second.
- **One face per employee.** Unlike the reference implementation, this app
  doesn't "relearn" a face over time from live captures — if someone's
  appearance changes enough to stop matching, re-enroll them from the
  Employees tab.
- **No CORS hardening beyond scope.** The `/api/wages/sync` CORS allowance
  is intentionally permissive (`Access-Control-Allow-Origin: *`) because the
  endpoint is bearer-token authenticated, not cookie-authenticated — there's
  no ambient credential for a random web page to ride along with. Don't
  reuse that pattern for a cookie-authenticated endpoint.
