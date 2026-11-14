import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In dev, /api/* is proxied to the Rust gateway (prefix stripped), so the browser
// never talks to the science service directly and no CORS setup is needed.
const apiTarget = process.env.SELENE_API_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  test: { environment: "node" },
});
