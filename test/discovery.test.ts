import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/config.js';
import { GammaClient } from '../src/data/gammaClient.js';
import { buildEventGraphs } from '../src/model/eventGraph.js';
import {
  classifyEventSport,
  eventMatchesSport,
  parseSportFocus,
  SPORT_PROFILES,
} from '../src/model/sportsRegistry.js';

describe('sport focus registry', () => {
  it('defaults to the full sport universe (no world_cup)', () => {
    assert.deepEqual(parseSportFocus(undefined), [
      'nba',
      'wnba',
      'mlb',
      'kbo',
      'k_league',
      'liga_mx',
      'mls',
    ]);
  });

  it('accepts aliases and drops unknown ids (incl. removed world_cup)', () => {
    assert.deepEqual(parseSportFocus('nba,liga-mx,kleague,world_cup'), [
      'nba',
      'liga_mx',
      'k_league',
    ]);
  });

  it('matches Liga MX events', () => {
    const event = {
      id: '1',
      slug: 'cruz-azul-vs-club-puebla',
      title: 'CF Cruz Azul vs. Club Puebla',
      tags: [{ id: '1', label: 'Liga MX' }],
      markets: [
        {
          id: 'm1',
          question: 'Will CF Cruz Azul win?',
          slug: 'm1',
          conditionId: 'c1',
          enableOrderBook: true,
          clobTokenIds: '["yes","no"]',
        },
      ],
    };
    assert.equal(eventMatchesSport(event, SPORT_PROFILES.liga_mx), true);
    assert.equal(classifyEventSport(event, ['nba', 'liga_mx']), 'liga_mx');
  });

  it('matches WNBA events under the wnba profile', () => {
    const event = {
      id: '4',
      slug: 'wnba-lyn-sea',
      title: 'Minnesota Lynx vs. Seattle Storm',
      tags: [{ id: '1', label: 'WNBA' }],
      markets: [
        {
          id: 'm1',
          question: 'Will the Lynx win?',
          slug: 'm1',
          conditionId: 'c1',
          enableOrderBook: true,
          clobTokenIds: '["yes","no"]',
        },
      ],
    };
    assert.equal(eventMatchesSport(event, SPORT_PROFILES.wnba), true);
    assert.equal(classifyEventSport(event, ['nba', 'wnba']), 'wnba');
  });

  it('excludes WNBA from NBA focus', () => {
    const event = {
      id: '2',
      slug: 'wnba-finals',
      title: 'WNBA Finals Winner',
      tags: [{ id: '1', label: 'WNBA' }],
      markets: [
        {
          id: 'm1',
          question: 'Will Team A win WNBA?',
          slug: 'm1',
          conditionId: 'c1',
          enableOrderBook: true,
          clobTokenIds: '["yes","no"]',
        },
      ],
    };
    assert.equal(eventMatchesSport(event, SPORT_PROFILES.nba), false);
  });

  it('matches NBA futures markets', () => {
    const event = {
      id: '3',
      slug: 'nba-draft',
      title: '2026 NBA Draft: 1st Overall pick',
      tags: [{ id: '745', label: 'NBA' }],
      markets: [
        {
          id: 'm1',
          question: 'Will Player X be picked first?',
          slug: 'm1',
          conditionId: 'c1',
          enableOrderBook: true,
          clobTokenIds: '["yes","no"]',
        },
      ],
    };
    assert.equal(eventMatchesSport(event, SPORT_PROFILES.nba), true);
  });
});

describe('gamma discovery', () => {
  it('discovers only focused sports (nba + mlb)', async () => {
    const config = loadConfig({ maxDiscoveryEvents: 20, sportFocus: ['nba', 'mlb'] });
    const client = new GammaClient(config);
    const events = await client.discoverEvents();
    assert.ok(events.length > 0, 'expected focused sports events');

    for (const event of events) {
      const sport = classifyEventSport(event, config.sportFocus);
      assert.ok(sport, `event should match focus: ${event.title}`);
    }

    const graphs = buildEventGraphs(events, config.sportFocus);
    assert.ok(graphs.length > 0, 'expected tradable graphs');
  });
});
