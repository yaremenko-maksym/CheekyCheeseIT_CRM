import { and, eq, inArray, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderNotification } from '@crm/shared'
import type { RenderableNotification } from '@crm/shared'

import { NotificationsService } from './notifications.service'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { approvals, notifications, projects, teamMembers, teams, users } from '../database/schema'
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
const ALL_USER_IDS = [ADMIN_ID, SENIOR_ID, DROP_ID, NEWCOMER_ID]

let pool: Pool
let db: ReturnType<typeof drizzle<typeof schema>>
let service: NotificationsService

async function wipe(): Promise<void> {
  await db.delete(notifications).where(inArray(notifications.userId, ALL_USER_IDS))
  await db.delete(approvals).where(inArray(approvals.approverUserId, ALL_USER_IDS))
  await db.delete(teamMembers).where(inArray(teamMembers.userId, ALL_USER_IDS))
  await db.delete(projects).where(inArray(projects.id, [PROJECT_ID, DOOMED_PROJECT_ID]))
  await db.delete(teams).where(eq(teams.id, TEAM_ID))
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
        title: 'Добавлена транзакция',
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
        title: 'Сотрудник отклонил',
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
        title: 'Ждёт решения: новый проект',
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
        { label: 'Объекта больше нет', href: null, disabled: true },
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
        title: 'Ждёт решения: новая доля',
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
        { label: 'Объекта больше нет', href: null, disabled: true },
      ])
    })
  })
})
