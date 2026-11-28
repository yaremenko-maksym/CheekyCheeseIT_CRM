# task-vacancy-queue-sort

## Agent: coder
## Status: ready
## Blockers: none
## Priority: medium
## Model: opus — queue generation/cursor + RBAC-scoped reads, routed T3
## Depends on: nothing (disjoint from task-vacancy-retention-60d except queue reads; rebase if it lands first)
## Branch: feature/vacancy-queue-sort
## Design tier: 3

The control reuses the house shadcn `Select` (no new component, no design doc change); the ui-ux-designer
Mode B review returned PASS on all 4 device classes × uk/en
(https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/1508#issuecomment-7168234401).

## Context

Owner 2026-11-25: the vacancy queue (`/job-queue`) needs a sort control with two modes —
**relevance** (today's only order, default) and **publication date** (newest first). Today the
order is frozen per generation (`queue/queue-generation.ts`: `ORDER BY score DESC,
first_seen_at DESC, id DESC` into `order_key`) and pages walk it via the signed cursor
(`queue/queue-cursor.ts`), so a client-only sort is wrong (it would sort one page).

## Concrete changes

1. `packages/shared/src/schemas/job-sourcing.ts` — a `sort: 'relevance' | 'published'` query
   param, default `relevance`.
2. `apps/api/src/job-sourcing/queue/*` — the published order:
   `published_at DESC NULLS LAST` falling back to `first_seen_at`, then `id DESC` as tie-break.
   Choose the smallest correct mechanism (a sort-specific order key in the generation, or a
   generation per sort) and record it in `## Assumptions`. The sort must be part of the cursor's
   request signature so a cursor from one sort is refused for the other
   (`JOB_QUEUE_REFRESH_REQUIRED`). Visibility/scope predicates unchanged.
3. `apps/web/app/routes/_authenticated/job-queue/index.tsx` (+ `use-job-queue.ts`) — a sort control
   (existing shadcn Select / segmented control pattern used by other list pages), state in the
   route search params, resets pagination on change. Labels through Lingui, `uk` + `en` catalogs.
   Responsive (mobile/tablet/laptop/large) and keyboard accessible.

## Reuse / Regression scope

- Existing sort/filter controls in other list routes — ast-grep for a Select-in-toolbar pattern first.
- Must not break: relevance order and its cursors, filters (`availability`, etc.), scope switch
  cache (task-vacancy-7-6c), external submission dialog, HR/ADMIN/DROP scopes.

## Seams under test

- Queue list endpoint: integration spec — published order with NULL `published_at`, stable
  paging across two pages, cross-sort cursor refused.
- Web: component test — switching the sort updates the search param and refetches page 1.
- E2E: extend the existing job-queue spec with one sort switch.

## Assumptions

- "Publication date" = `published_at`, fallback `first_seen_at` (owner chose publication date).
- A1 (coder): the publication date is snapshotted per generation entry (`job_queue_generation_entries.published_at`, filled at publish). Reading the live `job_opportunities.published_at` was rejected: canonical store updates it, so the order would shift under an open cursor. The cost: one nullable column plus a manual DDL file.
- A1 (coder): the published sort re-orders the same generation set (the relevance top-N). A capped generation stays capped, and the notice still refers to the relevance cut.
- A1 (coder): generations published before the deploy carry a NULL snapshot, so until their natural replacement (≤ one generation TTL) the published sort orders them by first seen. No backfill: generation entries are append-only.
- A1 (coder): a relevance cursor keeps a byte-identical signature (the sort joins the identity only when it is not the default), so cursors in flight at deploy stay valid.
- A1 (coder, review round 2, CR-M-1): the publish INSERT also stores `published_order_key` (the dense position in `published_at DESC NULLS LAST, first_seen_at DESC, id DESC`), indexed by the unique `uq_job_queue_generation_entries_published_order (generation_id, published_order_key)` like `order_key`. A one-team published read pages that stored key through the index, like relevance. A multi-team (HR union) read keeps the merged `row_number()` over the member entries, ordered by the snapshotted dates, so the merge stays correct. The counts query never numbers an order: it counts the raw entries (one team) or the distinct opportunities (union).
- A1 (coder, review round 2, CR-M-1): a generation published before the deploy has a NULL `published_order_key` (entries are immutable, never UPDATEd, no backfill). The counts query reports it (`unkeyed`), and that generation's published read falls back to the read-time `row_number()` window until it is replaced (≤ one generation TTL). Its relevance read is unaffected. Rejected: refusing the published sort, or forcing a new generation, for an unkeyed generation (both change behaviour for at most 15 minutes after a deploy, for no gain).
- Deploy wiring (DevOps zone granted to coder by Master for this one change, review round 1): `apps/api/drizzle/manual/2026-11-25_job_queue_entries_published_at.sql` is in the deploy.yml hard-required list and SCP steps, in `scripts/devops/deploy-stack-on-vps.sh` (applied before the grants and the container swap), and in `docs/runbooks/deployment.md` (step 60ta).

## PR body — Known limitations

- A multi-team (HR union) published read, and a published read of a generation published before the deploy, still number the order per page read (a `row_number()` window over at most 5000 entries per member team); a one-team read pages the stored, indexed `published_order_key`.
- Generations published before the deploy have no `published_at` snapshot, so for at most one generation lifetime the published sort orders their vacancies by first seen; accepted at review round 1.

## Acceptance criteria

1. Sort control visible on `/job-queue`, default relevance, uk + en labels.
2. Published sort returns newest-published first across pages, NULLs ordered by first seen.
3. A cursor is refused across sorts; relevance behaviour unchanged.
4. Specs above green; E2E run locally before push.
