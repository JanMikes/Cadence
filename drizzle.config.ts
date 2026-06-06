import { defineConfig } from "drizzle-kit";

// SQLite index DB. Migrations are generated into server/drizzle and applied at
// runtime via the bun-sqlite migrator (server/src/db/client.ts). The actual DB
// file lives under ~/.cadence/ (never the repo) — see SECURITY.md.
export default defineConfig({
  dialect: "sqlite",
  schema: "./server/src/db/schema.ts",
  out: "./server/drizzle",
});
