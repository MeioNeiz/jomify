import { join } from "node:path";
import pino from "pino";

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

export default log;
