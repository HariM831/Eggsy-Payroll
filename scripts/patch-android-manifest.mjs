// `npx cap add android` generates AndroidManifest.xml fresh every time (the
// android/ project isn't committed — see .gitignore). This script patches in
// the CAMERA permission the punch/enrollment screens need, right after
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
  console.log("[patch-android-manifest] added camera permission/features.");
} else {
  console.log("[patch-android-manifest] already up to date.");
}
