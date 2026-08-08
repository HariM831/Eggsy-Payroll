import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "https://aminofarms.replit.app",
        changeOrigin: true,
        secure: true,
        // The server rejects requests carrying a browser Origin header
        // (returns 403 with no CORS headers, which the browser surfaces as
        // "Failed to fetch"). Strip it so the proxied request looks the
        // same as a native app / curl request, which the server accepts.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
