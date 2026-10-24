/**
 * Owner decisions about sources whose terms do not settle the question (r5 Task 3.2c).
 *
 * A decision is DATA BESIDE the provenance, never a rewrite of it. A provenance file says what the
 * provider's terms say (`UNCLEAR` stays `UNCLEAR`); a decision says that the owner, knowing that,
 * accepted the risk of collecting anyway. It is therefore an ACCEPTED RISK on a stated scope, not a
 * documented permission, and it is worded as one wherever it is shown.
 *
 * Its own small module so that an adapter can read the decision it is gated on (SmartRecruiters)
 * without depending on the manifest builder, and so the builder's mutants do not re-run adapter specs.
 *
 * READINESS RULE (enforced in `buildManifest`, stated here once):
 *  - `UNCLEAR` is lifted ONLY by an `ACCEPT_RISK` decision whose `endpointVariant` equals the type's own;
 *  - `PROHIBITED` is never lifted, by any decision;
 *  - `KEY_REQUIRED` is not a question of permission and is never lifted;
 *  - an `INFORMATIONAL` decision records how the owner reads a clause and changes nothing.
 */

export const OWNER_DECISION_KINDS = ['ACCEPT_RISK', 'INFORMATIONAL'] as const
export type OwnerDecisionKind = (typeof OWNER_DECISION_KINDS)[number]

export interface OwnerDecision {
  /** ISO calendar date the owner decided (`YYYY-MM-DD`). */
  readonly decidedAt: string
  readonly decision: OwnerDecisionKind
  /**
   * The manifest `endpointVariant` of the source type this decision is about. A decision lifts a
   * block only for the endpoint it was taken about: a type that later adds another endpoint variant
   * is NOT covered by it.
   */
  readonly endpointVariant: string
  /** What exactly was accepted, in one sentence. */
  readonly scope: string
  /** The question put to the owner, by its text (not by a chat link, which rots). */
  readonly reference: string
}

/** True when the record is well-formed: a real calendar date and non-blank scope and reference. */
export function isWellFormedDecision(d: OwnerDecision): boolean {
  // Only `YYYY-MM-DD` survives the round trip: anything else is an invalid date or changes on re-print.
  const parsed = new Date(`${d.decidedAt}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d.decidedAt) {
    return false
  }
  return d.scope.trim() !== '' && d.reference.trim() !== '' && d.endpointVariant.trim() !== ''
}

/**
 * Does any decision lift an `UNCLEAR` permission for the endpoint variant? Only `ACCEPT_RISK`, only
 * the variant the decision names. Nothing here can lift `PROHIBITED`: the caller applies this to
 * `UNCLEAR` alone.
 */
export function liftsUnclear(
  decisions: readonly OwnerDecision[],
  endpointVariant: string,
): boolean {
  return decisions.some(
    (d) => d.decision === 'ACCEPT_RISK' && d.endpointVariant === endpointVariant,
  )
}

const REFERENCE_NOTE = 'Owner decision, 2026-10-24 (answer given in the vacancy-sourcing session).'

export const HN_OWNER_DECISION: OwnerDecision = {
  decidedAt: '2026-10-24',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'algolia-who-is-hiring',
  scope:
    'The Algolia HN Search API only: two requests per run to hn.algolia.com; no use of news.ycombinator.com pages.',
  reference: `${REFERENCE_NOTE} Question: do Y Combinator's terms ("no data mining, robots, scraping or similar data gathering or extraction methods" in connection with "the Site") cover the public, unauthenticated, documented HN Search API on Algolia? Options: (a) treat the API as allowed and lift the block, (b) ask Y Combinator, (c) do not use it. Answer: (a). Accepted risk, not a documented permission.`,
}

export const REMOTIVE_OWNER_DECISION: OwnerDecision = {
  decidedAt: '2026-10-24',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'category',
  scope:
    'Exactly /api/remote-jobs?category= on remotive.com; the vendor limits stay binding on us: attribution to Remotive, jobs delayed 24 hours, at most about 4 requests a day and never more than 2 a minute.',
  reference: `${REFERENCE_NOTE} Question: robots.txt says "Disallow: /api/*" while the documented API grants developer access; which takes priority? Answer: the documented API takes priority, lift the block. Accepted risk, not a documented permission.`,
}

export const JOBGETHER_OWNER_DECISION: OwnerDecision = {
  decidedAt: '2026-10-24',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'astroapi-ai-jobs',
  scope:
    'Exactly /astroapi/ai/jobs.json on jobgether.com. The Terms of Use (4.5, 9) forbid automated extraction and the use of content to train or operate machine-learning models; relevance in this feature runs through a model. That clause is knowingly accepted as risk, NOT resolved.',
  reference: `${REFERENCE_NOTE} Question: the API is documented as public and "intended for AI agents" while the Terms of Use forbid automated extraction and ML use of content; lift the block? Concern raised and reaffirmed by the owner. Answer: lift the block. Accepted risk, not a documented permission.`,
}

export const SMARTRECRUITERS_OWNER_DECISION: OwnerDecision = {
  decidedAt: '2026-10-24',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'posting-api',
  scope:
    'The public SmartRecruiters postings API (api.smartrecruiters.com/v1/companies/{company}/postings) only, despite robots.txt (Disallow for every agent except LinkedInBot), until banned. A 403, a 429 or any explicit block ends the run with no further request; no user-agent change, proxy or other evasion, ever.',
  reference: `${REFERENCE_NOTE} Question: robots.txt disallows every agent except LinkedInBot while the documentation calls the Posting API public; use it anyway? Answer: yes, until banned. Accepted risk, not a documented permission.`,
}

export const WORKABLE_OWNER_DECISION: OwnerDecision = {
  decidedAt: '2026-10-24',
  decision: 'INFORMATIONAL',
  endpointVariant: 'widget-accounts',
  scope:
    'Workable sends "Content-Signal: ai-train=no"; the owner reads it as not covering relevance scoring. Informational: Workable is PUBLIC_API_DOCUMENTED and its readiness does not depend on this.',
  reference: `${REFERENCE_NOTE} Question: does the Content-Signal "ai-train=no" header cover scoring relevance with a model? Answer: no, it is read as not covering relevance scoring.`,
}
