# task-vacancy-queue-sort

## Agent: coder
## Status: ready
## Blockers: none
## Priority: medium
## Model: opus — queue generation/cursor + RBAC-scoped reads, routed T3
## Depends on: nothing (disjoint from task-vacancy-retention-60d except queue reads; rebase if it lands first)
## Branch: feature/vacancy-queue-sort

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

## Acceptance criteria

1. Sort control visible on `/job-queue`, default relevance, uk + en labels.
2. Published sort returns newest-published first across pages, NULLs ordered by first seen.
3. A cursor is refused across sorts; relevance behaviour unchanged.
4. Specs above green; E2E run locally before push.
