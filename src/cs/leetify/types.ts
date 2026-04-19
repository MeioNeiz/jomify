export interface LeetifyProfile {
  name: string;
  steam64_id: string;
  privacy_mode: string;
  winrate: number;
  total_matches: number;
  first_match_date: string | null;
  ranks: {
    leetify: number | null;
    premier: number | null;
    faceit: number | null;
    faceit_elo: number | null;
    wingman: number | null;
    renown: number | null;
    competitive: { map_name: string; rank: number }[];
  };
  rating: {
    aim: number;
    positioning: number;
    utility: number;
    clutch: number;
    opening: number;
    ct_leetify: number;
    t_leetify: number;
  };
  stats: {
    accuracy_enemy_spotted: number;
    accuracy_head: number;
    counter_strafing_good_shots_ratio: number;
    ct_opening_aggression_success_rate: number;
    ct_opening_duel_success_percentage: number;
    flashbang_hit_foe_avg_duration: number;
    flashbang_hit_foe_per_flashbang: number;
    flashbang_hit_friend_per_flashbang: number;
    flashbang_leading_to_kill: number;
    flashbang_thrown: number;
    he_foes_damage_avg: number;
    he_friends_damage_avg: number;
    preaim: number;
    reaction_time_ms: number;
    spray_accuracy: number;
    t_opening_aggression_success_rate: number;
    t_opening_duel_success_percentage: number;
    traded_deaths_success_percentage: number;
    trade_kill_opportunities_per_round: number;
    trade_kills_success_percentage: number;
    utility_on_death_avg: number;
  };
  recent_matches: LeetifyRecentMatch[];
  recent_teammates: {
    steam64_id: string;
    recent_matches_count: number;
  }[];
}

export interface LeetifyRecentMatch {
  id: string;
  finished_at: string;
  data_source: string;
  outcome: string;
  rank: number;
  rank_type?: number | null;
  map_name: string;
  leetify_rating: number;
  score: [number, number];
  preaim: number;
  reaction_time_ms: number;
  accuracy_enemy_spotted: number;
  accuracy_head: number;
  spray_accuracy: number;
}

export interface LeetifyMatchDetails {
  id: string;
  finished_at: string;
  data_source: string;
  data_source_match_id: string;
  map_name: string;
  has_banned_player: boolean;
  replay_url?: string;
  team_scores: [
    { team_number: number; score: number },
    { team_number: number; score: number },
  ];
  stats: LeetifyPlayerStats[];
}

export interface LeetifyPlayerStats {
  steam64_id: string;
  name: string;
  mvps: number;
  preaim: number;
  reaction_time: number;
  accuracy: number;
  accuracy_enemy_spotted: number;
  accuracy_head: number;
  shots_fired_enemy_spotted: number;
  shots_fired: number;
  shots_hit_enemy_spotted: number;
  shots_hit_friend: number;
  shots_hit_friend_head: number;
  shots_hit_foe: number;
  shots_hit_foe_head: number;
  utility_on_death_avg: number;
  he_foes_damage_avg: number;
  he_friends_damage_avg: number;
  he_thrown: number;
  molotov_thrown: number;
  smoke_thrown: number;
  counter_strafing_shots_all: number;
  counter_strafing_shots_bad: number;
  counter_strafing_shots_good: number;
  counter_strafing_shots_good_ratio: number;
  flashbang_hit_foe: number;
  flashbang_leading_to_kill: number;
  flashbang_hit_foe_avg_duration: number;
  flashbang_hit_friend: number;
  flashbang_thrown: number;
  flash_assist: number;
  score: number;
  initial_team_number: number;
  spray_accuracy: number;
  total_kills: number;
  total_deaths: number;
  kd_ratio: number;
  rounds_survived: number;
  rounds_survived_percentage: number;
  dpr: number;
  total_assists: number;
  total_damage: number;
  leetify_rating: number | null;
  ct_leetify_rating: number | null;
  t_leetify_rating: number | null;
  multi1k: number;
  multi2k: number;
  multi3k: number;
  multi4k: number;
  multi5k: number;
  rounds_count: number;
  rounds_won: number;
  rounds_lost: number;
  total_hs_kills: number;
  trade_kill_opportunities?: number | null;
  trade_kill_attempts?: number | null;
  trade_kills_succeed?: number | null;
  trade_kill_attempts_percentage?: number | null;
  trade_kills_success_percentage?: number | null;
  trade_kill_opportunities_per_round?: number | null;
  traded_death_opportunities?: number | null;
  traded_death_attempts?: number | null;
  traded_deaths_succeed?: number | null;
  traded_death_attempts_percentage?: number | null;
  traded_deaths_success_percentage?: number | null;
  traded_deaths_opportunities_per_round?: number | null;
}
