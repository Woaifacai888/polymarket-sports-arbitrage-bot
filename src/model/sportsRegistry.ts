import type { GammaEvent } from '../data/gammaTypes.js';

export const SPORT_IDS = [
  'nba',
  'wnba',
  'mlb',
  'kbo',
  'k_league',
  'liga_mx',
  'mls',
] as const;

export type SportId = (typeof SPORT_IDS)[number];

export interface SportProfile {
  id: SportId;
  label: string;
  /** Polymarket /sports metadata sport codes */
  sportCodes: string[];
  /** Gamma tag IDs to scan for events */
  tagIds: number[];
  /** Gamma series IDs for scheduled match/event groups */
  seriesIds: string[];
  /** Match if title or slug contains any of these (lowercase) */
  titleKeywords: string[];
  /** Match if event tag label/slug contains any of these */
  tagLabels: string[];
  /** Exclude if title/tags contain any of these */
  excludeKeywords: string[];
  /**
   * Conservative upper bound on how long a game can run from scheduled start
   * to final whistle/buzzer (includes OT/ET/penalties + broadcast buffer).
   * Used to distinguish "upcoming" from "live"/"finished" for discovery.
   */
  typicalDurationMs: number;
}

const HOUR_MS = 60 * 60 * 1000;

// Esports tournaments frequently reuse real-sport branding ("NBA 2K",
// "eMLS", "FIFA" the video game...). These keywords must be excluded
// *before* the title-keyword check runs (exclude wins over include).
const ESPORTS_EXCLUDES = [
  'esports',
  'league of legends',
  'lol:',
  'dota',
  'valorant',
  'counter-strike',
  'csgo',
  'cs2',
  'overwatch',
  'call of duty',
  'starcraft',
  'rocket league',
  'rainbow six',
  'apex legends',
  'mobile legends',
  'free fire',
  'pubg',
  'fortnite',
];

export const SPORT_PROFILES: Record<SportId, SportProfile> = {
  nba: {
    id: 'nba',
    label: 'NBA',
    // NOTE: tag 100639 ("Games") is Polymarket's generic video-game/esports
    // category, not an NBA tag - do not add it here. It was previously
    // included and pulled unrelated esports events into discovery.
    sportCodes: ['nba'],
    tagIds: [745],
    seriesIds: ['10345'],
    titleKeywords: ['nba'],
    tagLabels: ['nba'],
    excludeKeywords: [
      'wnba',
      'ncaab',
      'ncaa',
      'fiba',
      'bkarg',
      'bkfiba',
      'nba 2k',
      '2k',
      'summer league',
      ...ESPORTS_EXCLUDES,
    ],
    // Regulation + broadcast breaks ~2.5h; allow for OT and delays.
    typicalDurationMs: 3.5 * HOUR_MS,
  },
  wnba: {
    id: 'wnba',
    label: 'WNBA',
    sportCodes: ['wnba'],
    tagIds: [100254],
    seriesIds: [],
    titleKeywords: ['wnba'],
    tagLabels: ['wnba'],
    excludeKeywords: ['ncaa', 'fiba', '2k', ...ESPORTS_EXCLUDES],
    typicalDurationMs: 3 * HOUR_MS,
  },
  mlb: {
    id: 'mlb',
    label: 'MLB',
    sportCodes: ['mlb'],
    tagIds: [100381],
    seriesIds: [],
    titleKeywords: ['mlb'],
    tagLabels: ['mlb'],
    // Other baseball leagues have their own profiles/codes; keep them out so
    // one event maps to exactly one sport.
    excludeKeywords: ['kbo', 'npb', 'cpbl', 'lidom', 'lvbp', 'wbc', 'ncaa', ...ESPORTS_EXCLUDES],
    // Baseball has no clock: 9 innings ~3h, extras can run very long.
    typicalDurationMs: 5 * HOUR_MS,
  },
  kbo: {
    id: 'kbo',
    label: 'KBO',
    sportCodes: ['kbo'],
    tagIds: [102668],
    seriesIds: [],
    titleKeywords: ['kbo'],
    tagLabels: ['kbo'],
    excludeKeywords: [...ESPORTS_EXCLUDES],
    typicalDurationMs: 5 * HOUR_MS,
  },
  k_league: {
    id: 'k_league',
    label: 'K League',
    sportCodes: ['kor'],
    tagIds: [102771],
    seriesIds: [],
    titleKeywords: ['k league', 'k-league'],
    tagLabels: ['k league', 'k-league'],
    excludeKeywords: [...ESPORTS_EXCLUDES],
    // 90 min + HT + stoppage ~2h; buffer for delays.
    typicalDurationMs: 3 * HOUR_MS,
  },
  liga_mx: {
    id: 'liga_mx',
    label: 'Liga MX',
    sportCodes: ['mex'],
    tagIds: [102448],
    seriesIds: [],
    titleKeywords: ['liga mx'],
    tagLabels: ['liga mx', 'liga-mx'],
    excludeKeywords: ['femenil', ...ESPORTS_EXCLUDES],
    typicalDurationMs: 3 * HOUR_MS,
  },
  mls: {
    id: 'mls',
    label: 'MLS',
    sportCodes: ['mls'],
    tagIds: [100100],
    seriesIds: [],
    titleKeywords: ['mls'],
    tagLabels: ['mls', 'major league soccer'],
    excludeKeywords: ['emls', 'next pro', ...ESPORTS_EXCLUDES],
    typicalDurationMs: 3 * HOUR_MS,
  },
};

