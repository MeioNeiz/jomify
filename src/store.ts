import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_PATH = join(import.meta.dir, "..", "data.json");

// guildId -> Set of steam64 IDs
export const trackedPlayers = new Map<string, Set<string>>();

export function loadPlayers(): void {
  if (!existsSync(DATA_PATH)) return;

  const raw = JSON.parse(
    readFileSync(DATA_PATH, "utf-8")
  ) as Record<string, string[]>;

  for (const [guildId, ids] of Object.entries(raw)) {
    trackedPlayers.set(guildId, new Set(ids));
  }
}

export function savePlayers(): void {
  const obj: Record<string, string[]> = {};
  for (const [guildId, ids] of trackedPlayers) {
    obj[guildId] = [...ids];
  }
  writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2));
}
