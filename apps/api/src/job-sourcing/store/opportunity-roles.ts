import { sortRoles, type TechnicalRole } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { ROLE_CLASSIFIER_VERSION, classifyRoles } from '../funnel/role-classifier'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * Senior roles PR 2 (Task 2.3): a vacancy's technical roles, decided at ingest and backfilled by
 * the recompute. The deterministic classifier answers first; when it cannot name a role the AI
 * cache (`job_role_classifications`, written by the AI pass) is read at the CURRENT classifier
 * version only. Nothing here touches `revision`: a reclassification alone never re-evaluates.
 */

export type RoleStatus = 'RULE' | 'AI' | 'PENDING' | 'UNCLEAR' | 'NON_IT'

export type OpportunityRoles = {
  status: RoleStatus
  roles: readonly TechnicalRole[]
  classifierVersion: string
}

/** A text[] parameter, without drizzle spreading the JS array into a row constructor. */
export const textArray = (values: readonly string[]) =>
  sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`

const result = (status: RoleStatus, roles: readonly TechnicalRole[] = []): OpportunityRoles => ({
  status,
  roles,
  classifierVersion: ROLE_CLASSIFIER_VERSION,
})

export async function deriveOpportunityRoles(
  tx: SqlExecutor,
  f: {
    title: string
    titleKey: string
    tags: readonly string[]
    descriptionSha256: string | null
  },
): Promise<OpportunityRoles> {
  const rule = classifyRoles({ title: f.title, tags: f.tags })
  if (rule.kind === 'ROLES') return result('RULE', rule.roles)
  if (rule.kind === 'NON_IT') return result('NON_IT')
  // Review Focus 2: a title-only record (detail still pending) never reuses a full-text answer.
  if (f.descriptionSha256 === null) return result('PENDING')
  const { rows } = await tx.execute(
    sql`SELECT outcome, technical_roles FROM job_role_classifications
         WHERE title_key = ${f.titleKey} AND description_sha256 = ${f.descriptionSha256}
           AND classifier_version = ${ROLE_CLASSIFIER_VERSION}`,
  )
  const cached = rows[0]
  if (cached?.['outcome'] === 'UNCLEAR') return result('UNCLEAR')
  // technical_roles is NOT NULL. An AI row without roles cannot satisfy
  // ck_job_opportunities_roles_iff_status: treat it as unanswered.
  const roles = cached?.['outcome'] === 'AI' ? (cached['technical_roles'] as TechnicalRole[]) : []
  if (roles.length > 0) return result('AI', sortRoles(roles))
  return result('PENDING')
}

/** The 3 role columns only: never `revision`, never `updated_at` (no re-evaluation, no ordering). */
export async function writeOpportunityRoles(
  tx: SqlExecutor,
  opportunityId: string,
  r: OpportunityRoles,
): Promise<void> {
  await tx.execute(
    sql`UPDATE job_opportunities
           SET technical_roles = ${textArray(r.roles)}, role_status = ${r.status},
               role_classifier_version = ${r.classifierVersion}
         WHERE id = ${opportunityId}::uuid`,
  )
}
