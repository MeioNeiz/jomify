// Bun reads .env automatically — no dotenv needed

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

export const config = {
  discordToken: env("DISCORD_TOKEN"),
  discordClientId: env("DISCORD_CLIENT_ID"),
  leetifyApiKey: env("LEETIFY_API_KEY"),
  csfloatApiKey: process.env.CSFLOAT_API_KEY ?? null,
  devGuildId: process.env.DEV_GUILD_ID ?? null,
} as const;
