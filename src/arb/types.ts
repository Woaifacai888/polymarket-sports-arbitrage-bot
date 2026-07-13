import type { Leg, Opportunity, RelationType } from '../config/types.js';

export interface RelationContext {
  eventId: string;
  eventTitle: string;
  feeBps: number;
  slippageBps: number;
  minNetEdge: number;
  maxLegSize: number;
}

export interface RelationViolation {
  relation: RelationType;
  description: string;
  legs: Leg[];
  grossEdge: number;
  netEdge: number;
}

/** Stable fingerprint so duplicate cooldown / risk tracking works across scans. */
export function opportunityFingerprint(
  eventId: string,
  relation: RelationType,
  legs: Array<{ tokenId: string; side: string; outcome: string }>,
): string {
  const legKey = legs
    .map((l) => `${l.tokenId}:${l.side}:${l.outcome}`)
    .sort()
    .join('|');
  return `${eventId}:${relation}:${legKey}`;
}

export function buildOpportunity(
  ctx: RelationContext,
  violation: RelationViolation,
): Opportunity {
  return {
    id: opportunityFingerprint(ctx.eventId, violation.relation, violation.legs),
    eventId: ctx.eventId,
    eventTitle: ctx.eventTitle,
    relation: violation.relation,
    description: violation.description,
    legs: violation.legs,
    grossEdge: violation.grossEdge,
    netEdge: violation.netEdge,
    detectedAt: Date.now(),
    status: 'detected',
  };
}
