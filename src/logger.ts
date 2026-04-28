import { join } from "node:path";
import pino from "pino";
import { config } from "./config.js";

const isDev = process.env.NODE_ENV !== "production";
const isTest = process.env.NODE_ENV === "test";
const LOG_DIR = join(import.meta.dir, "..");
// In tests, redirect file destinations to /dev/null so test runs don't
// pollute the on-disk logs (or trigger the Healthchecks /fail ping
// hooked to log.error below).
const fileDest = (name: string) => (isTest ? "/dev/null" : join(LOG_DIR, name));

const log = pino({
  level: "debug",
  transport: {
    targets: [
      // stdout — info+ in dev (pretty), warn+ in prod (JSON)
      isDev
        ? { target: "pino-pretty", options: { colorize: true }, level: "info" }
        : { target: "pino/file", options: { destination: 1 }, level: "warn" },
      {
        target: "pino/file",
        options: { destination: fileDest("error.log") },
        level: "error",
      },
      {
        target: "pino/file",
        options: { destination: fileDest("combined.log") },
        level: "info",
      },
      {
        target: "pino/file",
        options: { destination: fileDest("debug.log") },
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
  if (config.healthcheckUrl && !isTest) {
    fetch(`${config.healthcheckUrl}/fail`, { method: "POST" }).catch(() => undefined);
  }
  return (originalError as (...a: unknown[]) => void)(...args);
}) as typeof log.error;

export default log;
