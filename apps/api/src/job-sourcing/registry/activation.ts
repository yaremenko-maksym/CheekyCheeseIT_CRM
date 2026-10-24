import type { RegisteredAdapter } from './registered-adapter'

/**
 * Whether a registered adapter may be ACTIVATED for scheduled collection (r5 Task 2.5 T2).
 *
 * "Evidence is not permission" (PR #1139): a source the owner has permitted by decision, but whose
 * API payload was never captured, is READY ON PAPER and UNVERIFIED IN FACT. It is reported
 * `NOT_VERIFIED` and an `enabled` flag alone never turns it on. The statuses, strongest refusal
 * first:
 *
 *  - `UNREGISTERED` -- no adapter is registered for the type (nothing can run it);
 *  - `BLOCKED`      -- a permission, key, deadline or status blocker stands;
 *  - `NOT_VERIFIED` -- the only blockers are missing captures, or the payload is not verified;
 *  - `ACTIVATABLE`  -- registered, no blocker, payload captured.
 */
export const ACTIVATION_STATUSES = [
  'UNREGISTERED',
  'BLOCKED',
  'NOT_VERIFIED',
  'ACTIVATABLE',
] as const
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number]

/**
 * What the manifest knows about a type at one instant. A plain value, so the registry never imports
 * the manifest (which reads fixture files) at runtime.
 */
export interface ActivationFacts {
  /** The manifest's `readinessAt(type, now).status`. */
  readonly readiness: 'CANDIDATE' | 'BLOCKED' | 'LEGACY'
  /** The codes of the blockers standing at that instant. */
  readonly blockerCodes: readonly string[]
  /** `ManifestType.payloadVerified`. */
  readonly payloadVerified: boolean
}

/** Blockers that say "no real capture exists", not "this is not allowed". */
const EVIDENCE_BLOCKERS: ReadonlySet<string> = new Set(['NO_CAPTURE', 'NO_API_CAPTURE'])

/**
 * The activation status of one type.
 *
 * A LEGACY adapter (DOU) is activatable without manifest facts: it is the pipeline that already
 * runs, wrapped, not a candidate. A REPORTING adapter without facts is `NOT_VERIFIED` -- absence of
 * evidence is not approval.
 */
export function activationOf(
  adapter: RegisteredAdapter | undefined,
  facts: ActivationFacts | undefined,
): ActivationStatus {
  if (adapter === undefined) return 'UNREGISTERED'
  if (adapter.contract === 'LEGACY') return 'ACTIVATABLE'
  if (facts === undefined) return 'NOT_VERIFIED'
  if (facts.blockerCodes.some((c) => !EVIDENCE_BLOCKERS.has(c))) return 'BLOCKED'
  if (facts.blockerCodes.length > 0 || !facts.payloadVerified) return 'NOT_VERIFIED'
  // Only CANDIDATE approves. BLOCKED, and LEGACY on a reporting adapter (a contradiction), refuse.
  return facts.readiness === 'CANDIDATE' ? 'ACTIVATABLE' : 'BLOCKED'
}
