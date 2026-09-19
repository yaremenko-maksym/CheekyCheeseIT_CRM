/**
 * Половина §7.4 с запросами, ОДНА на весь модуль — бэклог 208.
 *
 * Раньше этот код жил внутри `NotificationsService` как приватные
 * `resolveSubjectStates`/`loadSubjectStates`, и его видел только попап
 * (`listForUser`). Крон (`NotificationEmailCronService`) устаревание письма
 * не проверял вовсе: предложение отозвали за секунду до тика — письмо
 * «требующего действия» всё равно уходило (допущение A1 на #673, снятое
 * здесь).
 *
 * Вынесено в отдельный сервис, а не скопировано во второй раз, по прямому
 * требованию задания: «тем же резолвером, что попап», а не «тем же
 * запросом, переписанным заново». Два места, читающие одно и то же
 * состояние по-разному, расходятся молча — именно так и родилось
 * допущение A1: у крона просто не было своей версии проверки, и никто не
 * заметил, потому что заметить было негде.
 *
 * `resolveMany` — то, чем пользуется попап (одна пачка уведомлений одного
 * получателя, порядок ответов совпадает с порядком строк). `resolveOne` —
 * то, чем пользуется крон (одна строка письма в момент отправки): тот же
 * запрос с пачкой длины один, а не отдельная реализация.
 *
 * Решение принимает ЧИСТАЯ половина — `computeSubjectState` в
 * `notification-subject-resolver.ts`. Здесь только запросы: `resolveMany`/
 * `resolveOne` не тестируются гейтом мутаций напрямую (интеграционные
 * спеки гейт не видит — `.claude/rules/common/mutation-gate-integration-specs.md`),
 * поэтому запросы проверяются юнит-тестом с компилируемым `where`
 * (`notification-subject-state.service.spec.ts`, приём из
 * `notifications.service.spec.ts`, SR-L-8), а решения — уже под мутациями
 * в `notification-subject-resolver.spec.ts`.
 */
import { Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { NotificationSubjectType } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  approvals,
  employeeContracts,
  nonDeletedTransactions,
  projects,
  teams,
  users,
} from '../database/schema'
import {
  approvalIdsToCheck,
  classifyApprovalRow,
  computeSubjectState,
  groupSubjectIds,
  type SubjectRef,
  type SubjectResolution,
  type SubjectState,
} from './notification-subject-resolver'

