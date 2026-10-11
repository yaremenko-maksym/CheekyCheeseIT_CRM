import { HttpStatus, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { NOTIFICATION_TITLES } from '@crm/shared'
import { apiError } from '../common/api-error'
import { ApprovalsService } from '../approvals/approvals.service'
import { DatabaseService } from '../database/database.service'
import { projectFinanceSettings, projects } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { NotificationsService } from '../notifications/notifications.service'
import { PROJECT_SENIOR_SHARE_SUBJECT_TYPE } from './project-access.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { ProjectReadService } from './project-read.service'

// task-pending-share (position 5). Pulled out of `notifyPendingSeniorShareProposed`'s
// own signature so that method fits on one line — see that method's doc
// comment for why (a Stryker disable-comment / multi-line-inline-type
// interaction).
type NotifyPendingShareInput = {
  subjectId: string
  approverUserId: string
  proposedPercent: number | null
  previousPercent: number | null
  /**
   * task-notification-types-producers (позиция 6). Название снимается В МОМЕНТ
   * предложения и передаётся сюда вызывающим, у которого строка проекта уже на
   * руках. Не читается заново: лишний запрос на пути, где данные уже есть, — и
   * уведомление, пережившее проект (§7.4), осталось бы безымянным.
   */
  projectName: string | null
  /**
   * QA-H-1 (manual-qa круг 3, #664): строка `approvals`, которую это
   * уведомление и представляет. Берётся из возврата
   * `ApprovalsService.proposeInTx` — то есть это ИМЕННО та строка, что
   * открылась сейчас, а не «согласование по такому-то объекту вообще».
   * Повторное предложение открывает новое поколение строк, и без этого
   * идентификатора старое уведомление оставалось активным рядом с новым.
   */
  approvalId: string
}

/**
 * Project-level senior-share-override change: propose / approve / reject /
 * cancel, the notification seam and the project_finance_settings mirror
 * write. Extracted verbatim from ProjectsService; read-backs go through
 * ProjectReadService. The approvals-then-project lock order is unchanged.
 */
@Injectable()
export class ProjectShareChangeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsService,
    private readonly read: ProjectReadService,
    private readonly projectAuditLogService: ProjectAuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * `subjectType` for a PROJECT-level senior-share-override change — distinct
   * from the draft-confirmation subject: the same project id can carry a live
   * draft-confirmation proposal AND a live share-change proposal at once.
   */
  private static readonly SENIOR_SHARE_SUBJECT_TYPE = PROJECT_SENIOR_SHARE_SUBJECT_TYPE

  /**
   * «Ждёт решения: новая доля» — тому, чья доля меняется, и никому больше
   * (§7.2 + §7.3). Позиция 5 оставила этот шов пустым и Stryker-подавленным,
   * потому что типа уведомления ещё не существовало; позиция 6 его заполняет —
   * подавление снято, метод стал настоящим и проверяется как всякий другой.
   *
   * Изменились две вещи против прежней подписи, обе намеренно:
   *   - появился `tx` — запись пишется в ТОЙ ЖЕ транзакции, что и само
   *     предложение (см. `proposeSeniorShareChange` ниже);
   *   - метод стал асинхронным.
   * Спека-хендофф (`projects.pending-share.spec.ts`) обновлена под обе.
   */
  private async notifyPendingSeniorShareProposed(
    tx: DrizzleTx,
    input: NotifyPendingShareInput,
  ): Promise<void> {
    // SR-H-2 (security-review круг 2): путь производителя — во вложенной
    // транзакции (SAVEPOINT); подробности у близнеца в `UsersService`.
    await this.notifications.emitInTx(tx, async (sp) => {
      await this.notifications.createInTx(sp, {
        userId: input.approverUserId,
        type: 'SHARE_CONFIRM_REQUIRED',
        title: NOTIFICATION_TITLES.SHARE_CONFIRM_REQUIRED,
        subjectType: 'PROJECT',
        subjectId: input.subjectId,
        // Проценты — ДАННЫЕ, не текст: «26% → 30%» рисует клиент. В письмо
        // (позиция 7) уходит только нейтральный заголовок выше — цифры за
        // пределы нашего контура не идут (§10).
        data: {
          scope: 'PROJECT',
          projectName: input.projectName,
          previousPercent: input.previousPercent,
          proposedPercent: input.proposedPercent,
          approvalId: input.approvalId,
        },
        // Ключа НЕТ намеренно: повторное предложение обязано спросить заново —
        // именно это и означает `supersededAt` на предыдущем поколении строк
        // согласования. Заглушить второе предложение значило бы потерять
        // подтверждение.
      })
    })
  }

  /**
   * task-pending-share (position 5, design spec §4.3). Opens (or re-opens —
   * `ApprovalsService.proposeInTx` supersedes the previous generation on its
   * own) a proposal for a NEW `seniorSharePercentOverride` value. Writes
   * ONLY `pendingSeniorSharePercentOverride` — `update()` never writes the
   * active column directly any more; `approveSeniorShareChange` is what
   * swaps them. `proposedValue` may legitimately be `null` — "propose
   * clearing the override back to the team/user default" is a real proposal
   * (see the column's own schema.ts comment).
   */
  async proposeSeniorShareChange(
    projectId: string,
    approverUserId: string,
    proposedValue: number | null,
    actorId: string,
    // Caller (`update()`) already has this on hand from the row it read
    // before deciding to propose — no need for a second SELECT here.
    previousValue: number | null,
    // То же самое и по той же причине — название проекта для подписи
    // уведомления (позиция 6).
    projectName: string | null,
  ): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      const [approval] = await this.approvals.proposeInTx(tx, {
        subjectType: ProjectShareChangeService.SENIOR_SHARE_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [approverUserId],
        proposedByUserId: actorId,
      })
      // Stryker disable next-line all: defensive-only (и условие, и текст сообщения) — `proposeInTx` вставляет по строке на каждого подтверждающего и возвращает `.returning()`; при непустом `approverUserIds` пустой массив на настоящем Postgres невозможен.
      if (!approval) throw new Error('Failed to open senior-share approval')
      await tx
        .update(projects)
        .set({ pendingSeniorSharePercentOverride: proposedValue, updatedAt: new Date() })
        .where(eq(projects.id, projectId))

      // task-notification-types-producers (позиция 6). Вызов ПЕРЕЕХАЛ внутрь
      // транзакции: позиция 5 оставляла шов пустым и звала его после коммита,
      // потому что звать было нечего. Теперь он пишет строку, и предложение
      // без просьбы подтвердить — как и просьба без предложения — становятся
      // структурно невозможны.
      await this.notifyPendingSeniorShareProposed(tx, {
        subjectId: projectId,
        approverUserId,
        proposedPercent: proposedValue,
        previousPercent: previousValue,
        projectName,
        approvalId: approval.id,
      })
    })
  }

  /**
   * task-pending-share, AC3: the pending → active swap (AND the
   * project_finance_settings mirror sync) happens as ONE operation —
   * `approveInTx` and both writes below run in the SAME transaction, so no
   * caller can ever observe a state where the approval is APPROVED but the
   * active percent (or its mirror) has not moved yet. `impersonatorId` guard
   * mirrors `approveDraft` exactly — consent must come from the invited
   * approver's own session, not an admin impersonating them.
   */
  async approveSeniorShareChange(id: string, currentUser: SessionUser) {
    if (currentUser.impersonatorId) {
      // task-648-fix-round-1 (COPY-H-1): its own Russian string — see
      // `UsersService.approveSeniorShareChange`'s identical comment.
      // task-648-fix-round-2 (COPY-M-13): wording matches
      // `ImpersonationBanner`'s «Вы вошли как …» — see the users-half twin.
      throw apiError('SHARE_APPROVE_IMPERSONATION_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      await this.approvals.approveInTx(tx, {
        subjectType: ProjectShareChangeService.SENIOR_SHARE_SUBJECT_TYPE,
        subjectId: id,
        approverUserId: currentUser.id,
      })
      const [row] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .for('update')
        .limit(1)
      // task-648-fix-round-1 (COPY-H-1): Russian — defensive-only (approveInTx
      // above already proved a live PENDING row exists; only a project
      // deleted in the instant between that check and this re-select could
      // reach here), but still user-facing text if it ever fires.
      if (!row) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      // `row.pendingSeniorSharePercentOverride` is read as-is (including
      // `null`, a legitimate "clear the override" outcome) — safe to trust
      // here because `approveInTx` above already threw for "no live PENDING
      // row for this subject/approver", so reaching this line means a real
      // proposal existed.
      const newOverride = row.pendingSeniorSharePercentOverride
      await tx
        .update(projects)
        .set({
          seniorSharePercentOverride: newOverride,
          pendingSeniorSharePercentOverride: null,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id))
      await this.syncFinanceSettingsOverride(id, newOverride, currentUser.id, tx)
      await this.projectAuditLogService.record(
        {
          actorId: currentUser.id,
          targetId: id,
          action: 'project_edited',
          changes: {
            seniorSharePercentOverride: {
              before: row.seniorSharePercentOverride ?? null,
              after: newOverride,
            },
          },
        },
        tx,
      )
    })
    return this.read.loadForResponse(id, currentUser)
  }

  /**
   * task-pending-share, design spec §3 decision 3: rejection requires a
   * reason (Zod-validated at the controller boundary, DB-enforced as the
   * backstop by `approvals`'s own CHECK constraint) and discards the pending
   * value — the active `seniorSharePercentOverride` is untouched, exactly
   * "При отказе ожидающее отбрасывается, действующее не трогается" (task
   * file, "Что сделать" §1).
   */
  async rejectSeniorShareChange(id: string, reason: string, currentUser: SessionUser) {
    if (currentUser.impersonatorId) {
      // task-648-fix-round-1 (COPY-H-1): same reasoning as approve above.
      throw apiError('SHARE_REJECT_IMPERSONATION_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      await this.approvals.rejectInTx(tx, {
        subjectType: ProjectShareChangeService.SENIOR_SHARE_SUBJECT_TYPE,
        subjectId: id,
        approverUserId: currentUser.id,
        reason,
      })
      await tx
        .update(projects)
        .set({ pendingSeniorSharePercentOverride: null, updatedAt: new Date() })
        .where(eq(projects.id, id))
    })
    return this.read.loadForResponse(id, currentUser)
  }

  /**
   * task-648-fix-round-1 (SR-H-1), revised in round 2 (SR-H-2).
   * ADMIN/ACCOUNTANT withdraws an open proposal for this project's senior
   * share outright — the counterpart to `proposeSeniorShareChange` above.
   * This is the ONLY way to withdraw one: the "Отменить предложение" button
   * next to the pending indicator (and inside the edit dialog) posts here.
   * Round 1 additionally treated "slider returned to the active value" as an
   * implicit cancel; round 2 removed that branch — see `update()`'s own note
   * for why an implicit cancel through a side effect was the wrong shape.
   *
   * RBAC mirrors the PROPOSE gate in `update()` (ADMIN/ACCOUNTANT), not the
   * approve/reject pair above — cancelling a proposal you opened is the
   * proposer's prerogative, never the invited approver's (they get reject()
   * for that, which requires a reason; this doesn't, because withdrawing
   * your own draft answers to nobody).
   *
   * The core/public split this method used to have died with the implicit
   * cancel: with `update()` no longer calling in, there was exactly one
   * caller left and the indirection bought nothing.
   */
  async cancelSeniorShareChange(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      // task-648-fix-round-1 (COPY-H-1): user-facing text is Russian
      // (russian-language.md) — see `UsersService.cancelSeniorShareChange`'s
      // identical comment.
      throw apiError('SHARE_CANCEL_ADMIN_ACCOUNTANT_ONLY', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      // task-648-fix-round-3 (SR-M-8 / CR-H-4): `approvals` FIRST, then the
      // project row — the exact shape `approveSeniorShareChange` above uses,
      // and the order propose/approve/reject on this service have always
      // used. Round 2 wrote this method the other way round, which made it
      // the one path on this half that inverted the pair: an ADMIN
      // withdrawing while the senior confirms could deadlock (`40P01`,
      // surfaced to the admin as a 500), reproduced on a scratch database by
      // the security reviewer. Both properties this ordering used to carry
      // survive the move: `cancelInTx` throws when there is no live
      // proposal, the lock+404 guard below still runs before any write, and
      // `pendingSeniorSharePercentOverride` is untouched by `cancelInTx`, so
      // `row` still holds the pre-cancel value the audit entry reports as
      // `before`. A project deleted in the instant between the two now
      // throws AFTER `cancelInTx` ran — harmless, because the throw aborts
      // this transaction and the withdrawal rolls back with it.
      await this.approvals.cancelInTx(tx, ProjectShareChangeService.SENIOR_SHARE_SUBJECT_TYPE, id)
      const [row] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .for('update')
        .limit(1)
      if (!row) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      // Reaching this line means `cancelInTx` found a real PENDING proposal
      // for `id` (it throws otherwise) — same "no separate existence check
      // needed" reasoning `approveSeniorShareChange` documents above.
      await tx
        .update(projects)
        .set({ pendingSeniorSharePercentOverride: null, updatedAt: new Date() })
        .where(eq(projects.id, id))
      // task-648-fix-round-2 (SR-M-7 / CR-M-2): a withdrawal is an
      // administrative act on a money field and now names its actor, exactly
      // like `approveSeniorShareChange` above already did. Same transaction
      // as the write it describes, so the log can never claim a withdrawal
      // that rolled back. `impersonatorId ?? id` — the REAL operator, the
      // convention every other audit call on this service follows.
      await this.projectAuditLogService.record(
        {
          actorId: currentUser.impersonatorId ?? currentUser.id,
          targetId: id,
          action: 'project_edited',
          changes: {
            pendingSeniorSharePercentOverride: {
              before: row.pendingSeniorSharePercentOverride ?? null,
              after: null,
            },
          },
        },
        tx,
      )
    })
    return this.read.loadForResponse(id, currentUser)
  }

  /**
   * Upsert the projects.senior_share_percent_override mirror into
   * project_finance_settings. Keeps the existing finance path (which reads
   * from financeSettings only) in sync with the new direct column.
   *
   * task-pending-share (position 5): now also called from
   * `approveSeniorShareChange`, which must swap the live column AND this
   * mirror atomically (task AC3 — "одной операцией") — hence the optional
   * `db` parameter (defaults to the plain pool handle, same
   * `DatabaseService['db'] | DrizzleTx` pattern `UsersService.updateUserRow`
   * already uses) so a caller inside a transaction can pass its own `tx`.
   */
  async syncFinanceSettingsOverride(
    projectId: string,
    override: number | null,
    actorId: string,
    db: DatabaseService['db'] | DrizzleTx = this.db.db,
  ) {
    const existing = await db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, projectId),
    })
    if (existing) {
      await db
        .update(projectFinanceSettings)
        .set({
          seniorSharePercentOverride: override,
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(eq(projectFinanceSettings.projectId, projectId))
    } else {
      await db.insert(projectFinanceSettings).values({
        projectId,
        seniorSharePercentOverride: override,
        juniorSalaryOverride: null,
        updatedBy: actorId,
      })
    }
  }
}
