import type { DropSharePercentSource } from '@crm/shared'

/**
 * Default drop-share percentage when `users.dropSharePercent` is NULL.
 *
 * Single source of truth — never duplicate the literal 5. Lives here (not in
 * transactions.service.ts) so both the resolver and the service can consume it
 * without a circular import: transactions.service imports the resolver, so the
 * constant must sit on the resolver side. Re-exported from transactions.service
 * for backward compatibility with existing call sites.
 */
export const DEFAULT_DROP_SHARE_PERCENT = 5

/**
 * Resolved drop share % with its provenance.
 *
 * `source` records *where* the percent came from at resolution time so the UI
 * can render a "Источник: проект/default" badge, and so the value is written
 * verbatim into `transactions.drop_share_percent` +
 * `transactions.drop_share_percent_source` at DROP_INCOME / DROP_PENDING_PAYOUT
 * creation time and never recomputed on read.
 */
export type ResolvedDropShare = {
  value: number
  source: DropSharePercentSource
}

/**
 * Minimal project-shaped input the resolver needs — only the per-project
 * override column is consulted.
 */
export type DropResolverProject = {
  dropSharePercentOverride: number | null | undefined
}

/**
 * Drop-shaped input the resolver consults when no project override applies.
 * `dropSharePercent` is the user-level default (DB column defaults to 5; falls
 * back to DEFAULT_DROP_SHARE_PERCENT here defensively when null/undefined).
 */
export type DropResolverDrop = {
  dropSharePercent: number | null | undefined
}

/**
 * Resolve the drop share % with source provenance.
 *
 * Hierarchy (highest priority first) — NO team level (unlike the senior; a drop
 * is bound to a project directly via `projects.dropId`, not through team
 * membership, so there is no team-scoped override to consider):
 *   1. `project.dropSharePercentOverride` (NULL/undefined skips → step 2)
 *   2. `drop.dropSharePercent` (falls back to DEFAULT_DROP_SHARE_PERCENT = 5
 *      when null/undefined).
 *
 * The output is intentionally pure — no DB writes, no `await`. Invoked once per
 * DROP_INCOME / admin-USDT obligation and its result is written into the
 * transaction snapshot (and surfaced in the project DTO for the UI hint).
 *
 * @param project — minimum project shape (override-bearing column only).
 * @param drop    — minimum drop-user shape (default-bearing column only).
 */
export function resolveDropShare(
  project: DropResolverProject,
  drop: DropResolverDrop,
): ResolvedDropShare {
  // 1) Project-level override wins.
  if (project.dropSharePercentOverride !== null && project.dropSharePercentOverride !== undefined) {
    return { value: project.dropSharePercentOverride, source: 'PROJECT' }
  }

  // 2) Fall back to the user-level default (or 5 if somehow null).
  return {
    value: drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT,
    source: 'USER_DEFAULT',
  }
}
