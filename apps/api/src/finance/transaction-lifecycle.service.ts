import { Injectable, Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { NOTIFICATION_TITLES, notificationTextPreview } from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { projects, transactions } from '../database/schema'
import { NotificationsService } from '../notifications/notifications.service'

/**
 * WC-L5a — notification plumbing of TransactionsService (money events →
 * in-app notifications). Collaborator extraction: depends only on
 * NotificationsService + DatabaseService and NEVER on TransactionsService (no
 * cycle). Every method is best-effort: a delivery failure is logged, never
 * rethrown, so a committed money write can't turn into a 500.
 */
@Injectable()
export class TransactionLifecycleService {
  private readonly logger = new Logger(TransactionLifecycleService.name)

  constructor(
    private readonly notifications: NotificationsService,
    private readonly db: DatabaseService,
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
}
