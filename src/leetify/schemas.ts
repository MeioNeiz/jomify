import { z } from "zod";

// Runtime schemas for Leetify API responses. We only validate the fields
// that jomify actually reads; unknown fields pass through via
// `.passthrough()` so Leetify can add new keys without breaking us.
//
// These schemas are not re-exported as types — callers should keep using
// the interfaces in ./types.ts. The schemas exist purely for runtime
// validation in ./client.ts.

const recentMatchSchema = z
  .object({
    id: z.string(),
    finished_at: z.string(),
    data_source: z.string(),
    outcome: z.string(),
    rank: z.number(),
    rank_type: z.string(),
    map_name: z.string(),
    leetify_rating: z.number(),
    score: z.tuple([z.number(), z.number()]),
    preaim: z.number(),
    reaction_time_ms: z.number(),
    accuracy_enemy_spotted: z.number(),
    accuracy_head: z.number(),
    spray_accuracy: z.number(),
  })
  .passthrough();

const ranksSchema = z
  .object({
    leetify: z.number().nullable(),
    premier: z.number().nullable(),
    faceit: z.number().nullable(),
    faceit_elo: z.number().nullable(),
    wingman: z.number().nullable(),
    renown: z.number().nullable(),
    competitive: z.array(
      z.object({ map_name: z.string(), rank: z.number() }).passthrough(),
    ),
  })
  .passthrough();

const ratingSchema = z
  .object({
    aim: z.number(),
    positioning: z.number(),
    utility: z.number(),
    clutch: z.number(),
    opening: z.number(),
    ct_leetify: z.number(),
    t_leetify: z.number(),
  })
  .passthrough();

const profileStatsSchema = z
  .object({
    accuracy_enemy_spotted: z.number(),
    accuracy_head: z.number(),
    counter_strafing_good_shots_ratio: z.number(),
    ct_opening_aggression_success_rate: z.number(),
    ct_opening_duel_success_percentage: z.number(),
    flashbang_hit_foe_avg_duration: z.number(),
    flashbang_hit_foe_per_flashbang: z.number(),
    flashbang_hit_friend_per_flashbang: z.number(),
    flashbang_leading_to_kill: z.number(),
    flashbang_thrown: z.number(),
    he_foes_damage_avg: z.number(),
    he_friends_damage_avg: z.number(),
    preaim: z.number(),
    reaction_time_ms: z.number(),
    spray_accuracy: z.number(),
    t_opening_aggression_success_rate: z.number(),
    t_opening_duel_success_percentage: z.number(),
    traded_deaths_success_percentage: z.number(),
    trade_kill_opportunities_per_round: z.number(),
    trade_kills_success_percentage: z.number(),
    utility_on_death_avg: z.number(),
  })
  .passthrough();

export const leetifyProfileSchema = z
  .object({
    name: z.string(),
    steam64_id: z.string(),
    privacy_mode: z.string(),
    winrate: z.number(),
    total_matches: z.number(),
    first_match_date: z.string().nullable(),
    ranks: ranksSchema,
    rating: ratingSchema,
    stats: profileStatsSchema,
    recent_matches: z.array(recentMatchSchema),
    recent_teammates: z.array(
      z
        .object({ steam64_id: z.string(), recent_matches_count: z.number() })
        .passthrough(),
    ),
  })
  .passthrough();

const playerStatsSchema = z
  .object({
    steam64_id: z.string(),
    name: z.string(),
    mvps: z.number(),
    preaim: z.number(),
    reaction_time: z.number(),
    accuracy: z.number(),
    accuracy_enemy_spotted: z.number(),
    accuracy_head: z.number(),
    shots_fired_enemy_spotted: z.number(),
    shots_fired: z.number(),
    shots_hit_enemy_spotted: z.number(),
    shots_hit_friend: z.number(),
    shots_hit_friend_head: z.number(),
    shots_hit_foe: z.number(),
    shots_hit_foe_head: z.number(),
    utility_on_death_avg: z.number(),
    he_foes_damage_avg: z.number(),
    he_friends_damage_avg: z.number(),
    he_thrown: z.number(),
    molotov_thrown: z.number(),
    smoke_thrown: z.number(),
    counter_strafing_shots_all: z.number(),
    counter_strafing_shots_bad: z.number(),
    counter_strafing_shots_good: z.number(),
    counter_strafing_shots_good_ratio: z.number(),
    flashbang_hit_foe: z.number(),
    flashbang_leading_to_kill: z.number(),
    flashbang_hit_foe_avg_duration: z.number(),
    flashbang_hit_friend: z.number(),
    flashbang_thrown: z.number(),
    flash_assist: z.number(),
    score: z.number(),
    initial_team_number: z.number(),
    spray_accuracy: z.number(),
    total_kills: z.number(),
    total_deaths: z.number(),
    kd_ratio: z.number(),
    rounds_survived: z.number(),
    rounds_survived_percentage: z.number(),
    dpr: z.number(),
    total_assists: z.number(),
    total_damage: z.number(),
    leetify_rating: z.number().nullable(),
    ct_leetify_rating: z.number().nullable(),
    t_leetify_rating: z.number().nullable(),
    multi1k: z.number(),
    multi2k: z.number(),
    multi3k: z.number(),
    multi4k: z.number(),
    multi5k: z.number(),
    rounds_count: z.number(),
    rounds_won: z.number(),
    rounds_lost: z.number(),
    total_hs_kills: z.number(),
    trade_kill_opportunities: z.number(),
    trade_kill_attempts: z.number(),
    trade_kills_succeed: z.number(),
    trade_kill_attempts_percentage: z.number(),
    trade_kills_success_percentage: z.number(),
    trade_kill_opportunities_per_round: z.number(),
    traded_death_opportunities: z.number(),
    traded_death_attempts: z.number(),
    traded_deaths_succeed: z.number(),
    traded_death_attempts_percentage: z.number(),
    traded_deaths_success_percentage: z.number(),
    traded_deaths_opportunities_per_round: z.number(),
  })
  .passthrough();

export const leetifyMatchDetailsSchema = z
  .object({
    id: z.string(),
    finished_at: z.string(),
    data_source: z.string(),
    data_source_match_id: z.string(),
    map_name: z.string(),
    has_banned_player: z.boolean(),
    replay_url: z.string().optional(),
    team_scores: z.tuple([
      z.object({ team_number: z.number(), score: z.number() }).passthrough(),
      z.object({ team_number: z.number(), score: z.number() }).passthrough(),
    ]),
    stats: z.array(playerStatsSchema),
  })
  .passthrough();

export const leetifyMatchHistorySchema = z.array(leetifyMatchDetailsSchema);
