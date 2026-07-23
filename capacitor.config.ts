import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.aminofarms.nikopayroll",
  appName: "Niko-Payroll",
  webDir: "dist",
  android: {
    allowMixedContent: false,
    adjustMarginsForEdgeToEdge: "force",
  },
  server: {
    androidScheme: "https",
  },
  plugins: {
    // The sync engine POSTs to aminofarms.replit.app, a different origin
    // from the app itself — route it through native HTTP so the WebView's
    // CORS restrictions don't apply, same reasoning as the main Amino Farms
    // Android app's capacitor.config.ts.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
