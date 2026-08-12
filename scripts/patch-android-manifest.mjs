// `npx cap add android` generates AndroidManifest.xml fresh every time (the
// android/ project isn't committed — see .gitignore). This script patches in
// the permissions the punch/enrollment screens need — camera always, plus
// location for the GPS tag attached to each punch — right after
// `cap add android` runs. Idempotent: safe to run more than once.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const manifestPath = "android/app/src/main/AndroidManifest.xml";

if (!existsSync(manifestPath)) {
  console.error(`[patch-android-manifest] ${manifestPath} not found — run "npx cap add android" first.`);
  process.exit(1);
}

let xml = readFileSync(manifestPath, "utf8");
const needed = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="true" />',
  '<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',
  // Coarse is requested alongside fine because Android's permission dialog
  // offers "approximate" as a user-chosen downgrade from "precise" — the app
  // must declare both or that dialog option silently fails. GPS itself
  // (used for the accuracy fine gives) is not required=true on the
  // <uses-feature> below, since a punch should still work without it.
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-feature android:name="android.hardware.location.gps" android:required="false" />',
  // Lets the encrypted backup live outside the app's own folder so it
  // survives an uninstall (see BACKUP_DIRECTORY in src/lib/backup.ts).
  // Declaring it is not enough: Android treats this as a "special" permission
  // that can never be granted from an in-app dialog, so it must be switched on
  // per device under Settings > Apps > Niko-Payroll > Special app access >
  // All files access. Without it the backup silently no-ops; nothing else is
  // affected.
  '<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
];

let changed = false;
for (const line of needed) {
  const tag = line.match(/android:name="([^"]+)"/)[1];
  if (xml.includes(tag)) continue;
  xml = xml.replace(/<manifest[^>]*>/, (m) => `${m}\n    ${line}`);
  changed = true;
}

if (changed) {
  writeFileSync(manifestPath, xml);
  console.log("[patch-android-manifest] added camera/location permissions and features.");
} else {
  console.log("[patch-android-manifest] already up to date.");
}
