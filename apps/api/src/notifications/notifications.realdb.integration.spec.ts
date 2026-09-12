import { and, eq, inArray, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderNotification } from '@crm/shared'
import type { RenderableNotification } from '@crm/shared'

import { NotificationsService } from './notifications.service'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import {
  approvals,
  contractTemplates,
  employeeContracts,
  notifications,
  projects,
  teamMembers,
  teams,
  users,
} from '../database/schema'
import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

/**
 * Уведомления на ЖИВОЙ базе — task-notification-types-producers (позиция 6).
 *
 * Зачем отдельный файл рядом с шестью unit-спеками производителей: задание
 * требует «живой прогон на реальном стеке для AC3/AC5 хотя бы на двух типах
 * (деньги и согласование) — моки не исполняют стражи», и отдельно AC4
 * («откат события → нет записи»). Ни то, ни другое мок доказать не может по
 * построению:
 *
 *   - AC4 держится на ROLLBACK, который выполняет Postgres. Мок транзакции
 *     «откатывает» ровно то, что мок и записал, то есть проверяет сам себя.
 *   - AC5 держится на `WHERE user_id = $1` внутри `listForUser`. Мок вернёт
 *     то, что в него положили, и не заметит, если условие выборки убрать.
 *   - AC6 держится на JOIN'ах резолвера к живым таблицам и на предикате
 *     `superseded_at IS NULL`.
 *
 * DB-SKIP-GUARD: `describe.skipIf(!hasDatabaseUrl())` — при пустом
 * DATABASE_URL (конвенция `DATABASE_URL= git push`) сьюта отчитывается
 * SKIPPED. Если DATABASE_URL задан, но схема не мигрирована,
 * `assertRealDbSchema` бросает в `beforeAll` → FAILED. Ни один из двух
 * случаев не может выглядеть как «passed» с нулём ассертов.
 */

// ── Пространство идентификаторов: f6a10000-**-4006-**-** ────────────────────
const ADMIN_ID = 'f6a10000-0000-4006-a000-000000000001'
const SENIOR_ID = 'f6a10000-0000-4006-a000-000000000002'
const DROP_ID = 'f6a10000-0000-4006-a000-000000000003'
const NEWCOMER_ID = 'f6a10000-0000-4006-a000-000000000004'
const TEAM_ID = 'f6a10000-0000-4006-b000-000000000001'
const PROJECT_ID = 'f6a10000-0000-4006-c000-000000000001'
const DOOMED_PROJECT_ID = 'f6a10000-0000-4006-c000-000000000002'
// QA-M-1 (manual-qa круг 1, #664) — контракт NEWCOMER_ID для теста деградации.
const CONTRACT_ID = 'f6a10000-0000-4006-d000-000000000001'
// QA-M-3 / QA-L-2 (manual-qa круг 2, #664) — объекты, которые архивируют.
const ARCHIVED_PROJECT_ID = 'f6a10000-0000-4006-c000-000000000003'
const ARCHIVED_TEAM_ID = 'f6a10000-0000-4006-b000-000000000002'
const ALL_USER_IDS = [ADMIN_ID, SENIOR_ID, DROP_ID, NEWCOMER_ID]

let pool: Pool
let db: ReturnType<typeof drizzle<typeof schema>>
let service: NotificationsService
// Резолвится динамически в `beforeAll` — id шаблона отличается между `crm_db`
// и scratch-базами (тот же приём, что в `contract-status.realdb.integration.spec.ts`).
let juniorTemplateId: string

async function wipe(): Promise<void> {
  await db.delete(notifications).where(inArray(notifications.userId, ALL_USER_IDS))
  await db.delete(approvals).where(inArray(approvals.approverUserId, ALL_USER_IDS))
  await db.delete(teamMembers).where(inArray(teamMembers.userId, ALL_USER_IDS))
  // FK-safe order: contract row before its owning user.
  await db.delete(employeeContracts).where(eq(employeeContracts.id, CONTRACT_ID))
  await db
    .delete(projects)
    .where(inArray(projects.id, [PROJECT_ID, DOOMED_PROJECT_ID, ARCHIVED_PROJECT_ID]))
  await db.delete(teams).where(inArray(teams.id, [TEAM_ID, ARCHIVED_TEAM_ID]))
  await db.delete(users).where(inArray(users.id, ALL_USER_IDS))
}

