import { and, eq } from 'drizzle-orm'
import type { DrizzleTx } from '../../database/types'
import { seniorResumes, users } from '../../database/schema'

/**
 * The owner columns a verification run redacts from the resume text (`loadOwnerContacts`), minus
 * the emails (backlog 442 names these three).
 */
const REDACTION_INPUTS = ['displayName', 'legalFullName', 'telegram'] as const

type RedactionInputs = { readonly [K in (typeof REDACTION_INPUTS)[number]]?: string | null }

/** True when a user UPDATE (`set`) writes a redaction input with a value other than `existing`'s. */
export const redactionInputChanged = (
  existing: RedactionInputs,
  set: Readonly<Record<string, unknown>>,
): boolean => REDACTION_INPUTS.some((c) => c in set && (set[c] ?? null) !== (existing[c] ?? null))

/**
 * Backlog 442: a user row edit that really changes a redaction input flags the owner's VERIFIED
 * resume "re-check needed". Call it inside the transaction of the user write and BEFORE its
 * UPDATE: it reads the values the write replaces under `FOR NO KEY UPDATE` (it conflicts with
 * every other writer of the row, not with a key-share lock of an FK insert), so a concurrent writer
 * cannot make the compare stale, and the flag commits or rolls back with the write. A resume in any
 * other status is not flagged: a staged result is stamped with the owner key of these values
 * (`renderOwnerKey`), so its confirm is refused as stale after the change and a new run is needed.
 */
export async function markResumeRecheckNeeded(
  tx: DrizzleTx,
  userId: string,
  set: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!REDACTION_INPUTS.some((c) => c in set)) return
  const [before] = await tx
    .select({
      displayName: users.displayName,
      legalFullName: users.legalFullName,
      telegram: users.telegram,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update')
  if (!before || !redactionInputChanged(before, set)) return
  await tx
    .update(seniorResumes)
    .set({ recheckNeededAt: new Date() })
    .where(and(eq(seniorResumes.userId, userId), eq(seniorResumes.verificationStatus, 'VERIFIED')))
}
