import type { PendingSeniorShare } from '@crm/shared'
import { DEFAULT_DROP_SHARE_PERCENT } from '../finance/drop-share-resolver'
import { resolveSeniorShare } from '../finance/senior-share-resolver'

/**
 * Pure senior/drop share math (extracted verbatim from `ProjectsService.update`
 * and `ProjectsService.loadPendingSeniorShare`, leaf P-L4). Synchronous, no
 * I/O: every function takes already-loaded values and returns a value/DTO.
 */

/** Effective senior default used for implicit-null detection in `update`. */
export function pickSeniorDefault(
  senior: { seniorSharePercent: number | null } | null | undefined,
): number {
  return senior?.seniorSharePercent ?? 26
}

/** Effective drop default used for implicit-null detection in `update`. */
export function pickDropDefault(
  drop: { dropSharePercent: number | null } | null | undefined,
): number {
  return drop?.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT
}

/**
 * Round-3 implicit-null detection: `undefined` (key absent) stays unchanged,
 * explicit `null` clears, and a value equal to the effective default is
 * interpreted as a reset (`null`); anything else is written as-is. Shared by
 * the senior and drop overrides.
 */
export function resolveOverrideEffective(
  requested: number | null | undefined,
  effectiveDefault: number,
): number | null | undefined {
  // `undefined` and `null` pass through unchanged (`effectiveDefault` is a
  // number, so neither can ever equal it); only a default-equal number resets.
  return requested === effectiveDefault ? null : requested
}

/**
 * "Actual-change, not mere presence" gate for a requested senior override:
 * true when a change was requested and differs from the currently active value.
 */
export function isSeniorOverrideChange(
  overrideEffective: number | null | undefined,
  current: number | null | undefined,
): overrideEffective is number | null {
  return overrideEffective !== undefined && overrideEffective !== (current ?? null)
}

/**
 * Same gate for the drop override. NOTE: compares against `current` WITHOUT
 * `?? null` coalescing (verbatim from `update`) — preserved as-is.
 */
export function isDropOverrideChange(
  dropOverrideEffective: number | null | undefined,
  current: number | null | undefined,
): dropOverrideEffective is number | null {
  return dropOverrideEffective !== undefined && current !== dropOverrideEffective
}

/**
 * Pure DTO compute for a LIVE PENDING senior-share proposal: resolves what the
 * effective percent WOULD become if approved, via the same resolver
 * `mapProject` uses, substituting the PENDING value for the live override.
 */
export function buildPendingSeniorShareDto(
  senior: { id: string; displayName: string; seniorSharePercent: number | null },
  pendingValue: number | null | undefined,
  teamOverridesBySeniorId: Map<string, { id: string; seniorSharePercentOverride: number | null }[]>,
): PendingSeniorShare {
  // task-648-fix-round-1 (COPY-H-2/COPY-H-3): `percent: null` ("clear the
  // override") renders as the real fallback number. `resolveSeniorShare`'s
  // TEAM step keeps only elements where `t.seniorSharePercentOverride !== null
  // && !== undefined`; Stryker's canned replacement (a bare string) has no such
  // property, so the element is filtered out exactly like an empty array would
  // be — indistinguishable through the only consumer below.
  // Stryker disable next-line ArrayDeclaration: the fallback value is unobservable through resolveSeniorShare's filter.
  const applicableTeams = teamOverridesBySeniorId.get(senior.id) ?? []
  const effectivePercentAfterApproval = resolveSeniorShare(
    { seniorSharePercentOverride: pendingValue },
    { seniorSharePercent: senior.seniorSharePercent },
    applicableTeams,
  ).value
  return {
    percent: pendingValue ?? null,
    effectivePercentAfterApproval,
    approverId: senior.id,
    approverName: senior.displayName,
  }
}
