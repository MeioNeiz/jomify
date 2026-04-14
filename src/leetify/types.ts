export interface LeetifyProfile {
  meta: {
    name: string;
    steamId: string;
    avatarUrl?: string;
  };
  ratings?: {
    leetifyRating?: number;
    aim?: number;
    positioning?: number;
    utility?: number;
    clutch?: number;
  };
  ranks?: {
    premier?: number;
    faceit?: number;
  };
  recentMatches?: LeetifyMatch[];
}

export interface LeetifyMatch {
  gameId: string;
  mapName: string;
  matchDate: string;
  score: { team1: number; team2: number };
  playerStats: {
    kills: number;
    deaths: number;
    assists: number;
    adr: number;
    hsPercent: number;
    leetifyRating: number;
    kast: number;
  };
  won: boolean;
}

export interface LeetifyMatchDetails {
  gameId: string;
  mapName: string;
  teams: {
    team1: LeetifyPlayerStats[];
    team2: LeetifyPlayerStats[];
  };
  score: { team1: number; team2: number };
}

export interface LeetifyPlayerStats {
  steamId: string;
  name: string;
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  hsPercent: number;
  leetifyRating: number;
}
