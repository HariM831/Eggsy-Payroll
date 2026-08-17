/// <reference types="vite/client" />

// Injected at build time by vite.config.ts (see §7 of the pairing plan):
// __APP_VERSION_CODE__ mirrors the Android versionCode (monotonic int, from
// $APP_VERSION_CODE / github.run_number), __APP_VERSION_NAME__ mirrors the
// Android versionName (package.json "version"). Used as the browser fallback
// in src/lib/device.ts when the Capacitor App plugin isn't available.
declare const __APP_VERSION_CODE__: number;
declare const __APP_VERSION_NAME__: string;
