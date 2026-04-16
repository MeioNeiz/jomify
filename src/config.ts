// Bun reads .env automatically — no dotenv needed.
// Env access is lazy (getters) so tests/CI that import modules which
// transitively reference `config` don't crash on missing vars until
// something actually reads one.

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

export const config = {
  get discordToken() {
    return env("DISCORD_TOKEN");
  },
  get discordClientId() {
    return env("DISCORD_CLIENT_ID");
  },
  get leetifyApiKey() {
    return env("LEETIFY_API_KEY");
  },
  get csfloatApiKey(): string | null {
    return process.env.CSFLOAT_API_KEY ?? null;
  },
  get devGuildId(): string | null {
    return process.env.DEV_GUILD_ID ?? null;
  },
};
