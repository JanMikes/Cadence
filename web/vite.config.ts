import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Ports are configurable via env (single source of truth) so Cadence can dodge
// collisions with other local dev servers running at the same time. Set
// CADENCE_PORT (gateway) and/or CADENCE_WEB_PORT (this dev server) — e.g. inline
// `CADENCE_PORT=4600 bun run dev`, or in a gitignored .env (see .env.example).
const apiPort = process.env.CADENCE_PORT ?? "4477";
const webPort = Number(process.env.CADENCE_WEB_PORT ?? "5173");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    // If the web port is taken, let Vite pick the next free one (it logs the URL).
    strictPort: false,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});
