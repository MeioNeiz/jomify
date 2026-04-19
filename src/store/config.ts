import { eq, isNotNull } from "drizzle-orm";
import db from "../db.js";
import { guildConfig } from "../schema.js";

export function setNotifyChannel(guildId: string, channelId: string): void {
  db.insert(guildConfig)
    .values({ guildId, notifyChannelId: channelId })
    .onConflictDoUpdate({
      target: guildConfig.guildId,
      set: { notifyChannelId: channelId },
    })
    .run();
}

export function getNotifyChannel(guildId: string): string | null {
  const row = db
    .select({ notifyChannelId: guildConfig.notifyChannelId })
    .from(guildConfig)
    .where(eq(guildConfig.guildId, guildId))
    .get();
  return row?.notifyChannelId ?? null;
}

export function getAllGuildIds(): string[] {
  return db
    .select({ guildId: guildConfig.guildId })
    .from(guildConfig)
    .where(isNotNull(guildConfig.notifyChannelId))
    .all()
    .map((r) => r.guildId);
}

export function getActivityPings(guildId: string): boolean {
  const row = db
    .select({ activityPings: guildConfig.activityPings })
    .from(guildConfig)
    .where(eq(guildConfig.guildId, guildId))
    .get();
  return (row?.activityPings ?? 0) === 1;
}

export function setActivityPings(guildId: string, enabled: boolean): void {
  db.insert(guildConfig)
    .values({ guildId, activityPings: enabled ? 1 : 0 })
    .onConflictDoUpdate({
      target: guildConfig.guildId,
      set: { activityPings: enabled ? 1 : 0 },
    })
    .run();
}
