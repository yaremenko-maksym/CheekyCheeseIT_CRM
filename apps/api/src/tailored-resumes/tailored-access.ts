/**
 * Who may read or start a tailored resume (tailored-resume spec §9): the job queue's own scope
 * rules, then the submission path's senior check (`assertSeniorEligible`, plan D20). Every miss is
 * the queue's one `JOB_OPPORTUNITY_NOT_FOUND` 404, so a viewer cannot probe another team.
 */
import type { SessionUser } from '@crm/shared'
import { findMatchingExclusion } from '../job-sourcing/filtering'
import { exclusionPosting } from '../job-sourcing/funnel/evaluate'
import type { WriteScope } from '../job-sourcing/queue/queue-actions'
import { canonicalUuid } from '../job-sourcing/queue/queue-scope'
import type { JobQueueScopeService } from '../job-sourcing/queue/queue-scope.service'
import { assertSeniorEligible, notFound } from '../job-sourcing/queue/senior-eligibility'
import { loadOpportunity, loadSeniorsExclusions } from '../job-sourcing/runtime/recompute-inputs'
import type { SqlExecutor } from '../job-sourcing/scheduling/host-state'

/**
 * The scope that may act on (opportunity, senior), read inside `tx` so the write it authorizes
 * cannot outlive it. A role outside ADMIN/HR is `resolve`'s 403; a malformed senior id is the 404
 * before any query (its `::uuid` cast would otherwise surface as a 503).
 */
export async function authorizeSenior(
  scopes: JobQueueScopeService,
  user: SessionUser,
  opportunityId: string,
  seniorId: string,
  teamId: string | undefined,
  tx: SqlExecutor,
): Promise<WriteScope> {
  const scope = await scopes.resolve(user, teamId, tx)
  if (scope.kind === 'NONE') throw notFound()
  await scopes.assertVisible(scope, opportunityId, tx)
  const senior = canonicalUuid(seniorId)
  if (senior === null) throw notFound()
  await assertSeniorEligible(scopes, tx, scope, senior, opportunityId)
  return scope
}

/**
 * The asked seniors this scope may see for the opportunity: live in the scope and not stop-listed
 * by their own exclusions (the `assertSeniorEligible` rule, as set queries). An id outside is
 * omitted, never reported.
 */
export async function visibleSeniors(
  scopes: JobQueueScopeService,
  scope: WriteScope,
  opportunityId: string,
  ids: readonly string[],
  tx: SqlExecutor,
): Promise<string[]> {
  const live = new Set((await scopes.liveVersions(scope, tx)).map((v) => v.seniorId))
  const asked = ids.filter((id) => live.has(id))
  if (asked.length === 0) return []
  const loaded = await scopes.policy(() => loadOpportunity(tx, opportunityId))
  if (loaded === null) return []
  const all = await scopes.policy(() => loadSeniorsExclusions(tx, asked))
  const posting = exclusionPosting(loaded.canonical)
  return asked.filter(
    (id) =>
      findMatchingExclusion(
        posting,
        all.filter((e) => e.seniorId === id),
      ) === null,
  )
}
