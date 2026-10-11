import { Injectable, Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { NOTIFICATION_TITLES, notificationTextPreview } from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { projects, transactionAuditLog, transactions } from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'
import { NotificationsService } from '../notifications/notifications.service'

/**
 * Post-write lifecycle of TransactionsService: money events → in-app
 * notifications, the creation audit row, and best-effort auto-invoice
 * generation. Collaborator extraction: depends only on NotificationsService,
 * DatabaseService and InvoicesService and NEVER on TransactionsService (no
 * cycle, no forwardRef — invoices/ imports nothing from here). Every method
 * is best-effort: a delivery failure is logged, never rethrown, so a
 * committed money write can't turn into a 500.
 */
@Injectable()
export class TransactionLifecycleService {
  private readonly logger = new Logger(TransactionLifecycleService.name)

  constructor(
    private readonly notifications: NotificationsService,
    private readonly db: DatabaseService,
    private readonly invoices: InvoicesService,
  ) {}

  /**
   * «Транзакция добавлена» — получателю денег и никому больше.
   *
   * Кому НЕ уходит и почему (§10, «уведомления о деньгах — это раскрытие»):
   *   - ОТПРАВИТЕЛЮ. У парных строк раздела (PAYOUT_DROP / PAYOUT_ADMIN)
   *     отправитель — контрагент, и сумма его строки есть доля другой стороны.
   *     «Дроп не видит долю синьора и наоборот» — тот же контур, что
   *     `mapTx(viewer)` (#381–#384).
   *   - САМОМУ АВТОРУ действия. Своё действие подтверждает тост, а не
   *     колокольчик (§8.1); иначе входящее обесценивается.
   *
   * Best-effort, как и аудит рядом: строка денег уже зафиксирована, и сбой
   * доставки уведомления не имеет права превратить её в 500.
   */
  async notifyTransactionAdded(txId: string, currentUser: SessionUser | null): Promise<void> {
    try {
      const row = await this.db.db.query.transactions.findFirst({
        where: eq(transactions.id, txId),
      })
      if (!row) return
      const recipientId = row.receiverId
      if (!recipientId) return
      // Системное событие (крон) актора не имеет — исключать некого.
      if (currentUser !== null && recipientId === (currentUser.impersonatorId ?? currentUser.id)) {
        return
      }

      await this.notifications.create({
        userId: recipientId,
        type: 'TRANSACTION_ADDED',
        title: NOTIFICATION_TITLES.TRANSACTION_ADDED,
        subjectType: 'TRANSACTION',
        subjectId: row.id,
        data: {
          amount: row.amount,
          currency: row.currency,
          projectName: await this.loadProjectName(row.projectId),
        },
        // Событие «эта строка создана» может доехать дважды только повтором —
        // и второй раз ничего нового не сообщает.
        dedupeKey: `TRANSACTION_ADDED:${row.id}`,
      })
    } catch (notifyErr) {
      this.logger.error(
        `notifyTransactionAdded: failed for transaction=${txId}: ${(notifyErr as Error).message}`,
        (notifyErr as Error).stack,
      )
    }
  }

  /**
   * «Статус транзакции изменился» — тому, чьи это деньги. Проверка и отклонение
   * (`validateTransaction`) — единственный переход статуса, которого сотрудник
   * ЖДЁТ: он внёс доход и не знает, приняли его или нет, а причину отказа иначе
   * узнать неоткуда.
   */
  async notifyTransactionStatusChanged(
    txId: string,
    status: 'VALIDATED' | 'REJECTED',
    rejectionReason: string | null,
    currentUser: SessionUser,
  ): Promise<void> {
    try {
      const row = await this.db.db.query.transactions.findFirst({
        where: eq(transactions.id, txId),
      })
      if (!row) return
      const recipientId = row.receiverId
      if (!recipientId) return
      if (recipientId === (currentUser.impersonatorId ?? currentUser.id)) return

      // SR-H-1 (круг 1): причина отказа едет превью, а не целиком — §10
      // («уведомление несёт суть и ссылку, полный текст читают в CRM»), та же
      // причина, что и у «сотрудник отклонил». Пустое превью = «без причины».
      const preview = rejectionReason === null ? null : notificationTextPreview(rejectionReason)
      await this.notifications.create({
        userId: recipientId,
        type: 'TRANSACTION_STATUS_CHANGED',
        title: NOTIFICATION_TITLES.TRANSACTION_STATUS_CHANGED,
        subjectType: 'TRANSACTION',
        subjectId: row.id,
        data: {
          amount: row.amount,
          currency: row.currency,
          status,
          rejectionReasonPreview: preview === '' ? null : preview,
        },
        // Статус входит в ключ: проверка и последующее отклонение — два разных
        // события об одной строке, и второе обязано доехать.
        dedupeKey: `TRANSACTION_STATUS_CHANGED:${row.id}:${status}`,
      })
    } catch (notifyErr) {
      this.logger.error(
        `notifyTransactionStatusChanged: failed for transaction=${txId}: ${(notifyErr as Error).message}`,
        (notifyErr as Error).stack,
      )
    }
  }

  /**
   * Название проекта снимается В МОМЕНТ события: уведомление живёт дольше
   * объекта (§7.4), и строка о том, что было, не должна становиться безымянной,
   * когда проект архивировали.
   *
   * ORCH-3 (fix-round 7): `companyName`, не `projects.name` — тот же экран
   * «Ждут решения» называет проект именем компании (copy r2 на #667), и
   * попап о деньгах обязан говорить тем же словом. Без фолбэка на `name`:
   * `companyName` — NOT NULL в схеме и `z.string().min(1)` на обоих путях
   * `.insert(projects)` (`create`/`createFromInterview`) — пустым не бывает;
   * фолбэк был бы недостижимой веткой (допущение раунда 7).
   */
  async loadProjectName(projectId: string | null): Promise<string | null> {
    if (projectId === null) return null
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      columns: { companyName: true },
    })
    return project?.companyName ?? null
  }

  /**
   * Fire-and-forget wrapper so a failing invoice generation (e.g. S3 outage)
   * does NOT roll back the underlying transaction state change. The PAID
   * status flip is the source of truth; the invoice is a derived artefact
   * that can always be re-generated (autoCreate is idempotent on
   * `invoice_document_id`).
   *
   * task-aggregate-invoice-per-payout: a third kind `PAYOUT` was added —
   * `payPayoutRequest` now fires one PAYOUT-trigger after the cascade
   * instead of N SENIOR_INCOME-triggers (one per linked income). The
   * SENIOR_INCOME branch is kept for legacy callers
   * (`PendingSettlementService.settleByCompany`).
   */
  async safeAutoCreateInvoice(
    kind: 'SENIOR_INCOME' | 'SALARY' | 'PAYOUT',
    transactionId: string,
  ): Promise<void> {
    try {
      if (kind === 'SENIOR_INCOME') {
        await this.invoices.autoCreateForSeniorPayout(transactionId)
      } else if (kind === 'SALARY') {
        await this.invoices.autoCreateForSalary(transactionId)
      } else {
        await this.invoices.autoCreateForPayout(transactionId)
      }
    } catch (err) {
      this.logger.warn(
        `auto-create invoice failed for ${kind} tx=${transactionId}: ${(err as Error).message}`,
      )
    }
  }

  /**
   * task-notification-types-producers (позиция 6). ЕДИНСТВЕННАЯ точка, которую
   * зовут все шесть пользовательских путей создания транзакции плюс зарплатный
   * крон — то есть ровно тот шов, который уже существовал под аудит. Спека §10
   * прямо предупреждает: «производители незаметно большие… пять модулей, и в
   * каждом надо не сломать существующее». Дописать вызов в восьми местах
   * значило бы принять ровно тот риск — «обнови везде» теряет одно место.
   * Поэтому здесь один вызов, а восемь мест только переименованы.
   *
   * ПОСЛЕ КОММИТА, а не внутри транзакции — сознательно, и это допустимая по
   * заданию половина правила («либо после её коммита с явным обоснованием»).
   * Обоснование: путей создания шесть, и не все они открывают транзакцию
   * (`createExpense` вне company-funded ветки вставляет на голом соединении).
   * Требование «уведомление о несостоявшемся событии недопустимо» выполняется
   * СИЛЬНЕЕ, чем при вставке внутрь: сюда попадают только уже
   * зафиксированные строки. Обратное — уведомление о событии, которое
   * откатилось, — структурно невозможно.
   */
  async afterTransactionCreated(
    txId: string,
    created: { type: string; amount: string; currency: string },
    currentUser: SessionUser | null,
  ): Promise<void> {
    // SR-L-2 (security-review круг 1): актор может отсутствовать — зарплатный
    // крон создаёт строки по расписанию, и сессионного пользователя у него
    // нет. Две половины этого шва относятся к актору по-разному:
    //   - ЖУРНАЛ действий пишется про человека; без человека писать в него
    //     нечего (у строки остаётся `createdBy` — резервный админ);
    //   - УВЕДОМЛЕНИЕ адресовано получателю денег и от актора не зависит:
    //     актор нужен ровно для того, чтобы не написать человеку о его же
    //     действии (§8.1). Нет актора — некого исключать.
    if (currentUser !== null) await this.recordCreationAudit(txId, created, currentUser)
    await this.notifyTransactionAdded(txId, currentUser)
  }

  /**
   * task-soft-delete-and-money-audit (AC5): "создание" — every primary
   * user-facing creation entry point (createAdminIncome / createSeniorIncome
   * / createDropIncome / createExpense / createSalary / createAdminTransfer)
   * calls this right after its `.insert(transactions)...returning()`.
   * Best-effort (mirrors AuditInterceptor's convention): a logging hiccup
   * must never turn a successful money-record creation into a 500 — the
   * primary insert has already committed by the time this runs.
   *
   * Deliberately NOT wired into every INTERNAL cascade insert (obligation
   * placeholders booked by `bookCompanyObligations`, the monthly salary cron,
   * drop-payout cascade rows) — those are system-derived side-effects of an
   * already-audited primary action, not a second independent "creation" a
   * human decided to make.
   */
  private async recordCreationAudit(
    txId: string,
    created: { type: string; amount: string; currency: string },
    currentUser: SessionUser,
  ): Promise<void> {
    try {
      await this.db.db.insert(transactionAuditLog).values({
        actorId: currentUser.impersonatorId ?? currentUser.id,
        targetId: txId,
        action: 'CREATE',
        metadata: {
          type: created.type,
          amount: created.amount,
          currency: created.currency,
        },
      })
    } catch (auditErr) {
      this.logger.error(
        `recordCreationAudit: failed to persist audit record for transaction=${txId}: ${(auditErr as Error).message}`,
        (auditErr as Error).stack,
      )
    }
  }
}
