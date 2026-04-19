import db from "../db.js";
import { apiCalls } from "../schema.js";

export type ApiCallRow = {
  endpoint: string;
  durationMs: number;
  status: number | null;
  retryCount: number;
};

export function saveApiCall(row: ApiCallRow): void {
  db.insert(apiCalls).values(row).run();
}
