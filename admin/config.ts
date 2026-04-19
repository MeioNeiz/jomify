function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

export const adminConfig = {
  get port() {
    return parseInt(process.env.ADMIN_PORT ?? "8080", 10);
  },
  get sessionSecret() {
    return env("ADMIN_SESSION_SECRET");
  },
  get guildId() {
    return process.env.ADMIN_GUILD_ID ?? env("DEV_GUILD_ID");
  },
  get baseUrl() {
    return env("ADMIN_BASE_URL");
  },
  get discordClientId() {
    return env("DISCORD_CLIENT_ID");
  },
  get discordClientSecret() {
    return env("DISCORD_CLIENT_SECRET");
  },
};
