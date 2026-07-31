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
settlement report (present days x that role's rate) is generated. Salaried
**payroll employees** can also punch in/out here, from the same "walk up and
punch" screen as wage workers — see "Payroll (salaried) employees" below.

**What it deliberately does not do:** shifts, holidays, leave, statutory
deductions, or on-device enrollment of payroll employees. If you need those,
use the full Amino Farms/Niko payroll module instead — this app is a narrow
sibling to it, not a replacement.

## Who can do what

- **Punch is always open** — no PIN, anyone can walk up and punch. That's
  deliberate: attendance capture shouldn't require unlocking anything.
- **Employees, Calendar, and Settings are PIN-locked.** Enrolling workers,
  correcting attendance history, and sync configuration all require the
  device PIN (`src/lib/pin.ts`) — set once on first launch.

## How it works

- **Storage**: IndexedDB, entirely on-device (`src/lib/db.ts`). Stores:
  `employees`, `punches`, `overrides` (manual day corrections, Wages only),
  `payrollEmployees` (read-only payroll roster mirror), `payrollPunches`,
  `meta` (PIN, sync config/status for both scopes).
- **Face recognition**: [`@vladmandic/human`](https://github.com/vladmandic/human),
  bundled locally (see `scripts/copy-face-models.mjs`) — no CDN calls. A
  single capture is matched against both populations at once — see
  "Payroll (salaried) employees" below for how that combined match works.
- **Sync**: `src/lib/sync.ts` runs two independent outboxes on the same
  adaptive schedule and the same device token — Wages (as below) and
  Payroll (see next section). For Wages: every employee/punch/override gets a
  `syncedAt` timestamp once successfully pushed. Unsynced records are
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

## Payroll (salaried) employees

Payroll employees are a completely different population from Wages workers
— they already exist in Amino Farms' main `employees` table with a
server-generated id, and already have a face-recognition punch flow at the
main app's own browser gate kiosk. This app does **not** enroll them: it
only pulls the existing roster (name, department, designation, face
descriptor) read-only from
`GET /api/attendance-sync/employees`, and pushes punches back via
`POST /api/attendance-sync/punches`. See
`server/routes/payroll-attendance-sync.ts` in the Amino Farms repo for the
receiving end.

- **Same device token as Wages.** It's one physical phone running one app,
  so payroll sync reuses the token configured in Settings — there's no
  separate payroll device registration. Devices are created/revoked from
  Amino Farms' existing **Payroll > Wages > Devices** page.
- **One punch screen, two populations.** The Punch tab matches a captured
  face against wage workers and payroll employees together — whichever
  population the match belongs to determines where the punch is recorded
  and synced. Payroll employees may have several reference descriptors
  (their enrollment photo plus recent live-capture embeddings sent from the
  server) instead of just one; matching pools each identity's best score
  first (`findBestMatchInGalleries` in `src/lib/face.ts`) so that never
  gets confused for a different person.
- **The same employee can also punch at the browser gate kiosk.** That's
  expected, not a conflict — the server recomputes each day's attendance
  from *all* punches for that employee+date regardless of source, so
  kiosk and phone punches merge correctly as long as both eventually sync.
- **Known simplification:** night-shift carryover (an OUT punch after
  midnight staying attached to the prior day's IN) is a kiosk-only,
  real-time feature — a phone-synced post-midnight OUT lands on the new
  calendar day instead. HR's existing attendance exceptions/override tools
  in Amino Farms cover the rare mismatch.

## Setting up sync on a device

One token covers both Wages workers and payroll employees:

1. In the Amino Farms web app, go to **Payroll > Wages > Devices**, tap
   "New device", name it (e.g. "Gate phone"), and copy the token shown —
   it's shown exactly once.
2. On the phone, unlock this app (PIN) and go to **Settings**, paste the
   token into the "Sync to Amino Farms" section, confirm the server URL
   (defaults to `https://aminofarms.replit.app`), and save.
3. Watch the "Wages sync status" and "Payroll sync status" panels further
   down the same screen — each tracks its own outbox independently even
   though they share one token — or tap either "Sync now" to force an
   immediate push.

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
cp debug.keystore ~/.android/debug.keystore   # match CI's signing key, see below
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

## Updating an app already installed on a device

`debug.keystore` (repo root) is a fixed debug signing key, committed so
every build — CI or local — signs with the same certificate. The CI
workflow generates it once on its first run (if not already committed) and
commits it back automatically; after that it just reuses the file. This
matters because Android refuses to install an APK over an existing app of
the same package unless the signatures match — without a fixed key, every
CI run would sign with a random new key and updating would require
uninstalling first (which wipes on-device data: enrolled workers, any
punches not yet synced).

To push an update to a device that already has the app installed:

1. Push your change to `main` (or trigger the workflow manually).
2. Download the `niko-payroll-debug-apk` artifact from that run, unzip to
   get `app-debug.apk`.
3. Transfer it to the phone and tap to install — since it's signed with the
   same key, this installs **in place**, no uninstall, no data loss.

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
employees:        id, name, aadharNumber, photoDataUrl, faceDescriptor, role, isActive, syncedAt?
punches:           id, employeeId, punchType (in/out), timestamp, punchDate, method, matchScore, syncedAt?
overrides:         key ("<employeeId>|<date>"), employeeId, date, status (P/A), note, setAt, syncedAt?
payrollEmployees:  id, empCode, name, department, designation, faceDescriptor, recentEmbeddings, cachedAt
                   — read-only, pulled from the server; this device never writes these rows
payrollPunches:    id, employeeId, empCode, punchType (in/out), timestamp, punchDate, method, matchScore, syncedAt?
meta:              key "cached-roles" — role names last seen from the server (Wages enrollment suggestions only)
                   key "sync-config" — the one device token, shared by Wages and Payroll sync
                   key "sync-status" / "payroll-sync-status" — tracked independently per outbox
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
- **One face per employee for wage workers.** Unlike the reference
  implementation, this app doesn't "relearn" a wage worker's face over time
  from live captures — if someone's appearance changes enough to stop
  matching, re-enroll them from the Employees tab. Payroll employees do get
  multiple reference descriptors (server-side relearn from the kiosk), but
  this device never contributes new ones — it only ever pulls what the
  server already has.
- **No CORS hardening beyond scope.** The `/api/wages/sync` and
  `/api/attendance-sync/*` CORS allowances are intentionally permissive
  (`Access-Control-Allow-Origin: *`) because both endpoints are
  bearer-token authenticated, not cookie-authenticated — there's no ambient
  credential for a random web page to ride along with. Don't reuse that
  pattern for a cookie-authenticated endpoint.
- **No manual-relearn/anti-spoof cross-check for payroll punches.** The
  main app's kiosk lets a guard manually correct a mismatch, which
  cross-checks the capture isn't actually a different enrolled employee
  before it teaches the gallery. This device has no equivalent guard-picks
  flow, so a payroll punch here is always the top face match, taken as-is.
