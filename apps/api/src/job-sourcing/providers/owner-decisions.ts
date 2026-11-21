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
 *  - `PROHIBITED` is lifted ONLY by an `ACCEPT_PROHIBITED_RISK` decision whose `endpointVariant` equals
 *    the type's own: the owner, knowing the terms forbid collection, accepted that legal risk. A plain
 *    `ACCEPT_RISK` never lifts it, and `ACCEPT_PROHIBITED_RISK` lifts nothing else;
 *  - `KEY_REQUIRED` is not a question of permission and is never lifted;
 *  - an `INFORMATIONAL` decision records how the owner reads a clause and changes nothing.
 */

export const OWNER_DECISION_KINDS = [
  'ACCEPT_RISK',
  'ACCEPT_PROHIBITED_RISK',
  'INFORMATIONAL',
] as const
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
 * `UNCLEAR` alone (`liftsProhibited` is the separate, stronger decision).
 */
export function liftsUnclear(
  decisions: readonly OwnerDecision[],
  endpointVariant: string,
): boolean {
  return decisions.some(
    (d) => d.decision === 'ACCEPT_RISK' && d.endpointVariant === endpointVariant,
  )
}

/**
 * Does any decision lift a `PROHIBITED` permission for the endpoint variant? Only
 * `ACCEPT_PROHIBITED_RISK`, only the variant the decision names.
 */
export function liftsProhibited(
  decisions: readonly OwnerDecision[],
  endpointVariant: string,
): boolean {
  return decisions.some(
    (d) => d.decision === 'ACCEPT_PROHIBITED_RISK' && d.endpointVariant === endpointVariant,
  )
}

// Every decision below is `Object.freeze`d (Task 2.5 T2, #1139 delta LOW 1): an adapter is armed by
// the SHARED object, so a runtime write to it would leave an adapter armed while the manifest stops
// lifting. Every field is a string, so the shallow freeze is the whole of it.
const REFERENCE_NOTE = 'Owner decision, 2026-10-24 (answer given in the vacancy-sourcing session).'

export const HN_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-10-24',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'algolia-who-is-hiring',
  scope:
    'The Algolia HN Search API only: two requests per run to hn.algolia.com; no use of news.ycombinator.com pages.',
  reference: `${REFERENCE_NOTE} Question: do Y Combinator's terms ("no data mining, robots, scraping or similar data gathering or extraction methods" in connection with "the Site") cover the public, unauthenticated, documented HN Search API on Algolia? Options: (a) treat the API as allowed and lift the block, (b) ask Y Combinator, (c) do not use it. Answer: (a). Accepted risk, not a documented permission.`,
})

export const REMOTIVE_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-10-24',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'category',
  scope:
    'Exactly /api/remote-jobs?category= on remotive.com; the vendor limits stay binding on us: attribution to Remotive, jobs delayed 24 hours, at most about 4 requests a day and never more than 2 a minute.',
  reference: `${REFERENCE_NOTE} Question: robots.txt says "Disallow: /api/*" while the documented API grants developer access; which takes priority? Answer: the documented API takes priority, lift the block. Accepted risk, not a documented permission.`,
})

export const JOBGETHER_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-10-24',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'astroapi-ai-jobs',
  scope:
    'Exactly /astroapi/ai/jobs.json on jobgether.com. The Terms of Use (4.5, 9) forbid automated extraction and the use of content to train or operate machine-learning models; relevance in this feature runs through a model. That clause is knowingly accepted as risk, NOT resolved.',
  reference: `${REFERENCE_NOTE} Question: the API is documented as public and "intended for AI agents" while the Terms of Use forbid automated extraction and ML use of content; lift the block? Concern raised and reaffirmed by the owner. Answer: lift the block. Accepted risk, not a documented permission.`,
})

export const SMARTRECRUITERS_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-10-24',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'posting-api',
  scope:
    'The public SmartRecruiters postings API (api.smartrecruiters.com/v1/companies/{company}/postings) only, despite robots.txt (Disallow for every agent except LinkedInBot), until banned. A 403, a 429 or any explicit block ends the run with no further request; no user-agent change, proxy or other evasion, ever.',
  reference: `${REFERENCE_NOTE} Question: robots.txt disallows every agent except LinkedInBot while the documentation calls the Posting API public; use it anyway? Answer: yes, until banned. Accepted risk, not a documented permission.`,
})

