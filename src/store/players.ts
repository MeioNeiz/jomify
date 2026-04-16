import { and, eq } from "drizzle-orm";
import db from "../db.js";
import { trackedPlayers } from "../schema.js";

export function getTrackedPlayers(guildId: string): string[] {
  return db
    .select({ steamId: trackedPlayers.steamId })
    .from(trackedPlayers)
    .where(eq(trackedPlayers.guildId, guildId))
    .all()
    .map((r) => r.steamId);
}

export function getAllTrackedSteamIds(): string[] {
  return db
    .selectDistinct({ steamId: trackedPlayers.steamId })
    .from(trackedPlayers)
    .all()
    .map((r) => r.steamId);
}

export function getGuildsForSteamId(steamId: string): string[] {
  return db
    .select({ guildId: trackedPlayers.guildId })
    .from(trackedPlayers)
    .where(eq(trackedPlayers.steamId, steamId))
    .all()
    .map((r) => r.guildId);
}

export function addTrackedPlayer(guildId: string, steamId: string): void {
  db.insert(trackedPlayers).values({ guildId, steamId }).onConflictDoNothing().run();
}

export function removeTrackedPlayer(guildId: string, steamId: string): void {
  db.delete(trackedPlayers)
    .where(and(eq(trackedPlayers.guildId, guildId), eq(trackedPlayers.steamId, steamId)))
    .run();
}
