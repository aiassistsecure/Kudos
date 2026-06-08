// ── Load .env before anything else touches process.env ───────────────────────
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Walk up from dist/ (or src/) to find the workspace root .env
for (const rel of ["../../.env", "../../../.env", "../../../../.env"]) {
  const p = resolve(__dirname, rel);
  if (existsSync(p)) {
    const lines = readFileSync(p, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
    break;
  }
}

import app from "./app";
import { logger } from "./lib/logger";
import { seedDatabase } from "./services/seed";
import { startScheduler, startReplySync } from "./services/scheduler";
import { startBlastScheduler } from "./services/blast";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  logger.info({
    aias: process.env["AIAS_API_KEY"] ? "configured" : "MISSING",
    netrows: process.env["NETROWS_API_KEY"] ? "configured" : "MISSING",
    aiasUrl: process.env["AIAS_API_URL"] ?? "(default)",
    aiasModel: process.env["AIAS_MODEL"] ?? "(default)",
  }, "Integration status at boot");

  seedDatabase(logger)
    .catch((seedErr) => {
      logger.error({ err: seedErr }, "Database seed failed");
    })
    .finally(() => {
      startScheduler(logger);
      startBlastScheduler(logger);
      startReplySync(logger);
    });
});