export const WORKABLE_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-10-24',
  decision: 'INFORMATIONAL',
  endpointVariant: 'widget-accounts',
  scope:
    'Workable sends "Content-Signal: ai-train=no"; the owner reads it as not covering relevance scoring. Informational: Workable is PUBLIC_API_DOCUMENTED and its readiness does not depend on this.',
  reference: `${REFERENCE_NOTE} Question: does the Content-Signal "ai-train=no" header cover scoring relevance with a model? Answer: no, it is read as not covering relevance scoring.`,
})

// Owner decision, 2026-11-16: consent to every source whose only permission question is UNCLEAR.
// Each record is still scoped to the type's own endpoint variant, and lifts `UNCLEAR` alone.
const ALL_SOURCES_REFERENCE = `Owner decision, 2026-11-16 (answer given in the vacancy-sourcing session), (owner's words, translated): "I need to pull vacancies from every possible source, and I give my consent to use all sources." Accepted risk, not a documented permission.`
const NO_EVASION =
  'A 403, a 429, a Cloudflare/bot challenge or any explicit block ends the run with no further request; no user-agent change, proxy, headless browser or other evasion, ever.'

export const ASHBY_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-16',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'posting-api',
  scope: `Exactly the public Ashby posting API (api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true), whose robots.txt answers 401 and states no verdict; the vendor publishes no limit, so the manifest budget (2 a minute, 120 an hour per host) stays binding. Residual risk knowingly accepted, NOT resolved: Ashby documents the API as the board owner's own tool ("If you host your own careers page, you can use this data to populate it") and offers third parties a separate dedicated partner feed. ${NO_EVASION}`,
  reference: ALL_SOURCES_REFERENCE,
})

export const DJINNI_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-16',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'rss-primary-keyword',
  scope: `Exactly djinni.co/jobs/rss/?primary_keyword= (the RSS feed the public /jobs/ page links, not disallowed by robots.txt), the Terms of Use (djinni.co/terms-of-use, the employer terms at djinni.co/pricing.html) say nothing on automated access, RSS or copying vacancies and carry no date, so the version in force cannot be pinned; that gap is knowingly accepted as risk, NOT resolved. The manifest fetch profile stays binding and no other djinni.co path is requested. ${NO_EVASION}`,
  reference: ALL_SOURCES_REFERENCE,
})

export const WORKINGNOMADS_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-16',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'exposed-jobs',
  scope: `Exactly www.workingnomads.com/api/exposed_jobs/; the Terms of Service clauses 2.2 ("intended purpose"), 3.1(b) ("Resell, sublicense, or otherwise commercially exploit the Service") and 3.1(d) (no competitive product) are knowingly accepted as risk, NOT resolved. ${NO_EVASION}`,
  reference: ALL_SOURCES_REFERENCE,
})

export const MUSE_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-16',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'public-jobs',
  scope: `Exactly www.themuse.com/api/public/jobs; the vendor limits stay binding (500 requests an hour without a key, link back to www.themuse.com), and terms 2.2 (a registered app) and 3.1 (display-only licence, storage not addressed) are knowingly accepted as risk, NOT resolved. ${NO_EVASION}`,
  reference: ALL_SOURCES_REFERENCE,
})

export const NEXTLEVELJOBS_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-20',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'jobs-sitemap',
  scope: `Exactly nextleveljobs.eu/jobs/sitemap.xml and the job pages it lists (/companies/<company>/jobs/<id>), read for their JSON-LD JobPosting; robots.txt allows every agent, and the combined terms and privacy page (nextleveljobs.eu/privacy-policy) says nothing on automated access, scraping or reuse of listings, so the permission is UNCLEAR and knowingly accepted as risk, NOT resolved. The manifest budget and the adapter's per-run detail cap stay binding. ${NO_EVASION}`,
  reference: `Owner decision, 2026-11-20 (A3, recorded in task sources-12): connect Next Level Jobs and accept the risk of the UNCLEAR permission, the same acceptance as for the sources of 2026-11-16. Accepted risk, not a documented permission.`,
})