describe.skipIf(!hasDatabaseUrl())('уведомления на живой базе (позиция 6)', () => {
  beforeAll(async () => {
    // Колонки этой задачи. Нет их — миграция не применена, и спека обязана
    // упасть громко, а не «пройти» с нулём ассертов.
    await assertRealDbSchema([
      { table: 'notifications', column: 'subject_type' },
      { table: 'notifications', column: 'subject_id' },
      { table: 'notifications', column: 'secondary_id' },
      { table: 'notifications', column: 'data' },
      { table: 'notifications', column: 'dedupe_key' },
    ])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    db = drizzle(pool, { schema })
    service = new NotificationsService(
      { db } as unknown as DatabaseService,
      makeTelemetryErrorsStub(),
    )

    // QA-M-1 (#664): id шаблона JUNIOR резолвится динамически — как и в
    // `contract-status.realdb.integration.spec.ts`, он отличается между
    // `crm_db` и scratch-базами; фиксировать литералом означало бы падать на
    // любой базе, где сид сгенерировал другой id.
    const junior = await db
      .select({ id: contractTemplates.id })
      .from(contractTemplates)
      .where(eq(contractTemplates.targetRole, 'JUNIOR'))
      .limit(1)
    if (!junior[0]) {
      throw new Error('[notifications-realdb] FAILED — нет ни одного шаблона контракта JUNIOR')
    }
    juniorTemplateId = junior[0].id

    await wipe()

    await db.insert(users).values([
      { id: ADMIN_ID, email: 'pos6-admin@test.spec', displayName: 'Админ', role: 'ADMIN' },
      { id: SENIOR_ID, email: 'pos6-senior@test.spec', displayName: 'Синьор', role: 'SENIOR' },
      { id: DROP_ID, email: 'pos6-drop@test.spec', displayName: 'Дроп', role: 'DROP' },
      { id: NEWCOMER_ID, email: 'pos6-new@test.spec', displayName: 'Новичок', role: 'JUNIOR' },
    ])
    await db.insert(teams).values({ id: TEAM_ID, name: 'Команда позиции 6' })
    await db.insert(projects).values([
      {
        id: PROJECT_ID,
        name: 'Живой проект',
        companyName: 'Acme',
        domain: 'AI',
        startDate: new Date('2026-01-01T00:00:00Z'),
        seniorId: SENIOR_ID,
        rate: 100,
      },
      {
        id: DOOMED_PROJECT_ID,
        name: 'Проект, который удалят',
        companyName: 'Acme',
        domain: 'AI',
        startDate: new Date('2026-01-01T00:00:00Z'),
        seniorId: SENIOR_ID,
        rate: 100,
      },
    ])
  })

  afterAll(async () => {
    if (!pool) return
    await wipe()
    await pool.end()
  })

  // ─── AC4. Откат события → нет записи ────────────────────────────────────
  describe('AC4 — уведомление откатывается вместе с событием', () => {
    // Пара тестов, а не один: без «успешной» половины «нет записи» проходило
    // бы и в случае, когда производитель вообще ничего не пишет. Первый тест
    // доказывает, что запись в этой транзакции ВОЗНИКАЕТ; второй — что она
    // исчезает вместе с откатом.
    it('успешная транзакция оставляет и членство, и уведомление', async () => {
      await db.transaction(async (tx) => {
        await tx.insert(teamMembers).values({ teamId: TEAM_ID, userId: NEWCOMER_ID })
        await service.createInTx(tx, {
          userId: NEWCOMER_ID,
          type: 'TEAM_MEMBER_ADDED',
          title: 'Вас добавили в команду',
          subjectType: 'TEAM',
          subjectId: TEAM_ID,
          data: { teamName: 'Команда позиции 6' },
        })
      })

      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(eq(notifications.userId, NEWCOMER_ID), eq(notifications.type, 'TEAM_MEMBER_ADDED')),
        )
      expect(rows).toHaveLength(1)

      const membership = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, TEAM_ID), eq(teamMembers.userId, NEWCOMER_ID)))
      expect(membership).toHaveLength(1)

      // Подчистить за собой: следующий тест считает записи того же получателя.
      await db.delete(notifications).where(eq(notifications.userId, NEWCOMER_ID))
      await db.delete(teamMembers).where(eq(teamMembers.userId, NEWCOMER_ID))
    })

    it('упавшая транзакция не оставляет НИ членства, НИ уведомления', async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(teamMembers).values({ teamId: TEAM_ID, userId: NEWCOMER_ID })
          await service.createInTx(tx, {
            userId: NEWCOMER_ID,
            type: 'TEAM_MEMBER_ADDED',
            title: 'Вас добавили в команду',
            subjectType: 'TEAM',
            subjectId: TEAM_ID,
            data: { teamName: 'Команда позиции 6' },
          })
          // Событие не состоялось после того, как уведомление уже записано —
          // ровно порядок, в котором работают производители в teams/projects.
          throw new Error('событие не состоялось')
        }),
      ).rejects.toThrow('событие не состоялось')

      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, NEWCOMER_ID))
      expect(rows).toEqual([])

      const membership = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.userId, NEWCOMER_ID))
      expect(membership).toEqual([])
    })
  })

  // ─── AC5. Раскрытие: деньги и согласование, живой стек ──────────────────
  describe('AC5 — чужая сумма и чужой процент не уходят соседу', () => {
    it('деньги: сумма видна получателю и НИКОМУ больше', async () => {
      await service.create({
        userId: DROP_ID,
        type: 'TRANSACTION_ADDED',
        title: 'Вам добавили транзакцию',
        subjectType: 'TRANSACTION',
        subjectId: null,
        data: { amount: '1234.56', currency: 'USDT', projectName: 'Живой проект' },
      })

      const mine = await service.listForUser(DROP_ID, { limit: 10 })
      expect(mine.items).toHaveLength(1)
      expect(mine.items[0]?.data).toMatchObject({ amount: '1234.56' })

      // Тот же список глазами трёх других сотрудников — выборка идёт по
      // `WHERE user_id = $1`, и это единственное, что стоит между чужой
      // суммой и чужим колокольчиком.
      for (const otherId of [SENIOR_ID, ADMIN_ID, NEWCOMER_ID]) {
        const theirs = await service.listForUser(otherId, { limit: 10 })
        expect(theirs.items).toEqual([])
        expect(JSON.stringify(theirs)).not.toContain('1234.56')
      }
    })

    it('согласование: причина отказа видна админу и НИКОМУ больше', async () => {
      await service.create({
        userId: ADMIN_ID,
        type: 'APPROVAL_REJECTED',
        title: 'Предложение отклонено',
        subjectType: 'PROJECT',
        subjectId: PROJECT_ID,
        data: {
          approverName: 'Синьор',
          subjectKind: 'PROJECT_SHARE',
          subjectTitle: 'Живой проект',
          reasonPreview: 'Процент ниже договорённого',
        },
      })

      const adminList = await service.listForUser(ADMIN_ID, { limit: 10 })
      expect(adminList.items.some((n) => n.type === 'APPROVAL_REJECTED')).toBe(true)

      for (const otherId of [SENIOR_ID, DROP_ID, NEWCOMER_ID]) {
        const theirs = await service.listForUser(otherId, { limit: 10 })
        expect(theirs.items.some((n) => n.type === 'APPROVAL_REJECTED')).toBe(false)
        expect(JSON.stringify(theirs)).not.toContain('Процент ниже договорённого')
      }
    })

    it('заголовок в базе — нейтральный: ни суммы, ни процента (§10, письмо)', async () => {
      // Позиция 7 имеет право положить в письмо ТОЛЬКО `title`. Если цифра
      // просочилась в заголовок, она уедет на личную почту вне контура —
      // поэтому проверяется то, что лежит в колонке, а не то, что покажет
      // клиент.
      const rows = await db
        .select({ title: notifications.title })
        .from(notifications)
        .where(inArray(notifications.userId, ALL_USER_IDS))
      expect(rows.length).toBeGreaterThan(0)
      for (const { title } of rows) {
        expect(title).not.toMatch(/\d/)
        expect(title).not.toContain('%')
      }
    })
  })

  // ─── AC6. Деградация: объект исчез ──────────────────────────────────────
  describe('AC6 — уведомление живёт дольше объекта', () => {
    it('проект удалён → честное «объекта больше нет», а не кнопка в никуда', async () => {
      // Живое согласование обязательно: «подтвердить проект» перестаёт быть
      // живым не только когда исчез проект, но и когда подтверждать уже
      // нечего. Обе половины проверяет `computeSubjectMissing`, и без этой
      // строки тест доказывал бы только вторую.
      await db.insert(approvals).values({
        subjectType: 'PROJECT',
        subjectId: DOOMED_PROJECT_ID,
        approverUserId: SENIOR_ID,
        proposedByUserId: ADMIN_ID,
      })
      await service.create({
        userId: SENIOR_ID,
        type: 'PROJECT_CONFIRM_REQUIRED',
        title: 'Проект ждёт решения',
        subjectType: 'PROJECT',
        subjectId: DOOMED_PROJECT_ID,
        data: { projectName: 'Проект, который удалят' },
      })

      const before = await service.listForUser(SENIOR_ID, { limit: 10 })
      const liveItem = before.items.find((n) => n.type === 'PROJECT_CONFIRM_REQUIRED')
      expect(liveItem?.subjectMissing).toBe(false)
      expect(renderNotification(liveItem as RenderableNotification).actions[0]).toMatchObject({
        href: `/projects/${DOOMED_PROJECT_ID}`,
        disabled: false,
      })

      await db.delete(projects).where(eq(projects.id, DOOMED_PROJECT_ID))

      const after = await service.listForUser(SENIOR_ID, { limit: 10 })
      const deadItem = after.items.find((n) => n.type === 'PROJECT_CONFIRM_REQUIRED')
      // Сама запись НЕ исчезает — исчезает только её кнопка.
      expect(deadItem).toBeDefined()
      expect(deadItem?.subjectMissing).toBe(true)
      expect(renderNotification(deadItem as RenderableNotification).actions).toEqual([
        { label: 'Проект удалён', href: null, disabled: true },
      ])
    })

    it('согласование погашено через supersededAt → та же честная кнопка', async () => {
      await db.insert(approvals).values({
        subjectType: 'PROJECT_SENIOR_SHARE',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
        proposedByUserId: ADMIN_ID,
      })
      await service.create({
        userId: SENIOR_ID,
        type: 'SHARE_CONFIRM_REQUIRED',
        title: 'Предложение по доле',
        subjectType: 'PROJECT',
        subjectId: PROJECT_ID,
        data: {
          scope: 'PROJECT',
          projectName: 'Живой проект',
          previousPercent: 26,
          proposedPercent: 30,
        },
      })

      const live = await service.listForUser(SENIOR_ID, { limit: 10 })
      expect(live.items.find((n) => n.type === 'SHARE_CONFIRM_REQUIRED')?.subjectMissing).toBe(
        false,
      )

      // Погашение — не удаление строки: предикат `superseded_at IS NULL` и
      // есть то, что отличает живое предложение от отработавшего.
      await db
        .update(approvals)
        .set({ supersededAt: new Date() })
        .where(and(eq(approvals.subjectId, PROJECT_ID), isNull(approvals.supersededAt)))

      const dead = await service.listForUser(SENIOR_ID, { limit: 10 })
      const item = dead.items.find((n) => n.type === 'SHARE_CONFIRM_REQUIRED')
      expect(item?.subjectMissing).toBe(true)
      expect(renderNotification(item as RenderableNotification).actions).toEqual([
        { label: 'Проект удалён', href: null, disabled: true },
      ])
    })

    /**
     * QA-M-1 (manual-qa круг 1, #664). Контракты в этой системе не
     * удаляются — `EmployeeContractsService` только меняет `status`. Значит
     * «объект существует» для `DOCUMENT_SIGN_REQUIRED` не может значить
     * «строка не удалена» (это условие истинно ВСЕГДА, деградация была бы
     * мертва) — оно обязано значить «контракт ещё ждёт подписи»
     * (`loadExistingIds`, ветка `EMPLOYEE_CONTRACT`). Решение оркестратора:
     * не пробивать `OnboardingGuard` — вместо этого честная деградация ПОСЛЕ
     * подписи, тем же механизмом, что и у остальных девяти типов (§7.4).
     */
    it('контракт подписан → «Подпись больше не требуется», не «Контракт удалён», кнопка недоступна', async () => {
      await db.insert(employeeContracts).values({
        id: CONTRACT_ID,
        userId: NEWCOMER_ID,
        sourceTemplateId: juniorTemplateId,
        bodyMarkdown: '<p>Тестовый текст контракта</p>',
        createdByUserId: ADMIN_ID,
        status: 'READY_TO_SIGN',
      })
      await service.create({
        userId: NEWCOMER_ID,
        type: 'DOCUMENT_SIGN_REQUIRED',
        title: 'Контракт на подпись',
        subjectType: 'EMPLOYEE_CONTRACT',
        subjectId: CONTRACT_ID,
        data: { documentTitle: 'Ваш контракт с компанией' },
      })

      const beforeSigning = await service.listForUser(NEWCOMER_ID, { limit: 10 })
      const pending = beforeSigning.items.find((n) => n.type === 'DOCUMENT_SIGN_REQUIRED')
      expect(pending?.subjectMissing).toBe(false)
      expect(renderNotification(pending as RenderableNotification).actions).toEqual([
        { label: 'Подписать контракт', href: '/onboarding', disabled: false },
      ])

      // Реальный переход READY_TO_SIGN → SIGNED — то же, что делает
      // `EmployeeContractsService.markSigned` (через `getReadyForSigning` +
      // `UPDATE`); прямой UPDATE здесь достаточен, потому что предмет теста —
      // реакция `NotificationsService` на СОСТОЯНИЕ таблицы контрактов, а не
      // сам переход (тот покрыт `contract-notifications.unit.spec.ts` и
      // `employee-contracts.service.spec.ts`).
      await db
        .update(employeeContracts)
        .set({ status: 'SIGNED' })
        .where(eq(employeeContracts.id, CONTRACT_ID))

      const afterSigning = await service.listForUser(NEWCOMER_ID, { limit: 10 })
      const signed = afterSigning.items.find((n) => n.type === 'DOCUMENT_SIGN_REQUIRED')
      // Сама запись НЕ исчезает и НЕ переименовывается — деградирует только
      // её кнопка, как и у остальных девяти типов.
      expect(signed).toBeDefined()
      expect(signed?.subjectMissing).toBe(true)
      expect(renderNotification(signed as RenderableNotification).actions).toEqual([
        { label: 'Подпись больше не требуется', href: null, disabled: true },
      ])

      // Подчистить за собой: следующий прогон этого же файла не должен
      // упереться в partial-unique `employee_contracts_one_per_user`.
      await db.delete(notifications).where(eq(notifications.subjectId, CONTRACT_ID))
      await db.delete(employeeContracts).where(eq(employeeContracts.id, CONTRACT_ID))
    })
  })

  /**
   * QA-M-3 (MED) / QA-L-2 (LOW) — manual-qa круг 2, #664.
   *
   * Находка вскрылась ТОЛЬКО на живом стенде, и проверять её мок не имеет
   * права по той же причине, что и остальную деградацию: «объект архивен»
   * живёт в колонке `archived_at`, и вопрос ровно в том, читает ли её
   * реальный запрос. Мок вернёт то, что в него положили, и не заметит, если
   * колонку перестать спрашивать.
   *
   * Прогон QA: архивация проекта каскадом закрывает членство
   * (`project_members.left_at`), и джун по активной кнопке приезжал на
   * «Вас ещё не добавили в проект» — ложь про событие, которое БЫЛО.
   */
  describe('QA-M-3 / QA-L-2 — архив это не удаление', () => {
    it('архивный проект: семь типов с subjectType=PROJECT получают «Проект в архиве»', async () => {
      await db.insert(projects).values({
        id: ARCHIVED_PROJECT_ID,
        name: 'Проект, который заархивируют',
        companyName: 'Acme',
        domain: 'AI',
        startDate: new Date('2026-01-01T00:00:00Z'),
        seniorId: SENIOR_ID,
        rate: 100,
      })
      await service.create({
        userId: NEWCOMER_ID,
        type: 'PROJECT_MEMBER_ADDED',
        title: 'Вас добавили в проект',
        subjectType: 'PROJECT',
        subjectId: ARCHIVED_PROJECT_ID,
        data: { projectName: 'Проект, который заархивируют' },
      })

      const beforeArchive = await service.listForUser(NEWCOMER_ID, { limit: 10 })
      const live = beforeArchive.items.find((n) => n.subjectId === ARCHIVED_PROJECT_ID)
      expect([live?.subjectMissing, live?.subjectArchived]).toEqual([false, false])
      expect(renderNotification(live as RenderableNotification).actions).toEqual([
        { label: 'Открыть проект', href: `/projects/${ARCHIVED_PROJECT_ID}`, disabled: false },
      ])

      // Ровно то, что делает `DELETE /api/projects/:id` — строка остаётся,
      // проставляется `archived_at`.
      await db
        .update(projects)
        .set({ archivedAt: new Date() })
        .where(eq(projects.id, ARCHIVED_PROJECT_ID))

      const afterArchive = await service.listForUser(NEWCOMER_ID, { limit: 10 })
      const archived = afterArchive.items.find((n) => n.subjectId === ARCHIVED_PROJECT_ID)
      expect(archived).toBeDefined()
      expect(archived?.subjectArchived).toBe(true)
      // Не «удалён»: проект цел и виден в архиве — вторая ложь была бы не
      // лучше первой.
      expect(archived?.subjectMissing).toBe(false)
      expect(renderNotification(archived as RenderableNotification).actions).toEqual([
        { label: 'Проект в архиве', href: null, disabled: true },
      ])

      // Находка задевает не один тип, а всю семью с этим видом объекта.
      for (const type of [
        'PROJECT_CONFIRM_REQUIRED',
        'SHARE_CONFIRM_REQUIRED',
        'APPROVAL_CONFIRMED',
        'APPROVAL_REJECTED',
      ] as const) {
        const rendered = renderNotification({
          ...(archived as RenderableNotification),
          type,
        })
        expect(rendered.actions).toEqual([{ label: 'Проект в архиве', href: null, disabled: true }])
      }

      await db.delete(notifications).where(eq(notifications.subjectId, ARCHIVED_PROJECT_ID))
      await db.delete(projects).where(eq(projects.id, ARCHIVED_PROJECT_ID))
    })

    it('архивная команда: «Команда в архиве», кнопка недоступна', async () => {
      await db.insert(teams).values({ id: ARCHIVED_TEAM_ID, name: 'Команда, которую заархивируют' })
      await service.create({
        userId: NEWCOMER_ID,
        type: 'TEAM_NEW_MEMBER',
        title: 'В команде новый участник',
        subjectType: 'TEAM',
        subjectId: ARCHIVED_TEAM_ID,
        secondaryId: DROP_ID,
        data: { teamName: 'Команда, которую заархивируют', memberName: 'Дроп' },
      })

      await db.update(teams).set({ archivedAt: new Date() }).where(eq(teams.id, ARCHIVED_TEAM_ID))

      const list = await service.listForUser(NEWCOMER_ID, { limit: 10 })
      const item = list.items.find((n) => n.subjectId === ARCHIVED_TEAM_ID)
      expect([item?.subjectMissing, item?.subjectArchived]).toEqual([false, true])
      expect(renderNotification(item as RenderableNotification).actions).toEqual([
        { label: 'Команда в архиве', href: null, disabled: true },
      ])

      await db.delete(notifications).where(eq(notifications.subjectId, ARCHIVED_TEAM_ID))
      await db.delete(teams).where(eq(teams.id, ARCHIVED_TEAM_ID))
    })

    it('архивный профиль: «Профиль в архиве» — у users своя archived_at', async () => {
      await service.create({
        userId: ADMIN_ID,
        type: 'APPROVAL_CONFIRMED',
        title: 'Предложение принято',
        subjectType: 'USER',
        subjectId: DROP_ID,
        secondaryId: DROP_ID,
        data: { approverName: 'Дроп', subjectKind: 'BASE_SHARE', subjectTitle: null },
      })

      await db.update(users).set({ archivedAt: new Date() }).where(eq(users.id, DROP_ID))

      const list = await service.listForUser(ADMIN_ID, { limit: 10 })
      const item = list.items.find((n) => n.subjectId === DROP_ID)
      expect([item?.subjectMissing, item?.subjectArchived]).toEqual([false, true])
      expect(renderNotification(item as RenderableNotification).actions).toEqual([
        { label: 'Профиль в архиве', href: null, disabled: true },
      ])

      await db.update(users).set({ archivedAt: null }).where(eq(users.id, DROP_ID))
      await db.delete(notifications).where(eq(notifications.subjectId, DROP_ID))
    })
  })
})
