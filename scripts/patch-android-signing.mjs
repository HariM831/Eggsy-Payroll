// Like patch-android-manifest.mjs, this patches the regenerated
// android/app/build.gradle after `npx cap add android` so every build —
// CI or local, on any machine — signs with the same debug.keystore
// committed to the repo root. No copying to ~/.android needed.
// Idempotent: safe to run more than once.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const gradlePath = "android/app/build.gradle";

if (!existsSync(gradlePath)) {
  console.error(`[patch-android-signing] ${gradlePath} not found — run "npx cap add android" first.`);
  process.exit(1);
}

let gradle = readFileSync(gradlePath, "utf8");
let changed = false;

// ── Add signingConfigs block inside android { } ──────────────────
const SIGNING_CONFIG_BLOCK = `    signingConfigs {
        debug {
            storeFile rootProject.file('../debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;

if (!gradle.includes("storeFile rootProject.file('../debug.keystore')")) {
  // Insert right after the android { opening line
  gradle = gradle.replace(
    /(android\s*\{)/,
    `$1\n${SIGNING_CONFIG_BLOCK}`
  );
  changed = true;
}

// ── Pin debug buildType to our signingConfig ─────────────────────
if (gradle.includes("signingConfig signingConfigs.debug")) {
  // Already set — nothing to do for the buildType
} else if (gradle.includes("debug {")) {
  // Insert signingConfig inside the debug block
  gradle = gradle.replace(
    /(debug\s*\{)/,
    `$1\n            signingConfig signingConfigs.debug`
  );
  changed = true;
} else {
  // No debug block found — add one inside buildTypes
  gradle = gradle.replace(
    /(buildTypes\s*\{)/,
    `$1\n        debug {\n            signingConfig signingConfigs.debug\n        }`
  );
  changed = true;
}

if (changed) {
  writeFileSync(gradlePath, gradle);
  console.log("[patch-android-signing] pinned signingConfig to repo debug.keystore.");
} else {
  console.log("[patch-android-signing] already up to date.");
}
