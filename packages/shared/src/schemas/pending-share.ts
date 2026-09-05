import { z } from 'zod'

/**
 * Pending senior share — task-pending-share (position 5 of
 * docs/superpowers/specs/2026-09-01-notifications-and-confirmations-
 * design.md, §4.3). A changed SENIOR share % (project override OR a
 * person's own base default) does not take effect until the affected senior
 * confirms it on the platform — see `approvals` (subject types
 * 'PROJECT_SENIOR_SHARE' / 'USER_SENIOR_SHARE'). The TEAM level
 * (`teams.seniorSharePercentOverride`) is deliberately excluded — it applies
 * immediately, per the owner's decision recorded in the task file.
 *
 * DELIBERATELY its own leaf file (no imports beyond `zod`) rather than living
 * in `finance.ts` alongside `seniorSharePercentSourceSchema` — it started
 * there, but `finance.ts` imports from `interviews.ts`, which imports
 * `itDomainSchema` FROM `projects.ts`, and `projects.ts` needs THIS schema:
 * projects → finance → interviews → projects. ESM circular imports can
 * silently evaluate a binding as `undefined` at module-init time depending on
 * evaluation order (`interviews.ts`'s own top-level `itDomainSchema.nullable()`
 * threw exactly that TypeError under Vitest) — a leaf file both `projects.ts`
 * and `users.ts` can depend on directly closes the cycle instead of hoping the
 * evaluation order never bites.
 */

/**
 * A proposed new SENIOR share % awaiting the affected senior's own
 * confirmation. Presence of this object (vs `null` on the DTO field that
 * carries it) IS the "something is pending" signal — never infer it from
 * `percent` alone: a PROJECT-level proposal can legitimately propose `null`
 * ("clear the override, fall back to the team/user default"), so `percent`
 * being null does not mean nothing is pending.
 */
export const pendingSeniorShareSchema = z.object({
  /**
   * Proposed value. Nullable only for a PROJECT-level proposal — a base-share
   * proposal is always a concrete percent (the column it targets,
   * `users.seniorSharePercent`, is NOT NULL, so there is nothing to "clear").
   */
  percent: z.number().int().min(0).max(100).nullable(),
  /**
   * task-648-fix-round-1 (COPY-H-2/COPY-H-3). What the EFFECTIVE percent
   * would become if this proposal is approved — resolved server-side by the
   * SAME PROJECT → TEAM → USER_DEFAULT resolver
   * (`senior-share-resolver.ts#resolveSeniorShare`) that computes
   * `effectiveSeniorSharePercent`, substituting `percent` above for the
   * live override. Always a concrete number, even when `percent` itself is
   * `null` ("clear the override, fall back to team/user default") — the
   * client must never compute this locally (`percent ?? 0` was the actual
   * bug: it rendered "0%" for a clear-override proposal instead of the real
   * fallback value) or re-derive it from `seniorSharePercentDefault` alone
   * (that field ignores the TEAM level entirely — see OOS-1, out of this
   * task's scope). For a base-share (USER-level) proposal this always
   * equals `percent` itself (nothing else can override a person's own base
   * default), but is still sent so the client has ONE field to read
   * regardless of which level proposed the change.
   */
  effectivePercentAfterApproval: z.number().int().min(0).max(100),
  /** Who must confirm — the affected SENIOR (the person whose share this is). */
  approverId: z.string().uuid(),
  approverName: z.string(),
})
export type PendingSeniorShare = z.infer<typeof pendingSeniorShareSchema>

/**
 * Rejecting a pending share-change proposal requires a reason (design spec
 * §3 decision 3 — "Отказ возможен и требует причины"). Shared by the
 * project-override and base-share reject endpoints; same validation shape
 * as `rejectProjectSchema` (a project draft is a different subject, so a
 * separate schema keeps the two endpoints' contracts independently
 * evolvable even though the rule is identical today).
 */
export const rejectPendingShareSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Причина отказа обязательна')
    .max(500, 'Причина отказа слишком длинная (максимум 500 символов)'),
})
export type RejectPendingShareDto = z.infer<typeof rejectPendingShareSchema>
