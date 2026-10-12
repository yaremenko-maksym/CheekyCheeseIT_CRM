import { HttpStatus } from '@nestjs/common'
import { and, inArray, isNull } from 'drizzle-orm'
import type {
  SessionUser,
  IncomeComplianceOverviewDto,
  IncomeComplianceReceiverDto,
  IncomeComplianceRole,
} from '@crm/shared'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import { transactions, users, visibleProjects } from '../database/schema'

/**
 * Income compliance overview — «Контроль приходов» (task-income-compliance).
 *
 * Company-wide, NOT self-scoped: for EVERY income receiver (SENIOR + ADMIN-as-
 * senior via projects.seniorId, DROP via projects.dropId) it reports how many
 * of their active projects already have a COUNTED income this month (X) out of
 * their active project count (N), plus the list of projects WITHOUT a counted
 * income for the expand drawer. Sorted laggards-first.
 *
 * RBAC: ADMIN + ACCOUNTANT ONLY. Defense-in-depth — the controller's @Roles
 * gate runs first, and this service-side check throws 403 too (kept
 * intentionally, never replaced; same belt-and-suspenders as
 * getAccountantSummary / getSeniorSummary). Because this aggregates MANY
 * receivers' figures, it must never reach a SENIOR / JUNIOR / HR / DROP. The
 * SET of receivers is derived SOLELY from active-project ownership
 * (`seniorId`/`dropId`) — task-compliance-overview-pending-types (AC3) keeps
 * it that way: recognising more transaction TYPES as evidence never adds a
 * receiver who does not already own an active project.
 *
 * «Приход внесён по проекту» (owner decision, task-file) = ≥1 income row of the
 * receiver's income type for the project with status VALIDATED|PAID and
 * `(txDate ?? createdAt)` inside the target month (UTC). PENDING does NOT count
 * (but flags the project as `pendingValidation` for the «на валидации» badge);
 * REJECTED is ignored. ADMIN_INCOME is written PAID immediately, so an admin-as-
 * senior's projects count as soon as the income row exists.
 *
 * task-compliance-overview-pending-types (2026-08-16). The criterion above was
 * written for the self-declare model and never learned the OBLIGATION model
 * (`bookCompanyObligations`) that the current USDT admin-declare path actually
 * uses for SENIOR/DROP — see the extended comment on
 * `incomeComplianceProjectSchema` in `packages/shared` for the full owner
 * decision. Summary: a THIRD state, `accrued`, covers a company-booked
 * obligation still PENDING_PAYMENT (booked, not yet paid — counts as neither
 * `submitted` NOR `lagging`); its later settlement is picked up by the
 * EXISTING `submitted` criterion because `settleByCompany` flips the row in
 * place to a type this method already recognised as income evidence
 * (`SENIOR_INCOME` for a senior; `PAYOUT_DROP` — newly added here — for a
 * drop, since a drop's settlement does NOT reuse `DROP_INCOME`).
 *
 * security-review PR #531 round 1 (MED-1/MED-2), both fixed:
 *   - MED-1: the obligation-model types (SENIOR_PENDING_PAYOUT /
 *     DROP_PENDING_PAYOUT / PAYOUT_DROP) are looked up KEYED BY RECEIVER
 *     (`evidenceKey`, §3 below) — NOT project+type alone. Without this, a
 *     project's `dropId` (or `seniorId`) reassignment would let the NEW
 *     owner inherit the OLD owner's evidence for the rest of the month — a
 *     person who was never paid would render compliant.
 *   - MED-2: `PENDING_PAYMENT` is NOT exclusive to a booked-unpaid
 *     obligation — `createPayoutRequest` also flips an already-VALIDATED
 *     self-declare SENIOR_INCOME/DROP_INCOME row to `PENDING_PAYMENT` for
 *     the payout-request window. That is `received` (already earned), not
 *     `accrued` — see the type-aware classification in §3.
 *
 * @param month optional 'YYYY-MM' (UTC). Defaults to the current UTC month.
 */
