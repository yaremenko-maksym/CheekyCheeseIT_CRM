import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import type {
  Approval,
  ApproveApprovalInput,
  ApprovalGroupStatus,
  ProposeApprovalInput,
  RejectApprovalInput,
} from '@crm/shared'
import {
  approvalSchema,
  approveApprovalInputSchema,
  proposeApprovalInputSchema,
  rejectApprovalInputSchema,
} from '@crm/shared'
import { NOTIFICATION_TITLES, notificationTextPreview } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { approvals, projects, users } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { NotificationsService } from '../notifications/notifications.service'
import { approvalNotificationKind, approvalNotificationSubject } from './approval-notification'

type ApprovalRow = typeof approvals.$inferSelect

/**
 * Foundation for "actions touching an employee's money or responsibility do
 * not take effect until they agree in the CRM" — task 3 of
 * docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md.
 *
 * Deliberately subject-agnostic: this service knows nothing about projects or
 * shares (positions 4/5 of that plan wire those in, calling this service —
 * they do not belong here). It also has no RBAC of its own — "who is allowed
 * to propose / respond for a given subject" is a decision each subject's own
 * module makes before calling in; this service trusts the ids it is given
 * (in particular, a caller MUST derive `approverUserId` for approve()/reject()
 * from the authenticated session, never from client-supplied input, or an
 * approver could answer on someone else's behalf).
 *
 * The one shape — "one proposal = one row per approver" — is what makes the
 * owner's three requirements fall out for free instead of needing separate
 * machinery each (see the schema.ts header comment above the `approvals`
 * table for the full reasoning):
 *   - partial agreement:      read the live rows, some APPROVED, some PENDING
 *   - one rejection voids all: reject() supersedes every other live sibling
 *   - re-propose keeps history: propose() supersedes, never rewrites
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly db: DatabaseService,
    // task-notification-types-producers (позиция 6). Производитель двух типов
    // «админу»: «сотрудник подтвердил» и «сотрудник отклонил, с причиной».
    // Почему шов здесь, а не в шести вызывающих местах — см.
    // `approval-notification.ts`.
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Opens a new proposal for a subject: one PENDING row per approver.
   *
   * Any still-live rows from a previous generation (whatever their status)
   * are superseded first, in the SAME transaction, before the new rows are
   * inserted — a subject never has two live generations at once, and the old
   * generation's rows are never rewritten, only extinguished.
   */
  async propose(rawInput: ProposeApprovalInput): Promise<Approval[]> {
    return this.db.db.transaction((tx) => this.proposeInTx(tx, rawInput))
  }

  /**
   * task-project-draft-status. Same logic as `propose()`, but running INSIDE
   * a transaction the CALLER already opened — for a subject module (e.g.
   * `ProjectsService.create`) that must insert its own row and open the
   * proposal as ONE atomic unit ("Строки согласования создаются в той же
   * транзакции, что и черновик" — design spec §Д1). `propose()` above is now
   * a thin wrapper that opens its own transaction and delegates here, so the
   * two entry points can never drift apart.
   */
  async proposeInTx(tx: DrizzleTx, rawInput: ProposeApprovalInput): Promise<Approval[]> {
    const input = proposeApprovalInputSchema.parse(rawInput)
    const now = new Date()

    await this.supersedeLiveRows(tx, input.subjectType, input.subjectId, now)

    const rows = await tx
      .insert(approvals)
      .values(
        input.approverUserIds.map((approverUserId) => ({
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          approverUserId,
          proposedByUserId: input.proposedByUserId,
          status: 'PENDING' as const,
          createdAt: now,
        })),
      )
      .returning()

    return rows.map(toApproval)
  }

  /**
   * The named approver agrees. Only their own row transitions — a sibling
   * still PENDING is untouched (this is what makes partial agreement visible
   * with no extra field: query the live rows and see one APPROVED, one not).
   */
  async approve(rawInput: ApproveApprovalInput): Promise<Approval> {
    return this.db.db.transaction((tx) => this.approveInTx(tx, rawInput))
  }

  /**
   * task-project-draft-status. Same logic as `approve()`, running inside a
   * transaction the CALLER already opened — for a subject module that must
   * also write its own denormalised status (e.g. `projects.status` flipping
   * to `ACTIVE` once every approver has confirmed) atomically with this row
   * transition, so the two can never observably disagree.
   */
  async approveInTx(tx: DrizzleTx, rawInput: ApproveApprovalInput): Promise<Approval> {
    const input = approveApprovalInputSchema.parse(rawInput)
    const now = new Date()

    const row = await this.loadLiveRowForUpdate(tx, input)
    this.assertRespondable(row)

    const [updated] = await tx
      .update(approvals)
      .set({ status: 'APPROVED', decidedAt: now })
      .where(eq(approvals.id, row.id))
      .returning()
    if (!updated) throw new Error('Failed to record approval')

    // Позиция 6: в ТОЙ ЖЕ транзакции, что и само решение — уведомление о
    // несостоявшемся согласии структурно невозможно.
    // SR-H-2 (security-review круг 2): путь производителя целиком — во
    // ВЛОЖЕННОЙ транзакции (SAVEPOINT). Событие уже состоялось; уронить его
    // из-за того, что уведомление о нём не собралось, — ровно то вето, которое
    // круг 2 запретил. Откат события по-прежнему уносит и запись: savepoint
    // вложен в транзакцию события, а не заменяет её.
    await this.notifications.emitInTx(tx, async (sp) => {
      await this.notifyDecision(sp, updated, null)
    })

    return toApproval(updated)
  }

  /**
   * The named approver refuses, with a mandatory reason (enforced by the Zod
   * DTO AND the DB check constraint — this is a shared registry other
   * modules reach directly, so the DB is the backstop, not just this path).
   *
   * Decision #5, "отказ одного гасит предложение целиком": every other still
   * live row for the same subject — PENDING or already APPROVED — is
   * superseded in the SAME transaction. The rejected row itself is left
   * alone (supersededAt stays NULL): it IS the terminal state of this
   * generation, which is why `getStatus()` reads "any live REJECTED row" as
   * the whole subject being rejected regardless of what else was approved
   * before this call.
   *
   * CR-H-1 (code-review, PR #624): this used to lock the caller's OWN row
   * first (a single-row `SELECT … approverUserId = $me FOR UPDATE`) and only
   * THEN cascade-lock every sibling via the `UPDATE … WHERE id <> $me`
   * below. Two approvers of the SAME subject calling reject() at the same
   * time each locked their own row first and then asked for the other's — an
   * ABBA lock-order inversion, reproduced by the reviewer as a real Postgres
   * deadlock (40P01) on a scratch DB. Same class, same fix shape as
   * `transactions.service.ts`'s `lockCascadeRows` (closed there via
   * PR #598, MED-2): take every lock this call could possibly need in ONE
   * statement, in a deterministic order, before writing to any of them —
   * `lockLiveRows` below (`ORDER BY id FOR UPDATE`). Two concurrent
   * reject()/propose() calls on the same subject then acquire locks in the
   * SAME order regardless of which approver called first, so a lock-order
   * cycle is structurally impossible rather than merely unlikely.
   */
  async reject(rawInput: RejectApprovalInput): Promise<Approval> {
    return this.db.db.transaction((tx) => this.rejectInTx(tx, rawInput))
  }

  /**
   * task-project-draft-status. Same logic as `reject()`, running inside a
   * transaction the caller already opened — see `approveInTx`'s doc for why.
   */
  async rejectInTx(tx: DrizzleTx, rawInput: RejectApprovalInput): Promise<Approval> {
    const input = rejectApprovalInputSchema.parse(rawInput)
    const now = new Date()

    const liveRows = await this.lockLiveRows(tx, input.subjectType, input.subjectId)
    const row = liveRows.find((r) => r.approverUserId === input.approverUserId) ?? null
    this.assertRespondable(row)

    const [updated] = await tx
      .update(approvals)
      .set({ status: 'REJECTED', rejectionReason: input.reason, decidedAt: now })
      .where(eq(approvals.id, row.id))
      .returning()
    if (!updated) throw new Error('Failed to record rejection')

    await tx
      .update(approvals)
      .set({ supersededAt: now })
      .where(
        and(
          eq(approvals.subjectType, input.subjectType),
          eq(approvals.subjectId, input.subjectId),
          isNull(approvals.supersededAt),
          ne(approvals.id, updated.id),
        ),
      )

    // Позиция 6: причина отказа — ровно то, ради чего этот тип и заведён.
    await this.notifications.emitInTx(tx, async (sp) => {
      await this.notifyDecision(sp, updated, input.reason)
    })

    return toApproval(updated)
  }

  /**
   * «Сотрудник подтвердил» / «сотрудник отклонил, с причиной» — автору
   * предложения. Один шов на оба решения и на все виды объектов.
   *
   * Кому НЕ уходит: самому решившему, когда он же и предложил (своё действие
   * подтверждает тост, §8.1), и никому при виде объекта, которого этот файл не
   * умеет назвать (`approvalNotificationKind` вернул `null`) — сообщить
   * администратору про «объект неизвестного вида» хуже, чем промолчать.
   */
  private async notifyDecision(
    tx: DrizzleTx,
    row: ApprovalRow,
    rejectionReason: string | null,
  ): Promise<void> {
    const kind = approvalNotificationKind(row.subjectType)
    if (kind === null) return
    if (row.proposedByUserId === row.approverUserId) return

    const { subjectType, needsProjectName } = approvalNotificationSubject(kind)

    const [approver] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.approverUserId))
      .limit(1)

    let subjectTitle: string | null = null
    if (needsProjectName) {
      // QA-M-4 (manual-qa круг 3, #664): `companyName`, а НЕ `projects.name` —
      // шестое и последнее место, кладущее имя проекта в уведомление; круг 7
      // (ORCH-3) прошёл мимо него. Цена расхождения видна в одном попапе:
      // администратор читал «Марта Дрозд — проект QA R3 Draft Project» рядом с
      // «Проект QA R3 Client Co» — два имени одного проекта в соседних
      // строках. Попап называет проект тем же словом, что и экран «Ждут
      // решения» (#667) и список проектов (`ProjectRow.tsx`, где `name` —
      // мелкая вторая строка).
      const [project] = await tx
        .select({ companyName: projects.companyName })
        .from(projects)
        .where(eq(projects.id, row.subjectId))
        .limit(1)
      subjectTitle = project?.companyName ?? null
    }

    // Имя снимается В МОМЕНТ решения: уведомление живёт дольше объекта (§7.4),
    // и строка о том, кто что решил, не должна становиться безымянной.
    const approverName = approver?.displayName ?? 'Сотрудник'

    if (rejectionReason === null) {
      await this.notifications.createInTx(tx, {
        userId: row.proposedByUserId,
        type: 'APPROVAL_CONFIRMED',
        title: NOTIFICATION_TITLES.APPROVAL_CONFIRMED,
        subjectType,
        subjectId: row.subjectId,
        secondaryId: row.approverUserId,
        data: { approverName, subjectKind: kind, subjectTitle },
      })
      return
    }

    // SR-H-1 (круг 1): в уведомление едет ПРЕВЬЮ причины, а не причина
    // целиком. Две причины, обе из §10. Первая — раскрытие: эта же строка
    // уходит письмом на личную почту вне нашего контура, а полный текст
    // читают в CRM, где работают права. Вторая — длина текста, написанного
    // человеком, перестаёт быть связана с судьбой уведомления: превью
    // ограничено по построению, а не надеждой на потолок входной схемы.
    // Пустым превью здесь быть не может: `rejectApprovalInputSchema` требует
    // непустую после `trim()` причину (1..500), и через `rejectInTx` иначе не
    // пройти. Поэтому `null` отсюда не уезжает — хотя форма его допускает
    // (см. `reasonPreview` в реестре: там нулевое значение заведено для
    // читателя, а не для этого производителя).
    const preview = notificationTextPreview(rejectionReason)
    await this.notifications.createInTx(tx, {
      userId: row.proposedByUserId,
      type: 'APPROVAL_REJECTED',
      title: NOTIFICATION_TITLES.APPROVAL_REJECTED,
      subjectType,
      subjectId: row.subjectId,
      secondaryId: row.approverUserId,
      data: { approverName, subjectKind: kind, subjectTitle, reasonPreview: preview },
    })
  }

  /**
   * task-648-fix-round-1 (SR-H-1). The proposal's OWNER (whoever is allowed
   * to propose for this subject — an ADMIN, not the approver) withdraws an
   * open proposal outright, before the approver has answered it. Distinct
   * from `rejectInTx` in every dimension that matters for an audit trail:
   * WHO acts (the proposer's side, not the invited approver), WHETHER a
   * reason exists (none — withdrawing your own mistake needs no
   * justification to anyone), and the resulting row STATUS (`CANCELLED`,
   * never `REJECTED` — so history never misattributes an admin's own
   * withdrawal to the approver declining).
   *
   * Only rows still `PENDING` are cancelled — a row that already transitioned
   * to `APPROVED` (the swap already ran, in the SAME transaction as
   * `approveInTx`) is a real, live decision, not an open ask, and cancelling
   * it after the fact would misrepresent history as if the value change had
   * never happened when it demonstrably did. For every subject this PR
   * wires (`PROJECT_SENIOR_SHARE`, `USER_SENIOR_SHARE` — exactly one
   * approver each), this distinction only matters in the race between an
   * admin's cancel and the senior's approve; for a hypothetical
   * multi-approver subject it also means a PARTIALLY-approved generation
   * cannot be cancelled out from under the approver who already said yes.
   *
   * Same 404 shape as approve()/reject() when there is nothing open to
   * cancel — "already resolved" is not a caller error to silently swallow.
   */
  async cancel(subjectType: string, subjectId: string): Promise<void> {
    return this.db.db.transaction((tx) => this.cancelInTx(tx, subjectType, subjectId))
  }

  /**
   * task-648-fix-round-1 (SR-H-1). Same logic as `cancel()`, running inside
   * a transaction the caller already opened — this is the PRIMARY entry
   * point in practice, and since round 2 the ONLY one: the two cancel
   * endpoints (`ProjectsService.cancelSeniorShareChange` /
   * `UsersService.cancelSeniorShareChange`) need the cancel to be atomic
   * with their own writes — clearing the pending column and inserting the
   * audit row that names who withdrew it.
   *
   * task-648-fix-round-2 (SR-M-7): this doc used to also name a
   * "revert-the-slider no-op branch" as a caller. That branch was removed in
   * round 2 (SR-H-2) — cancelling is explicit only. Corrected here rather
   * than left to describe a caller that no longer exists.
   */
  async cancelInTx(tx: DrizzleTx, subjectType: string, subjectId: string): Promise<void> {
    const now = new Date()
    const liveRows = await this.lockLiveRows(tx, subjectType, subjectId)
    const pendingRows = liveRows.filter((r) => r.status === 'PENDING')
    if (pendingRows.length === 0) {
      // task-648-fix-round-1 (COPY-H-4): "подтверждение" is the ONE
      // user-facing name for this concept across the whole feature — never
      // "согласование" (internal/comment vocabulary only) or "погашено"
      // (jargon a caller cannot act on). Same wording as `assertRespondable`
      // below, for the same reason.
      throw new NotFoundException('Подтверждение не найдено или уже закрыто')
    }

    await tx
      .update(approvals)
      .set({ status: 'CANCELLED', decidedAt: now, supersededAt: now })
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          eq(approvals.subjectId, subjectId),
          eq(approvals.status, 'PENDING'),
          isNull(approvals.supersededAt),
        ),
      )
  }

  /**
   * The current generation's rows for a subject — a quenched (superseded)
   * row never appears here, whatever its `status` says (§4.1: "погашенная
   * строка не участвует в подсчёте"). Ordered by proposal order.
   *
   * task-project-draft-status: `db` defaults to the plain pool handle but
   * accepts a caller-supplied `tx` — this is what lets `getStatusInTx` (and
   * therefore a subject module writing its own denormalised status) read the
   * POST-write aggregate inside the SAME transaction as the row change,
   * without duplicating this query.
   */
  async listLive(
    subjectType: string,
    subjectId: string,
    db: DatabaseService['db'] | DrizzleTx = this.db.db,
  ): Promise<Approval[]> {
    const rows = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          eq(approvals.subjectId, subjectId),
          isNull(approvals.supersededAt),
        ),
      )
      .orderBy(asc(approvals.createdAt))
    return rows.map(toApproval)
  }

  /**
   * Aggregate read of the subject's current generation. See
   * `ApprovalGroupStatus` (packages/shared/src/schemas/approvals.ts) for the
   * four values and what each means.
   */
  async getStatus(subjectType: string, subjectId: string): Promise<ApprovalGroupStatus> {
    const live = await this.listLive(subjectType, subjectId)
    return aggregateStatus(live)
  }

  /**
   * task-project-draft-status. Same aggregate as `getStatus()`, reading
   * through a caller-supplied `tx` — see `listLive`'s doc for why.
   */
  async getStatusInTx(
    tx: DrizzleTx,
    subjectType: string,
    subjectId: string,
  ): Promise<ApprovalGroupStatus> {
    const live = await this.listLive(subjectType, subjectId, tx)
    return aggregateStatus(live)
  }

  /**
   * Everything currently awaiting a response from one approver, across every
   * subject — the query behind "Экран «что от меня ждут»" (position 7 of the
   * plan; not built here).
   */
  async listPendingForApprover(approverUserId: string): Promise<Approval[]> {
    const rows = await this.db.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.approverUserId, approverUserId),
          eq(approvals.status, 'PENDING'),
          isNull(approvals.supersededAt),
        ),
      )
      .orderBy(asc(approvals.createdAt))
    return rows.map(toApproval)
  }

  /**
   * task-project-draft-status. Was `userId` EVER asked to approve this
   * subject — across every generation, not just the current live one. Used
   * by a subject module's own visibility gate (e.g. "can this SENIOR see
   * their still-DRAFT project") where the invited set does not change
   * between re-proposals (the project's senior/drop are fixed people, so a
   * re-proposal re-asks the SAME approvers) — see `ProjectsService`'s own
   * narrow-path comment for why "ever asked" is the correct and sufficient
   * check there, not just "asked in the CURRENT generation": a rejected
   * generation's rows are quenched for everyone except the rejecter (decision
   * #5, "отказ одного гасит предложение целиком"), so `listLive` alone
   * cannot answer "who was asked" once one of them has already answered no.
   */
  async isApprover(subjectType: string, subjectId: string, userId: string): Promise<boolean> {
    const rows = await this.db.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          eq(approvals.subjectId, subjectId),
          eq(approvals.approverUserId, userId),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  /**
   * Bulk form of `isApprover` — every subject id (of `subjectType`) `userId`
   * was EVER asked to approve, in one query. Used when a subject module
   * filters a LIST of its own rows for visibility (e.g.
   * `ProjectsService.findAll`) — one round-trip instead of one `isApprover`
   * call per row.
   */
  async listSubjectIdsForApprover(subjectType: string, userId: string): Promise<Set<string>> {
    const rows = await this.db.db
      .selectDistinct({ subjectId: approvals.subjectId })
      .from(approvals)
      .where(and(eq(approvals.subjectType, subjectType), eq(approvals.approverUserId, userId)))
    return new Set(rows.map((r) => r.subjectId))
  }

  /**
   * task-project-status-filter-ui. Batched read of "why was this subject's
   * live generation declined" — the reason on the one live REJECTED row per
   * subject (decision #5, "отказ одного гасит предложение целиком": every
   * sibling was superseded in the SAME transaction as the reject, see
   * `rejectInTx`'s own comment, so exactly one live row can be REJECTED).
   *
   * Used by a subject module's LIST/DETAIL read (e.g.
   * `ProjectsService.findAll`/`findOne`) to show the reason without a
   * per-row query. Callers pass ONLY ids they already know are REJECTED
   * (e.g. `project.status === 'REJECTED'`) — an id that is not, or whose
   * rejecting generation has since been superseded by a re-proposal, simply
   * has no entry in the returned map. `subjectIds: []` short-circuits
   * before touching the DB — the caller's own gate (only call this when
   * there is at least one REJECTED id) stays a no-op, not a query, for the
   * common case where nothing in the batch was ever rejected.
   */
  async getRejectionReasons(
    subjectType: string,
    subjectIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (subjectIds.length === 0) return map
    const rows = await this.db.db
      .select({ subjectId: approvals.subjectId, rejectionReason: approvals.rejectionReason })
      .from(approvals)
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          inArray(approvals.subjectId, subjectIds),
          eq(approvals.status, 'REJECTED'),
          isNull(approvals.supersededAt),
        ),
      )
    for (const row of rows) {
      if (row.rejectionReason) map.set(row.subjectId, row.rejectionReason)
    }
    return map
  }

  /**
   * SPEC-M-2 (PR #646 fix-round 1). Batched read of "which approver(s) still
   * owe a decision" — every live PENDING row's `approverUserId`, grouped by
   * subject. Same batching contract as `getRejectionReasons`: callers pass
   * only ids already known to be in a live-decision state (project
   * `status === 'DRAFT'`), empty input short-circuits before touching the
   * DB. An id with no live PENDING row at all (every approver has decided,
   * or the subject was never proposed) simply has no entry in the returned
   * map — callers read that as "nobody left pending" (empty set), same as a
   * present-but-empty `Set`.
   */
  async getPendingApproverIds(
    subjectType: string,
    subjectIds: string[],
  ): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>()
    if (subjectIds.length === 0) return map
    const rows = await this.db.db
      .select({ subjectId: approvals.subjectId, approverUserId: approvals.approverUserId })
      .from(approvals)
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          inArray(approvals.subjectId, subjectIds),
          eq(approvals.status, 'PENDING'),
          isNull(approvals.supersededAt),
        ),
      )
    for (const row of rows) {
      const set = map.get(row.subjectId) ?? new Set<string>()
      set.add(row.approverUserId)
      map.set(row.subjectId, set)
    }
    return map
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async supersedeLiveRows(
    tx: DrizzleTx,
    subjectType: string,
    subjectId: string,
    at: Date,
  ): Promise<void> {
    // CR-H-1 (code-review, PR #624): lock every live row for the subject —
    // in the SAME deterministic order `lockLiveRows` uses for reject() —
    // BEFORE writing to any of them. A bare cascading `UPDATE` (the previous
    // shape here) locks rows in whatever order Postgres's own scan happens
    // to visit them, which is not guaranteed to agree with another
    // transaction's acquisition order; the explicit `ORDER BY id FOR UPDATE`
    // below is what makes propose() and reject() take these locks in the
    // SAME order as each other, so they cannot form an ABBA cycle.
    await this.lockLiveRows(tx, subjectType, subjectId)
    await tx
      .update(approvals)
      .set({ supersededAt: at })
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          eq(approvals.subjectId, subjectId),
          isNull(approvals.supersededAt),
        ),
      )
  }

  /**
   * Locks (`FOR UPDATE`, deterministic `ORDER BY id`) and returns EVERY live
   * row for a subject in ONE statement, before any write touches any of
   * them. This is the same ordering discipline `transactions.service.ts`'s
   * `lockCascadeRows` uses (see that method's own comment) — any two
   * concurrent callers that each need more than one row of the SAME subject
   * (reject() vs reject(), reject() vs propose()) acquire those locks in the
   * SAME id order, so a lock-order cycle (ABBA) is structurally impossible
   * rather than merely unlikely to line up in time. `approve()` does not go
   * through here: it only ever needs its OWN single row, and one lock cannot
   * invert against itself — see `loadLiveRowForUpdate` below.
   */
  private async lockLiveRows(
    tx: DrizzleTx,
    subjectType: string,
    subjectId: string,
  ): Promise<ApprovalRow[]> {
    return tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          eq(approvals.subjectId, subjectId),
          isNull(approvals.supersededAt),
        ),
      )
      .orderBy(asc(approvals.id))
      .for('update')
  }

  /**
   * Locks (`FOR UPDATE`) and returns the live row for one (subject, approver)
   * pair, so two concurrent approve() calls on the same row serialise
   * instead of racing. Null if there is no live row — either nobody ever
   * proposed for this (subjectType, subjectId, approverUserId) triple, or it
   * was already superseded (a sibling's rejection, or a re-proposal). Safe
   * to keep as a single-row lock (no `lockLiveRows` ordering needed):
   * approve() never acquires a SECOND lock inside the same transaction, so
   * it cannot participate in a lock-order cycle against reject()/propose()
   * — see the CR-H-1 comment on `reject()` for the case that DOES need one.
   */
  private async loadLiveRowForUpdate(
    tx: DrizzleTx,
    params: { subjectType: string; subjectId: string; approverUserId: string },
  ): Promise<ApprovalRow | null> {
    const rows = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.subjectType, params.subjectType),
          eq(approvals.subjectId, params.subjectId),
          eq(approvals.approverUserId, params.approverUserId),
          isNull(approvals.supersededAt),
        ),
      )
      .for('update')
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * Throws the two ways a response can legitimately fail to apply.
   *
   * task-648-fix-round-1 (COPY-H-4): "подтверждение" throughout — see
   * `cancelInTx`'s identical comment above for the full reasoning.
   */
  private assertRespondable(row: ApprovalRow | null): asserts row is ApprovalRow {
    if (!row) throw new NotFoundException('Подтверждение не найдено или уже закрыто')
    if (row.status !== 'PENDING') throw new ConflictException('Подтверждение уже получило ответ')
  }
}

/** Pure aggregation over a subject's live rows — shared by getStatus/getStatusInTx. */
function aggregateStatus(live: Approval[]): ApprovalGroupStatus {
  if (live.length === 0) return 'NONE'
  if (live.some((row) => row.status === 'REJECTED')) return 'REJECTED'
  if (live.every((row) => row.status === 'APPROVED')) return 'APPROVED'
  return 'PENDING'
}

function toApproval(row: ApprovalRow): Approval {
  return approvalSchema.parse({
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    approverUserId: row.approverUserId,
    status: row.status,
    rejectionReason: row.rejectionReason,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    proposedByUserId: row.proposedByUserId,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  })
}
