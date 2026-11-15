import { and, eq } from 'drizzle-orm'
import type { DatabaseService } from '../../database/database.service'
import type { DrizzleTx } from '../../database/types'
import { seniorResumes } from '../../database/schema'

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
 * resume "re-check needed". Called inside the transaction of the user write, so the flag commits
 * with it. A resume in any other status is not flagged: its next confirm reads the new values.
 */
export async function markResumeRecheckNeeded(
  db: DatabaseService['db'] | DrizzleTx,
  userId: string,
  existing: RedactionInputs,
  set: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!redactionInputChanged(existing, set)) return
  await db
    .update(seniorResumes)
    .set({ recheckNeededAt: new Date() })
    .where(and(eq(seniorResumes.userId, userId), eq(seniorResumes.verificationStatus, 'VERIFIED')))
}
