import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyEventPhase,
  filterTrackableGraphs,
  getSportTypicalDurationMs,
} from '../src/model/eventPhase.js';
import type { EventGraph } from '../src/config/types.js';

const HOUR = 60 * 60 * 1000;

function graph(overrides: Partial<EventGraph> = {}): EventGraph {
  return {
    eventId: 'e1',
    slug: 'brazil-vs-morocco',
    title: 'Brazil vs. Morocco',
    sportId: 'world_cup',
    gameStartTime: null,
    markets: [],
    tokenIds: [],
    ...overrides,
  };
}

describe('classifyEventPhase', () => {
  it('returns unknown when gameStartTime is missing', () => {
    assert.equal(classifyEventPhase(null, 'nba'), 'unknown');
  });

  it('returns upcoming when start time is in the future', () => {
    const start = new Date(Date.now() + HOUR);
    assert.equal(classifyEventPhase(start, 'nba'), 'upcoming');
  });

  it('returns live while within the typical game duration window', () => {
    const start = new Date(Date.now() - HOUR); // started 1h ago
    assert.equal(classifyEventPhase(start, 'nba'), 'live'); // NBA window is 3.5h
  });

  it('returns finished once past the typical duration', () => {
    const start = new Date(Date.now() - 5 * HOUR); // NBA duration 3.5h
    assert.equal(classifyEventPhase(start, 'nba'), 'finished');
  });

  it('uses world_cup duration (3h) for finished detection', () => {
    const stillLive = new Date(Date.now() - 2.5 * HOUR);
    const finished = new Date(Date.now() - 4 * HOUR);
    assert.equal(classifyEventPhase(stillLive, 'world_cup'), 'live');
    assert.equal(classifyEventPhase(finished, 'world_cup'), 'finished');
  });

  it('falls back to a conservative duration for unclassified sports', () => {
    assert.ok(getSportTypicalDurationMs(null) >= 3 * HOUR);
  });
});

describe('filterTrackableGraphs', () => {
  const baseOptions = {
    trackUpcomingOnly: true,
    maxLookaheadMs: 14 * 24 * HOUR,
    allowUnknownPhase: true,
  };

  it('keeps upcoming games and drops live/finished ones (this is the reported bug)', () => {
    const upcoming = graph({ eventId: 'e-upcoming', gameStartTime: new Date(Date.now() + 2 * HOUR) });
    const live = graph({ eventId: 'e-live', gameStartTime: new Date(Date.now() - HOUR) });
    const finished = graph({ eventId: 'e-finished', gameStartTime: new Date(Date.now() - 6 * HOUR) });

    const { kept, skipped } = filterTrackableGraphs([upcoming, live, finished], baseOptions);

    assert.deepEqual(kept.map((g) => g.eventId), ['e-upcoming']);
    assert.equal(skipped.length, 2);
    assert.ok(skipped.some((s) => s.graph.eventId === 'e-live' && s.phase === 'live'));
    assert.ok(skipped.some((s) => s.graph.eventId === 'e-finished' && s.phase === 'finished'));
  });

  it('drops games scheduled beyond the lookahead window', () => {
    const tooFar = graph({ gameStartTime: new Date(Date.now() + 30 * 24 * HOUR) });
    const { kept, skipped } = filterTrackableGraphs([tooFar], baseOptions);
    assert.equal(kept.length, 0);
    assert.equal(skipped[0].reason, 'Too far in the future (outside lookahead window)');
  });

  it('keeps events with unknown phase when allowUnknownPhase is true', () => {
    const unknown = graph({ gameStartTime: null });
    const { kept } = filterTrackableGraphs([unknown], baseOptions);
    assert.equal(kept.length, 1);
  });

  it('drops events with unknown phase when allowUnknownPhase is false', () => {
    const unknown = graph({ gameStartTime: null });
    const { kept, skipped } = filterTrackableGraphs([unknown], {
      ...baseOptions,
      allowUnknownPhase: false,
    });
    assert.equal(kept.length, 0);
    assert.equal(skipped[0].reason, 'Unknown game start time');
  });

  it('allows live games through when trackUpcomingOnly is false', () => {
    const live = graph({ gameStartTime: new Date(Date.now() - HOUR) });
    const { kept } = filterTrackableGraphs([live], { ...baseOptions, trackUpcomingOnly: false });
    assert.equal(kept.length, 1);
  });
});
