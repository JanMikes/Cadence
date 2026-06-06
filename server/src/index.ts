import { startGateway } from "./gateway";

// The port is configurable via CADENCE_PORT so Cadence can dodge collisions with
// other local dev servers; 4477 merely avoids well-known defaults (4317 = OTLP).
const PORT = Number(process.env.CADENCE_PORT ?? 4477);

try {
  const gateway = startGateway({ port: PORT });
  console.log(`[cadence] gateway listening on ${gateway.url}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void gateway.stop().finally(() => process.exit(0));
    });
  }
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
