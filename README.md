# Jomify

CS2 stats Discord bot

## Features

- `/stats` `/compare` - Player stats and head-to-head comparisons
- `/leaderboard` - Premier rankings with change tracking
- `/shame` - Worst recent game across tracked players
- `/flash` - Flashbang shame stats (team vs enemy)
- `/track` `/import` `/link` - Player management
- `/setchannel` - Auto-notifications for rank ups, great/bad games
- Full match history stored in SQLite (66 stats per player per match)

## Setup

```bash
cp .env.example .env  # add DISCORD_TOKEN, DISCORD_CLIENT_ID, LEETIFY_API_KEY
bun install
bun run src/register.ts  # register slash commands
bun run src/index.ts      # start the bot
```

## Dev

```bash
bun run src/cli.ts <command>  # test commands without Discord
bun test                      # run tests
```