export async function getIncomeComplianceOverview(
  db: DatabaseService,
  currentUser: SessionUser,
  month?: string,
): Promise<IncomeComplianceOverviewDto> {
  if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
    throw apiError('FINANCE_INCOME_COMPLIANCE_FORBIDDEN', HttpStatus.FORBIDDEN)
  }

  // ── Resolve the target month window [monthStart, nextMonthStart) in UTC ────
  // Consistent with getAccountantSummary / getSeniorSummary (all UTC). When a
  // `month` is given it is already validated as YYYY-MM by the controller's Zod
  // schema; default = current UTC month.
  const now = new Date()
  let year: number
  let monthIdx: number // 0-based
  if (month) {
    const [y, m] = month.split('-').map(Number) as [number, number]
    year = y
    monthIdx = m - 1
  } else {
    year = now.getUTCFullYear()
    monthIdx = now.getUTCMonth()
  }
  const monthStart = new Date(Date.UTC(year, monthIdx, 1))
  const nextMonthStart = new Date(Date.UTC(year, monthIdx + 1, 1))
  const targetMonthKey = `${year}-${String(monthIdx + 1).padStart(2, '0')}`

  // ── 1. All active (non-archived) income-bearing projects, with owners ──────
  // One pass: a project contributes to its SENIOR owner (always) AND to its
  // DROP owner (when dropId is set). The owner's role decides the income type
  // we look for (SENIOR_INCOME vs ADMIN_INCOME vs DROP_INCOME).
  // task-project-draft-status: sourced from `visibleProjects` — a DRAFT or
  // REJECTED project cannot have declared income yet (Д2 refuses
  // transaction creation on either), so including it here would only ever
  // show a false "hasn't submitted income" flag. Views are not registered
  // in Drizzle's relational-query schema config (same reason as the
  // `ownProjects` read above), so `db.query.projects.findMany` is replaced
  // with an explicit select.
  const activeProjects = await db.db
    .select({
      id: visibleProjects.id,
      name: visibleProjects.name,
      companyName: visibleProjects.companyName,
      seniorId: visibleProjects.seniorId,
      dropId: visibleProjects.dropId,
    })
    .from(visibleProjects)

  if (activeProjects.length === 0) {
    return {
      month: targetMonthKey,
      totals: {
        expectedProjects: 0,
        submittedProjects: 0,
        laggingReceivers: 0,
        completeReceivers: 0,
        pendingProjects: 0,
        accruedProjects: 0,
      },
      receivers: [],
    }
  }

  // ── 2. Resolve the role of every owner referenced by an active project ─────
  const ownerIds = Array.from(
    new Set(
      activeProjects.flatMap((p) => [p.seniorId, p.dropId].filter((id): id is string => !!id)),
    ),
  )
  const ownerRows = await db.db.query.users.findMany({
    where: inArray(users.id, ownerIds),
    columns: { id: true, displayName: true, role: true },
  })
  // Keyed `string | null` so a null owner id (project without a drop) is a plain
  // miss in `addPair` — no separate guard needed.
  const ownerById = new Map<string | null, (typeof ownerRows)[number]>(
    ownerRows.map((u) => [u.id, u]),
  )

  // ── 3. Evidence rows for the month, per (projectId, type[, receiverId]) ────
  // A single aggregating pass over every type of row that can constitute
  // evidence a receiver's income was accounted for. Three kinds, per
  // task-compliance-overview-pending-types:
  //   - self-declared income (SENIOR_INCOME / ADMIN_INCOME / DROP_INCOME):
  //     VALIDATED|PAID → received; PENDING → pendingValidation (awaiting the
  //     accountant). PENDING_PAYMENT is ALSO reachable here — see the
  //     type-aware classification below, NOT a generic one.
  //   - a company-booked OBLIGATION not yet paid (SENIOR_PENDING_PAYOUT /
  //     DROP_PENDING_PAYOUT, status PENDING_PAYMENT) → accrued (awaiting the
  //     COMPANY's payout — nothing for the receiver to do).
  //   - a SETTLED drop obligation (PAYOUT_DROP, status PAID) → received. A
  //     settled SENIOR obligation needs NO extra type here — `settleByCompany`
  //     flips it in place to SENIOR_INCOME/PAID, already covered above.
  // The dataset is tiny (units of projects) so JS grouping is cheap and keeps
  // the existing service-spec mock surface (query.transactions.findMany) intact.
  const projectIds = activeProjects.map((p) => p.id)
  const incomeRows = await db.db.query.transactions.findMany({
    where: and(
      inArray(transactions.type, [
        'SENIOR_INCOME',
        'ADMIN_INCOME',
        'DROP_INCOME',
        'SENIOR_PENDING_PAYOUT',
        'DROP_PENDING_PAYOUT',
        'PAYOUT_DROP',
      ]),
      inArray(transactions.status, ['VALIDATED', 'PAID', 'PENDING', 'PENDING_PAYMENT']),
      inArray(transactions.projectId, projectIds),
      // task-soft-delete-and-money-audit (AC4): a deleted (e.g. fraudulent)
      // income must not count toward a project's «сдал приход в этом месяце»
      // compliance badge.
      isNull(transactions.deletedAt),
    ),
    columns: {
      type: true,
      status: true,
      projectId: true,
      // security-review PR #531 (MED-1): the three obligation-model types
      // below need `receiverId` for keying — see `RECEIVER_SCOPED_TYPES`.
      receiverId: true,
      txDate: true,
      createdAt: true,
    },
  })

  // security-review PR #531 (MED-1). `bookCompanyObligations` documents
  // `receiverId` as a hard invariant on every SENIOR_PENDING_PAYOUT /
  // DROP_PENDING_PAYOUT / PAYOUT_DROP row (always the actual person the
  // company owes/paid), and every OTHER consumer of these rows keys by it
  // (`computeDropAggregate`, `balance.service.ts:327`). This widget must
  // too: without it, the evidence key is `${projectId}|${type}` ALONE, so
  // reassigning a project's `dropId` mid-month makes the NEW drop silently
  // inherit the OLD drop's obligation evidence — a person who was never
  // paid would render compliant. Self-declare types (SENIOR_INCOME /
  // ADMIN_INCOME / DROP_INCOME) are deliberately NOT in this set — their
  // existing project-level (not receiver-level) semantics predate this task
  // and are unchanged (e.g. an admin-as-senior's ADMIN_INCOME can legally be
  // routed to a different admin's receiverId — COMPANY_ACCOUNT pooling in
  // `declareUsdtProjectIncome` — without that being non-compliance).
  const RECEIVER_SCOPED_TYPES = new Set([
    'SENIOR_PENDING_PAYOUT',
    'DROP_PENDING_PAYOUT',
    'PAYOUT_DROP',
  ])
  // The subset of RECEIVER_SCOPED_TYPES whose PENDING_PAYMENT status means
  // "booked, unpaid obligation" (accrued) — see the type-aware status
  // classification below (MED-2).
  const OBLIGATION_TYPES = new Set(['SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT'])
  const evidenceKey = (
    projectId: string | null,
    type: string,
    receiverId: string | null,
  ): string =>
    RECEIVER_SCOPED_TYPES.has(type) ? `${projectId}|${type}|${receiverId}` : `${projectId}|${type}`

  // key = evidenceKey(...) → per-state flags for the target month.
  const incomeByKey = new Map<
    string,
    { received: boolean; pendingValidation: boolean; accrued: boolean }
  >()
  for (const tx of incomeRows) {
    // A null-project row is keyed `null|TYPE`; every lookup below uses a real
    // project id, so the stray entry is never read.
    const when = tx.txDate ?? tx.createdAt
    if (!when) continue
    const whenDate = new Date(when)
    if (whenDate < monthStart || whenDate >= nextMonthStart) continue
    const key = evidenceKey(tx.projectId, tx.type, tx.receiverId)
    // Stryker disable next-line ObjectLiteral: a PROVABLY equivalent mutant, not an untested one — every field on this fallback is IMMEDIATELY either read as falsy (identical to `{}`'s `undefined`, since every read below is a truthy check: `if (entry.received)`) or overwritten by one of the three branches directly below, so `{}` and `{received:false,pendingValidation:false,accrued:false}` are indistinguishable to any observer of this function's output — see income-compliance.unit.spec.ts's DB-level type/status scope suite for the mutants on THIS line's neighbours that ARE observable.
    const entry = incomeByKey.get(key) ?? {
      received: false,
      pendingValidation: false,
      accrued: false,
    }
    if (tx.status === 'VALIDATED' || tx.status === 'PAID') entry.received = true
    else if (tx.status === 'PENDING') entry.pendingValidation = true
    else if (tx.status === 'PENDING_PAYMENT') {
      // security-review PR #531 (MED-2): PENDING_PAYMENT is NOT exclusive to
      // a booked-unpaid obligation. `createPayoutRequest`
      // (transactions.service.ts, ~L3941-3944) ALSO flips an already-
      // VALIDATED self-declare SENIOR_INCOME/DROP_INCOME row to
      // PENDING_PAYMENT for the entire payout-request window (until
      // `payPayoutRequest` flips it PAID). That income was already earned
      // and validated — it is `received`, not a company debt the receiver
      // is waiting on; labelling it "Начислено · ожидает выплаты" would
      // misattribute the wait to the wrong party (the payout mechanics, not
      // an ADMIN-booked IOU). Only the two TRUE obligation types — booked by
      // `bookCompanyObligations`, which never emits a VALIDATED status —
      // mean `accrued`.
      if (OBLIGATION_TYPES.has(tx.type)) entry.accrued = true
      else entry.received = true
    }
    incomeByKey.set(key, entry)
  }

  // Every transaction type that can constitute evidence for a given owner
  // role, in priority order (received > accrued > pendingValidation — see the
  // step-5 reduction below), plus the compliance role it is reported under.
  // ADMIN never gets an obligation type: `bookCompanyObligations` explicitly
  // skips an ADMIN owner (admin income is always direct, never proxied through
  // a company IOU). Roles absent from the map (JUNIOR, ...) are non-receivers.
  const receiverConfigByRole = new Map<
    string,
    { complianceRole: IncomeComplianceRole; incomeTypes: readonly string[] }
  >([
    [
      'SENIOR',
      { complianceRole: 'SENIOR', incomeTypes: ['SENIOR_INCOME', 'SENIOR_PENDING_PAYOUT'] },
    ],
    ['ADMIN', { complianceRole: 'ADMIN_SENIOR', incomeTypes: ['ADMIN_INCOME'] }],
    [
      'DROP',
      {
        complianceRole: 'DROP',
        incomeTypes: ['DROP_INCOME', 'DROP_PENDING_PAYOUT', 'PAYOUT_DROP'],
      },
    ],
  ])

  // ── 4. Group projects by receiver (owner). A project belongs to its SENIOR
  // owner (via seniorId, role SENIOR or ADMIN) AND, if dropId set, to the DROP
  // owner. Each (receiver, project) pair is evaluated against every one of the
  // receiver's own income evidence types. ────────────────────────────────────
  type Acc = {
    userId: string
    displayName: string
    role: IncomeComplianceRole
    incomeTypes: readonly string[]
    projects: Array<{ projectId: string; name: string; companyName: string }>
  }
  const byReceiver = new Map<string, Acc>()
  const addPair = (ownerId: string | null, p: (typeof activeProjects)[number]): void => {
    const owner = ownerById.get(ownerId)
    if (!owner) return
    const config = receiverConfigByRole.get(owner.role)
    if (!config) return // ignore non-receiver roles defensively
    let acc = byReceiver.get(owner.id)
    if (!acc) {
      acc = {
        userId: owner.id,
        displayName: owner.displayName,
        role: config.complianceRole,
        incomeTypes: config.incomeTypes,
        projects: [],
      }
      byReceiver.set(owner.id, acc)
    }
    acc.projects.push({ projectId: p.id, name: p.name, companyName: p.companyName })
  }
  for (const p of activeProjects) {
    addPair(p.seniorId, p)
    addPair(p.dropId, p) // a null drop id is a plain owner-map miss -> no-op
  }

  // ── 5. Build the receiver DTOs + company totals ────────────────────────────
  let expectedProjects = 0
  let submittedProjects = 0
  let laggingReceivers = 0
  let completeReceivers = 0
  let pendingProjects = 0
  let accruedProjects = 0

  const receivers: IncomeComplianceReceiverDto[] = []
  for (const acc of byReceiver.values()) {
    const missingProjects: IncomeComplianceReceiverDto['missingProjects'] = []
    let submitted = 0
    let pendingCount = 0
    let accruedCount = 0
    for (const proj of acc.projects) {
      // Merge evidence across every type this receiver can carry (e.g. a
      // DROP checks DROP_INCOME AND DROP_PENDING_PAYOUT AND PAYOUT_DROP for
      // the SAME project) — `received` wins over `accrued` wins over
      // `pendingValidation`: real, confirmed money outranks an unpaid
      // obligation, which in turn outranks a merely self-declared, unverified
      // claim.
      let received = false
      let pendingValidation = false
      let accrued = false
      for (const type of acc.incomeTypes) {
        // security-review PR #531 (MED-1): looked up with the SAME
        // receiver-aware key the aggregation pass wrote — see `evidenceKey`
        // above. `acc.userId` is the CURRENT owner of `proj` (this receiver),
        // so a stale row left behind by a PREVIOUS owner (project
        // reassignment) never matches here.
        const entry = incomeByKey.get(evidenceKey(proj.projectId, type, acc.userId))
        if (!entry) continue
        if (entry.received) received = true
        if (entry.pendingValidation) pendingValidation = true
        if (entry.accrued) accrued = true
      }
      if (received) {
        submitted += 1
      } else if (accrued) {
        accruedCount += 1
        missingProjects.push({
          projectId: proj.projectId,
          name: proj.name,
          companyName: proj.companyName,
          submitted: false,
          pendingValidation: false,
          accrued: true,
        })
      } else {
        const pendingOnly = pendingValidation
        if (pendingOnly) pendingCount += 1
        missingProjects.push({
          projectId: proj.projectId,
          name: proj.name,
          companyName: proj.companyName,
          submitted: false,
          pendingValidation: pendingOnly,
          accrued: false,
        })
      }
    }
    const expected = acc.projects.length
    expectedProjects += expected
    submittedProjects += submitted
    pendingProjects += pendingCount
    accruedProjects += accruedCount
    if (submitted >= expected) completeReceivers += 1
    else laggingReceivers += 1

    receivers.push({
      userId: acc.userId,
      displayName: acc.displayName,
      role: acc.role,
      expected,
      submitted,
      pendingCount,
      accruedCount,
      missingProjects,
    })
  }

  // Sort laggards-first: lowest coverage ratio on top; ties → fewer submitted
  // first, then displayName for stable ordering.
  receivers.sort((a, b) => {
    // Every receiver is created by addPair with >= 1 project, so expected >= 1.
    const ra = a.submitted / a.expected
    const rb = b.submitted / b.expected
    if (ra !== rb) return ra - rb
    if (a.submitted !== b.submitted) return a.submitted - b.submitted
    return a.displayName.localeCompare(b.displayName, 'en')
  })

  return {
    month: targetMonthKey,
    totals: {
      expectedProjects,
      submittedProjects,
      laggingReceivers,
      completeReceivers,
      pendingProjects,
      accruedProjects,
    },
    receivers,
  }
}
