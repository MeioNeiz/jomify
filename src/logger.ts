import { join } from "node:path";
import pino from "pino";
import { config } from "./config.js";

const isDev = process.env.NODE_ENV !== "production";
const LOG_DIR = join(import.meta.dir, "..");

const log = pino({
  level: "debug",
  transport: {
    targets: [
      // stdout — info+ in dev (pretty), warn+ in prod (JSON)
      isDev
        ? { target: "pino-pretty", options: { colorize: true }, level: "info" }
        : { target: "pino/file", options: { destination: 1 }, level: "warn" },
      // error.log — errors only
      {
        target: "pino/file",
        options: { destination: join(LOG_DIR, "error.log") },
        level: "error",
      },
      // combined.log — everything info+
      {
        target: "pino/file",
        options: { destination: join(LOG_DIR, "combined.log") },
        level: "info",
      },
      // debug.log — everything including debug
      {
        target: "pino/file",
        options: { destination: join(LOG_DIR, "debug.log") },
        level: "debug",
      },
    ],
  },
});

// Hook log.error to also fire a Healthchecks.io fail ping. Sends
// a `/fail` POST so the monitoring service notifies us out-of-band —
// useful for errors you wouldn't otherwise notice until next time
// you open Discord.
const originalError = log.error.bind(log);
log.error = ((...args: unknown[]) => {
  if (config.healthcheckUrl) {
    fetch(`${config.healthcheckUrl}/fail`, { method: "POST" }).catch(() => undefined);
  }
  return (originalError as (...a: unknown[]) => void)(...args);
}) as typeof log.error;

export default log;
