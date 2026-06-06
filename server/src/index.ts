import {
  APP_NAME,
  APP_TAGLINE,
  SCHEMA_VERSION,
  type HealthStatus,
} from "@cadence/shared";

// Bind to localhost only — the machine is the trust boundary (SECURITY.md).
// The port is configurable via CADENCE_PORT so Cadence can dodge collisions with
// other local dev servers; 4477 merely avoids well-known defaults (4317 = OTLP).
const PORT = Number(process.env.CADENCE_PORT ?? 4477);

function start() {
  try {
    return Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);

        if (pathname === "/api/health") {
          const body: HealthStatus = { ok: true, app: APP_NAME, version: SCHEMA_VERSION };
          return Response.json(body);
        }

        return new Response(`${APP_NAME} gateway — ${APP_TAGLINE}\n`, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === "EADDRINUSE") {
      console.error(
        `[cadence] port ${PORT} is already in use. Pick a free port, e.g.\n` +
          `  CADENCE_PORT=4600 bun run dev\n` +
          `or set CADENCE_PORT in a .env file (see .env.example).`,
      );
      process.exit(1);
    }
    throw err;
  }
}

const server = start();
console.log(`[cadence] gateway listening on http://localhost:${server.port}`);