// The three sources of task sources-13: their terms FORBID automated collection (PROHIBITED, not
// UNCLEAR), and the owner accepted that legal risk explicitly. Hence the stronger kind.
const ALL_PROHIBITED_REFERENCE =
  'Owner decision, 2026-11-20 (A3, recorded in task sources-13): "connect, I accept the risk for every site" (owner\'s words, translated) — connect every site whose only obstacle is its terms; the owner accepts the legal risk. Technical blocks stay excluded.'

export const THEHUB_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-20',
  decision: 'ACCEPT_PROHIBITED_RISK',
  endpointVariant: 'jobs-sitemap',
  scope: `Exactly thehub.io/sitemap-jobs.xml and the job pages it lists; the terms (https://thehub.io/terms, Last Updated 08.08.2024: "you may view and print the contents … for personal, non-commercial use only. You may not otherwise copy, save or otherwise reproduce … without our prior written consent.") are knowingly accepted as risk, NOT resolved. ${NO_EVASION}`,
  reference: ALL_PROHIBITED_REFERENCE,
})

export const JUSTJOIN_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-20',
  decision: 'ACCEPT_PROHIBITED_RISK',
  endpointVariant: 'jobs-sitemap',
  scope: `Exactly justjoin.it/sitemaps/active-jobs.xml (and its parts, served from public.justjoin.com) and the job pages it lists; the Users' ToS (2026-11-04) §11.3 ("no one may automatically extract any data from the Website without our express written consent", Polish Database Protection Act, civil and criminal liability cited) is knowingly accepted as risk, NOT resolved. ${NO_EVASION}`,
  reference: ALL_PROHIBITED_REFERENCE,
})

export const LANDINGJOBS_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-20',
  decision: 'ACCEPT_PROHIBITED_RISK',
  endpointVariant: 'jobs-sitemap',
  scope: `Exactly landing.jobs/sitemap.xml and the /at/ job pages it lists; the terms (https://landing.jobs/tos, 13 Nov 2026) §8.2(vii) ("Use … scripts, robots … to access, monitor, scrape or copy the Platform") and §5.7 (no download/store) are knowingly accepted as risk, NOT resolved. ${NO_EVASION}`,
  reference: ALL_PROHIBITED_REFERENCE,
})

export const DICE_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-20',
  decision: 'ACCEPT_PROHIBITED_RISK',
  endpointVariant: 'jobs-listing',
  scope: `Exactly www.dice.com/jobs, /jobs?page=2 and /jobs?page=3 (no search query) and the /job-detail/<guid> pages they list, read for the flight-payload job list and the JSON-LD JobPosting; robots.txt is obeyed in code (/job, /jobs?q*, /feed/, /rss/ and /apply-redirect* are never fetched). The Dice Terms and Conditions (section 8.2 j and aa) PROHIBIT robots that store or reproduce site content: the owner was told so and accepted that legal risk, so the permission stays PROHIBITED and is knowingly accepted as risk, NOT resolved. The manifest budget and the adapter's per-run detail cap stay binding. ${NO_EVASION}`,
  reference: `Owner decision, 2026-11-20 (A3, recorded in task sources-14): "I accept the risk for every site" (owner's words, translated): connect every source except EU Remote Jobs, Dice included although its terms prohibit automated collection; the owner accepts the legal risk. Technical blocks stay excluded.`,
})

export const NOFLUFF_OWNER_DECISION: OwnerDecision = Object.freeze({
  decidedAt: '2026-11-20',
  decision: 'ACCEPT_RISK',
  endpointVariant: 'category-listing',
  scope: `Exactly the nofluffjobs.com IT category pages /pl/<category>?page=2 (backend, frontend, fullstack, mobile, devops, data, artificial-intelligence, testing) and the /pl/job/<slug> pages they list, read for the serverApp-state posting list and the JSON-LD JobPosting; robots.txt is obeyed in code (/api/, /posting/, /pl/posting/ and */job/job/* are never fetched), and the terms (nofluffjobs.com/pl/regulamin) could not be read: the page renders its text only with JavaScript. Whether they allow automated reading of public listings is therefore unknown, so the permission is UNCLEAR for that reason and knowingly accepted as risk, NOT resolved. The manifest budget and the adapter's per-run detail cap stay binding. ${NO_EVASION}`,
  reference: `Owner decision, 2026-11-20 (A3, recorded in task sources-14): connect No Fluff Jobs and accept the risk of the UNCLEAR permission, the same acceptance as for the sources of 2026-11-16. Accepted risk, not a documented permission.`,
})
