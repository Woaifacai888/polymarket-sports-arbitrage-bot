import type { EventGraph, SportId } from '../config/types.js';
import { SPORT_PROFILES } from './sportsRegistry.js';

export type EventPhase = 'upcoming' | 'live' | 'finished' | 'unknown';

/** Conservative fallback when sport is unclassified but a start time exists. */
const DEFAULT_DURATION_MS = 3.5 * 60 * 60 * 1000;

export function getSportTypicalDurationMs(sportId: SportId | null): number {
  if (!sportId) return DEFAULT_DURATION_MS;
  return SPORT_PROFILES[sportId]?.typicalDurationMs ?? DEFAULT_DURATION_MS;
}

/**
 * Classify a game's lifecycle from its scheduled start time.
 *
 * Polymarket's Gamma API only exposes `active`/`closed`, which reflects
 * *settlement* state, not whether the game has actually been played.
 * A finished match can stay `active=true, closed=false` for a long time
 * while resolution is pending, so we derive real game phase from
 * `gameStartTime` + a sport-specific typical duration instead.
 */
export function classifyEventPhase(
  gameStartTime: Date | null,
  sportId: SportId | null,
  now = Date.now(),
): EventPhase {
  if (!gameStartTime) return 'unknown';
  const start = gameStartTime.getTime();
  if (now < start) return 'upcoming';

  const durationMs = getSportTypicalDurationMs(sportId);
  if (now <= start + durationMs) return 'live';
  return 'finished';
}

export function getEventPhase(
  graph: Pick<EventGraph, 'gameStartTime' | 'sportId'>,
  now = Date.now(),
): EventPhase {
  return classifyEventPhase(graph.gameStartTime, graph.sportId, now);
}

export interface TrackabilityOptions {
  /**
   * When true, ONLY 'upcoming' (pre-game) matches are tradable — live games
   * are also excluded. When false (default), both 'upcoming' and 'live'
   * matches are tradable; only 'finished' games are always excluded.
   */
  trackUpcomingOnly: boolean;
  /** Games starting further than this ahead are deferred to a later refresh. */
  maxLookaheadMs: number;
  /** Whether to keep events with no resolvable gameStartTime. */
  allowUnknownPhase: boolean;
  now?: number;
}

export interface TrackabilityResult {
  kept: EventGraph[];
  skipped: Array<{ graph: EventGraph; phase: EventPhase; reason: string }>;
}

/**
 * Decides whether a given phase should be tradable under the current options.
 * 'finished' is always excluded — a game that's over should never be scanned
 * for fresh arb, regardless of Gamma's active/closed settlement flags.
 */
export function isPhaseTrackable(phase: EventPhase, trackUpcomingOnly: boolean): boolean {
  if (phase === 'finished') return false;
  if (phase === 'live') return !trackUpcomingOnly;
  return true; // 'upcoming' and 'unknown' handled by caller
}

/**
 * Filters event graphs down to ones that should actually be scanned for
 * arbitrage. By default this keeps scheduled AND in-progress matches, and
 * only excludes games that have already finished (Gamma's active/closed
 * flags can stay "active" long after a match ends, pending settlement).
 * Set `trackUpcomingOnly: true` for a stricter pre-game-only mode.
 */
export function filterTrackableGraphs(
  graphs: EventGraph[],
  options: TrackabilityOptions,
): TrackabilityResult {
  const now = options.now ?? Date.now();
  const kept: EventGraph[] = [];
  const skipped: TrackabilityResult['skipped'] = [];

  for (const graph of graphs) {
    const phase = classifyEventPhase(graph.gameStartTime, graph.sportId, now);

    if (phase === 'unknown') {
      if (options.allowUnknownPhase) {
        kept.push(graph);
      } else {
        skipped.push({ graph, phase, reason: 'Unknown game start time' });
      }
      continue;
    }

    if (phase === 'finished') {
      skipped.push({ graph, phase, reason: 'Game finished' });
      continue;
    }

    if (phase === 'live' && options.trackUpcomingOnly) {
      skipped.push({ graph, phase, reason: 'Game live (upcoming-only mode)' });
      continue;
    }

    if (phase === 'upcoming' && graph.gameStartTime) {
      const msUntilStart = graph.gameStartTime.getTime() - now;
      if (msUntilStart > options.maxLookaheadMs) {
        skipped.push({ graph, phase, reason: 'Too far in the future (outside lookahead window)' });
        continue;
      }
    }

    kept.push(graph);
  }

  return { kept, skipped };
}
