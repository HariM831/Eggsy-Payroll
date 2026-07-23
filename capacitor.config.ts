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
};

export default config;
