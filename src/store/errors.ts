import db from "../db.js";
import { errors } from "../schema.js";

export type ErrorRow = {
  source: string;
  level: "warn" | "error";
  message: string;
  stack: string | null;
  extra: string | null;
};

export function saveError(row: ErrorRow): void {
  db.insert(errors).values(row).run();
}