export const DEFAULT_SPORT_FOCUS: SportId[] = [...SPORT_IDS];

/** Accept common spellings for sport ids ("liga-mx", "kleague", ...). */
const SPORT_ALIASES: Record<string, SportId> = {
  kleague: 'k_league',
  ligamx: 'liga_mx',
};

export function parseSportFocus(raw: string | undefined): SportId[] {
  if (!raw?.trim()) return [...DEFAULT_SPORT_FOCUS];

  const ids = raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/-/g, '_'))
    .filter(Boolean);

  const resolved: SportId[] = [];
  for (const id of ids) {
    const normalized =
      (SPORT_IDS as readonly string[]).includes(id)
        ? (id as SportId)
        : SPORT_ALIASES[id.replace(/_/g, '')];
    if (normalized && !resolved.includes(normalized)) resolved.push(normalized);
  }

  return resolved.length > 0 ? resolved : [...DEFAULT_SPORT_FOCUS];
}

export function getSportProfiles(focus: SportId[]): SportProfile[] {
  return focus.map((id) => SPORT_PROFILES[id]);
}

export function eventMatchesSport(event: GammaEvent, profile: SportProfile): boolean {
  const title = (event.title ?? '').toLowerCase();
  const slug = (event.slug ?? '').toLowerCase();
  const tagText = (event.tags ?? [])
    .map((t) => `${t.label ?? ''} ${(t as { slug?: string }).slug ?? ''}`)
    .join(' ')
    .toLowerCase();
  const blob = `${title} ${slug} ${tagText}`;

  if (profile.excludeKeywords.some((kw) => blob.includes(kw))) {
    return false;
  }

  if (profile.titleKeywords.some((kw) => title.includes(kw) || slug.includes(kw))) {
    return true;
  }

  if (profile.tagLabels.some((kw) => tagText.includes(kw))) {
    return true;
  }

  return false;
}

export function classifyEventSport(
  event: GammaEvent,
  focus: SportId[],
): SportId | null {
  for (const sportId of focus) {
    if (eventMatchesSport(event, SPORT_PROFILES[sportId])) {
      return sportId;
    }
  }
  return null;
}

export async function resolveSportTagsFromMetadata(
  fetchSports: () => Promise<Array<{ sport: string; tags: string }>>,
  focus: SportId[],
): Promise<Map<SportId, number[]>> {
  const sports = await fetchSports();
  const result = new Map<SportId, number[]>();

  for (const sportId of focus) {
    const profile = SPORT_PROFILES[sportId];
    const tagSet = new Set<number>(profile.tagIds);

    for (const meta of sports) {
      if (!profile.sportCodes.includes(meta.sport)) continue;
      for (const part of meta.tags.split(',')) {
        const id = Number(part.trim());
        if (Number.isFinite(id)) tagSet.add(id);
      }
    }

    result.set(sportId, [...tagSet]);
  }

  return result;
}
