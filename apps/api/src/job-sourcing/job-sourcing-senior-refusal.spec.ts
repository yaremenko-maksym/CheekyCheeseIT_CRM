import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import { JobSourcingService } from './job-sourcing.service'
import { JobSourceRegistry } from './registry/job-source-registry'

/**
 * task-sources-07c — the SENIOR refusal, against a database that would SCREAM if it were reached.
 *
 * WHY THIS FILE EXISTS (code review round 1 CR-H-1 / security review SR-M-1). The queue is closed
 * to a SENIOR in two places: `@Roles('ADMIN','HR')` on the controller, and `assertNotSenior` as the
 * first statement of all six public service methods. The second one is the one that matters —
 * `RolesGuard` is a NO-OP without `@Roles`, so the decorator set is one careless refactor away from
 * being widened again, and the service-body refusal is what survives that.
 *
 * The refusal WAS tested, in `job-queue-rbac.integration.spec.ts`. But that file is an
 * `*.integration.spec.ts`, which the mutation gate STRUCTURALLY cannot execute
 * (`.claude/rules/common/mutation-gate-integration-specs.md`), and it is additionally
 * `describe.skipIf(!hasDatabaseUrl())`. So on the gate the whole guard was unkilled —
 * `assertNotSenior`'s body could be emptied, its condition forced either way, or `'SENIOR'`
 * replaced with `""`, and the suite stayed green. The exact regression the method's own docblock
 * promises to catch was the one regression nothing could catch. This is the unit double the rule
 * asks for, not a duplicate of the integration spec: that one keeps proving the real guard chain
 * over a real database, this one is what the gate can run.
 *
 * THE DEVICE: every door out of the service is a THROWING STUB. If a refusal ever stops happening
 * before the first read, the method reaches the stub and the error text changes — so each test
 * asserts the SENIOR sentence verbatim rather than merely "it rejected". "It rejected" would be
 * satisfied by the stub itself, by `assertCanAccessSenior`'s own trailing `ForbiddenException`, and
 * by the `BadRequestException` for a missing senior id. Asserting the sentence pins WHICH guard
 * spoke, and `expect(select).not.toHaveBeenCalled()` pins that it spoke BEFORE any row was read —
 * which is also what denies a SENIOR the 403-vs-404 existence oracle over somebody else's
 * exclusion ids.
 */

/** The sentence `assertNotSenior` throws, verbatim (`job-sourcing.service.ts`). */
const SENIOR_REFUSAL =
  'Vacancy sourcing is run by ADMIN and HR; a senior sees the result as interview cards'

/** Thrown by every stubbed door. Reaching it means a guard did NOT fire first. */
const DB_TOUCHED = 'DB_TOUCHED: the guard let the request through to the database'

const SENIOR = { id: '30000000-0000-4000-8000-000000000001', role: 'SENIOR' } as SessionUser
const OTHER_SENIOR = '30000000-0000-4000-8000-000000000002'
const HR = { id: '40000000-0000-4000-8000-000000000001', role: 'HR' } as SessionUser

const SUGGESTION_ID = '20000000-0000-4000-8000-000000000001'
const EXCLUSION_ID = '50000000-0000-4000-8000-000000000001'

function build() {
  const throwing = () =>
    vi.fn(() => {
      throw new Error(DB_TOUCHED)
    })
  const [select, transaction, execute, hrSharesActiveTeamWith] = [
    throwing(),
    throwing(),
    throwing(),
    throwing(),
  ]

  const db = { db: { select, transaction, execute }, execute }
  const hrAccess = { hrSharesActiveTeamWith }
  // An empty registry: the service keeps a `JobSourceRegistry` as given, so constructing it needs
  // no adapter and cannot reach the network.
  const svc = new JobSourcingService(db as never, hrAccess as never, new JobSourceRegistry([]))
  return { svc, select, transaction, execute, hrSharesActiveTeamWith }
}

/**
 * Every public method the controller exposes, each invoked as a SENIOR.
 *
 * Two shapes of SENIOR argument on purpose: `undefined` (asking for "my own" queue) and ANOTHER
 * senior's id. Both must refuse identically — a refusal that depended on the argument would be a
 * resolve, not a gate.
 */