@Injectable()
export class NotificationSubjectStateService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Состояние каждой строки из `refs`, В ПОРЯДКЕ строк — не картой по
   * идентификатору (см. doc-комментарий на прежнем месте этого кода в
   * `NotificationsService`: карта требовала бы запасного значения на случай
   * «состояния нет», которого не бывает).
   *
   * `userId` — получатель ВСЕХ строк `refs` (SR-L-8, defense-in-depth):
   * запрос к `approvals` связывает найденную строку с НИМ через
   * `approverUserId`, а не полагается на дисциплину вызывающего. Строка
   * чужого подтверждающего читается КАК ОТСУТСТВУЮЩАЯ. Для попапа это один
   * человек на всю пачку (`listForUser` уже скопил её по нему); для крона —
   * получатель ЭТОГО письма, пачка длины один.
   */
  async resolveMany(userId: string, refs: SubjectRef[]): Promise<SubjectResolution[]> {
    const statesByType = new Map<NotificationSubjectType, Map<string, SubjectState>>()
    for (const [subjectType, ids] of groupSubjectIds(refs)) {
      statesByType.set(subjectType, await this.loadSubjectStates(subjectType, ids))
    }

    const liveApprovalIds = new Set<string>()
    const decidedApprovalIds = new Set<string>()
    const approvalIds = approvalIdsToCheck(refs)
    if (approvalIds.length > 0) {
      const live = await this.db.db
        .select({ id: approvals.id, status: approvals.status })
        .from(approvals)
        .where(
          and(
            isNull(approvals.supersededAt),
            inArray(approvals.id, approvalIds),
            eq(approvals.approverUserId, userId),
          ),
        )
      for (const row of live) {
        const classification = classifyApprovalRow(row.status)
        if (classification === 'live') liveApprovalIds.add(row.id)
        else if (classification === 'decided') decidedApprovalIds.add(row.id)
        // 'superseded' (CANCELLED, defensively) не попадает ни в один набор —
        // см. doc-комментарий `classifyApprovalRow`.
      }
    }

    return refs.map((ref) =>
      computeSubjectState(ref, statesByType, liveApprovalIds, decidedApprovalIds),
    )
  }

  /**
   * Одна строка — крону нужно решение об ОДНОМ письме в момент отправки, не
   * о пачке. Та же арность на входе и выходе, что у `resolveMany`: пачка
   * длины один даёт ровно один ответ, поэтому `[0]` здесь не защитный код —
   * `refs.map(...)` в `resolveMany` не может вернуть массив другой длины.
   */
  async resolveOne(userId: string, ref: SubjectRef): Promise<SubjectResolution> {
    const [state] = await this.resolveMany(userId, [ref])
    return state as SubjectResolution
  }

  /**
   * Состояние каждого запрошенного объекта. Отсутствие в карте — «объекта
   * больше нет». Один и тот же способ проверки архива для PROJECT/TEAM/USER
   * (три копии одного условия расходятся молча, общий механизм — нет);
   * TRANSACTION и EMPLOYEE_CONTRACT (DOCUMENT_SIGN_REQUIRED) устроены иначе —
   * см. ветки ниже.
   */
  private async loadSubjectStates(
    subjectType: NotificationSubjectType,
    ids: string[],
  ): Promise<Map<string, SubjectState>> {
    const byArchivedAt = (rows: { id: string; archivedAt: Date | null }[]) =>
      new Map<string, SubjectState>(
        rows.map((r) => [r.id, r.archivedAt === null ? 'active' : 'archived']),
      )
    switch (subjectType) {
      case 'PROJECT': {
        const found = await this.db.db
          .select({ id: projects.id, archivedAt: projects.archivedAt })
          .from(projects)
          .where(inArray(projects.id, ids))
        return byArchivedAt(found)
      }
      case 'TEAM': {
        const found = await this.db.db
          .select({ id: teams.id, archivedAt: teams.archivedAt })
          .from(teams)
          .where(inArray(teams.id, ids))
        return byArchivedAt(found)
      }
      case 'USER': {
        const found = await this.db.db
          .select({ id: users.id, archivedAt: users.archivedAt })
          .from(users)
          .where(inArray(users.id, ids))
        return byArchivedAt(found)
      }
      case 'TRANSACTION': {
        // У транзакции архива нет — есть мягкое удаление, и оно уже отрезано
        // самим представлением `non_deleted_transactions`.
        const found = await this.db.db
          .select({ id: nonDeletedTransactions.id })
          .from(nonDeletedTransactions)
          .where(inArray(nonDeletedTransactions.id, ids))
        return new Map<string, SubjectState>(found.map((r) => [r.id, 'active']))
      }
      case 'EMPLOYEE_CONTRACT': {
        // `DOCUMENT_SIGN_REQUIRED` — единственный тип с этим видом объекта, и
        // «объект существует» для НЕГО означает не «строка не удалена»
        // (контракты не удаляются — `EmployeeContractsService` только меняет
        // `status`), а «контракт всё ещё ждёт подписи». Без этого условия
        // кнопка/письмо «Подписать контракт» оставались бы активными и после
        // того, как сотрудник его уже подписал.
        const found = await this.db.db
          .select({ id: employeeContracts.id })
          .from(employeeContracts)
          .where(
            and(inArray(employeeContracts.id, ids), eq(employeeContracts.status, 'READY_TO_SIGN')),
          )
        return new Map<string, SubjectState>(found.map((r) => [r.id, 'active']))
      }
      default: {
        // SR-M-1 (PR #678, круг 2): та же идиома, что `classifyApprovalRow`/
        // `computeSubjectState` в `notification-subject-resolver.ts` —
        // шестой вид `NotificationSubjectType` красит компиляцию здесь, а не
        // молча падает в `missing` (для action-required-письма это теперь
        // `SKIPPED/STALE`, а не «попап показал деградированную карточку»).
        const exhaustive: never = subjectType
        throw new Error(`loadSubjectStates: неизвестный вид объекта ${String(exhaustive)}`)
      }
    }
  }
}
