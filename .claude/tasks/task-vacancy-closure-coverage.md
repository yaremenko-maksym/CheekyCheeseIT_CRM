# task-vacancy-closure-coverage

## Agent: coder
## Status: ready
## Blockers: none
## Priority: high
## Model: opus — availability closure on the live HR queue (prod data), routed
## Depends on: runs in parallel with task-vacancy-retention-60d (that task deletes at detection; this one makes detection fire)
## Branch: feature/vacancy-closure-coverage

## Context

Backlog 470: availability reconciliation is ON in prod, but both closure paths need run coverage
`FULL_INVENTORY` or `WINDOW`. `deriveCoverage` (`providers/reporting-provider.ts`) forces
`PARTIAL` on any quarantined or invalid item, and `FRESHNESS_MAX_AGE_MS`
(`health/provider-facts.ts`) covers only `REMOTIVE_API` and `JOBICY_API`, so every prod run is
`PARTIAL` and nothing ever closes. HTML sources are `PARTIAL` by construction (detail budget).
Owner 2026-11-25: a vacancy taken down at the source must leave the HR queue as soon as a run
detects it — "HR always has a fresh queue". Related backlog 320, 472.

## Concrete changes

1. Coverage: a quarantined/invalid item must not cost the whole run its inventory claim when the
   item was still **listed** (it was seen in the listing, just not ingested) — count it as present
   for absence purposes (backlog 320 option "exclusion counted but does not weaken the claim").
   A run that genuinely did not see the whole listing (pagination cut, errors, budget) stays
   `PARTIAL`. Record the exact rule in `## Assumptions`.
2. HTML sources: the listing/sitemap pass is the inventory; the detail budget limits enrichment,
   not presence. If the listing was read completely, the run's absence claim is valid even when
   details were budget-limited. If that is not true for a source, leave it PARTIAL and list it.
3. Freshness windows (`FRESHNESS_MAX_AGE_MS`): give every source a window (EXPIRED fallback for
   sources that cannot claim full inventory), sized from each source's cadence
   (`scheduling/` cadence profiles) — e.g. a posting not seen for N × its cadence interval. Record
   the numbers.
4. Backlog 472 — if the `coverage` column is never written, write it (it is what the verify query
   reads). Any DDL staged under `apps/api/drizzle/manual/` per convention.
5. Update backlog 470/320/472 entries (status + what was done).

## Must not break

- A failing / truncated / rate-limited run must NEVER close postings (false closure = HR loses a
  live vacancy). NO_EVASION rule in `docs/runbooks/vacancy-sourcing.md` stands.
- Availability reconcile worker, dirty-work partitions, existing provider specs and golden tests.

## Seams under test

- `deriveCoverage` unit spec: quarantined-but-listed keeps FULL_INVENTORY; truncated run stays PARTIAL.
- One integration spec per closure path on a scratch DB: a posting absent from a full listing gets
  CLOSED; a posting unseen beyond its window gets EXPIRED; a failed run closes nothing.

## Acceptance criteria

1. A successful complete run of an API source that dropped a posting closes it.
2. An HTML source whose listing was read completely closes dropped postings.
3. Every source has a freshness window; unseen-too-long → EXPIRED.
4. Failed/partial runs close nothing (spec).
5. Coverage persisted per run; backlog entries updated.
6. Specs green on a scratch DB, never the live `crm_db`.

## Assumptions

(filled in by the coder as decisions are made)