const CALLS: readonly {
  readonly name: string
  readonly run: (s: JobSourcingService) => Promise<unknown>
}[] = [
  { name: 'listSuggestions (no senior named)', run: (s) => s.listSuggestions(undefined, SENIOR) },
  { name: 'listSuggestions (their OWN id)', run: (s) => s.listSuggestions(SENIOR.id, SENIOR) },
  {
    name: "listSuggestions (ANOTHER senior's id)",
    run: (s) => s.listSuggestions(OTHER_SENIOR, SENIOR),
  },
  {
    name: 'updateStatus',
    run: (s) => s.updateStatus(SUGGESTION_ID, { status: 'REJECTED' }, SENIOR),
  },
  { name: 'openOpportunity', run: (s) => s.openOpportunity(SUGGESTION_ID, SENIOR) },
  { name: 'listExclusions (no senior named)', run: (s) => s.listExclusions(undefined, SENIOR) },
  {
    name: "listExclusions (ANOTHER senior's id)",
    run: (s) => s.listExclusions(OTHER_SENIOR, SENIOR),
  },
  {
    name: 'createExclusion (GLOBAL)',
    run: (s) => s.createExclusion({ scope: 'GLOBAL', kind: 'COMPANY', value: 'Acme Corp' }, SENIOR),
  },
  {
    name: 'createExclusion (SENIOR scope)',
    run: (s) =>
      s.createExclusion(
        { scope: 'SENIOR', seniorId: OTHER_SENIOR, kind: 'COMPANY', value: 'Acme Corp' },
        SENIOR,
      ),
  },
  { name: 'deleteExclusion', run: (s) => s.deleteExclusion(EXCLUSION_ID, SENIOR) },
]

describe('JobSourcingService — the queue is closed to a SENIOR in the service body', () => {
  it.each(CALLS)('$name refuses a SENIOR with the SENIOR sentence', async ({ run }) => {
    const h = build()

    const err = await run(h.svc).then(
      () => new Error('expected a refusal, got a result'),
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ForbiddenException)
    // The sentence, not merely "some 403": `assertCanAccessSenior`'s trailing refusal and the
    // throwing stub are both rejections too, and either would satisfy a weaker assertion.
    expect((err as Error).message).toBe(SENIOR_REFUSAL)
  })

  it.each(CALLS)('$name reads NO row before refusing', async ({ run }) => {
    const h = build()

    await run(h.svc).catch(() => undefined)

    // No existence oracle: a SENIOR cannot tell a real exclusion id from a made-up one, because
    // nothing is looked up before the refusal.
    expect(h.select).not.toHaveBeenCalled()
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.hrSharesActiveTeamWith).not.toHaveBeenCalled()
  })

  it('refuses every entry point in the table at once, with no row read anywhere', async () => {
    // The cases above run one at a time; this asserts the whole set together, so the count is
    // visible in the assertion and a case silently dropped from CALLS shrinks a number somebody
    // can see rather than quietly weakening the claim.
    const h = build()

    const outcomes = await Promise.allSettled(CALLS.map((c) => c.run(h.svc)))
    const refusals = outcomes
      .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
      .map((o) => String((o.reason as Error).message))

    expect(refusals).toHaveLength(CALLS.length)
    expect(new Set(refusals)).toEqual(new Set([SENIOR_REFUSAL]))
    expect(h.select).not.toHaveBeenCalled()
  })

  describe('CONTROL: the guard is conditional on the ROLE, not a blanket refusal', () => {
    // Without these, forcing `assertNotSenior`'s condition to `true` (refuse everyone) would
    // satisfy every assertion above. HR legitimately fails further in — on a throwing stub, or on
    // "no senior selected" — and what must NEVER appear for HR is THIS sentence.
    it('an HR is not refused by the SENIOR check, and does reach the database', async () => {
      const h = build()

      const outcomes = await Promise.allSettled([
        h.svc.listSuggestions(OTHER_SENIOR, HR),
        h.svc.listExclusions(OTHER_SENIOR, HR),
        h.svc.updateStatus(SUGGESTION_ID, { status: 'REJECTED' }, HR),
        h.svc.openOpportunity(SUGGESTION_ID, HR),
        h.svc.deleteExclusion(EXCLUSION_ID, HR),
      ])
      const refusals = outcomes
        .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
        .map((o) => String((o.reason as Error).message))

      // Collected first, asserted once: HR may legitimately fail on any of these, and the whole
      // claim is about WHICH sentence can never appear. (A conditional `expect` would also
      // silently assert nothing on a run where HR happened to get further than expected.)
      expect(refusals.join(' | ')).not.toContain(SENIOR_REFUSAL)
      // And HR got past the role gate for real, rather than failing earlier for some other
      // reason: at least one path reached a stubbed door. This is what makes the stubs evidence.
      expect(refusals.join(' | ')).toContain(DB_TOUCHED)
    })

    it('an HR with no senior selected is told to pick one, not that the queue is closed', async () => {
      const h = build()

      const err = await h.svc.listSuggestions(undefined, HR).then(
        () => new Error('expected a refusal, got a result'),
        (e: unknown) => e,
      )

      expect(err).toBeInstanceOf(BadRequestException)
      expect((err as Error).message).not.toBe(SENIOR_REFUSAL)
    })
  })
})
