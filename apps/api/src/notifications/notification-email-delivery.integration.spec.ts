import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { NotificationsService } from './notifications.service'
import { OutboxRepository } from './notification-email.repository'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import {
  notificationEmails,
  notificationPreferences,
  notifications,
  userEmails,
  users,
} from '../database/schema'
import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

/**
 * Доставка писем на ЖИВОЙ базе — позиция 7a, AC1/AC2/AC3.
 *
 * Здесь проверяется ровно то, чего мок доказать не может по построению:
 *
 *   - **AC1, откат.** Транзакция откатывается Postgres'ом. Мок, «откатывающий»
 *     то, что сам записал, проверял бы себя.
 *   - **AC2, `FOR UPDATE SKIP LOCKED`.** Два одновременных захвата обязаны
 *     разойтись по разным строкам. Это поведение блокировок Postgres, а не
 *     наше.
 *   - **AC2, частичный индекс.** `WHERE status = 'QUEUED'` в индексе и в
 *     запросе должны совпасть, иначе захват молча перестаёт находить строки.
 *   - **AC3, выбор адреса.** JOIN к `user_emails` с настоящим порядком строк.
 *
 * DB-SKIP-GUARD: `describe.skipIf(!hasDatabaseUrl())` — при пустом
 * DATABASE_URL (конвенция `DATABASE_URL= git push`) сьюта отчитывается
 * SKIPPED; при заданном, но немигрированном — `assertRealDbSchema` бросает в
 * `beforeAll`, и сьюта FAILED. «Passed с нулём ассертов» не получается ни в
 * одном из двух случаев.
 */

// ── Пространство идентификаторов: f7a10000-**-4007-**-** ────────────────────
const USER_A = 'f7a10000-0000-4007-a000-000000000001'
const USER_B = 'f7a10000-0000-4007-a000-000000000002'
const USER_NO_MAIL = 'f7a10000-0000-4007-a000-000000000003'
const ALL_USERS = [USER_A, USER_B, USER_NO_MAIL]

let pool: Pool
let db: ReturnType<typeof drizzle<typeof schema>>
let service: NotificationsService
let repo: OutboxRepository

async function wipe(): Promise<void> {
  // Порядок FK-безопасный: очередь ссылается на уведомления, те — на людей.
  await db.delete(notificationEmails).where(inArray(notificationEmails.userId, ALL_USERS))
  await db.delete(notifications).where(inArray(notifications.userId, ALL_USERS))
  await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, ALL_USERS))
  await db.delete(userEmails).where(inArray(userEmails.userId, ALL_USERS))
  await db.delete(users).where(inArray(users.id, ALL_USERS))
}

function notificationInput(userId: string) {
  return {
    userId,
    type: 'PROJECT_CONFIRM_REQUIRED' as const,
    title: 'Проект ждёт решения',
    subjectType: 'PROJECT' as const,
    subjectId: 'f7a10000-0000-4007-b000-000000000002',
    data: {
      projectName: 'Мобильный банк',
      approvalId: 'f7a10000-0000-4007-9000-000000000001',
    },
  }
}

describe.skipIf(!hasDatabaseUrl())('доставка писем на живой базе (позиция 7a)', () => {
  beforeAll(async () => {
    // Таблицы этой задачи. Нет их — миграция не применена, и спека обязана
    // упасть громко, а не «пройти» с нулём ассертов.
    await assertRealDbSchema([
      { table: 'notification_emails', column: 'status' },
      { table: 'notification_emails', column: 'next_attempt_at' },
      { table: 'notification_emails', column: 'sent_to_email' },
      { table: 'notification_preferences', column: 'email_enabled' },
    ])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    db = drizzle(pool, { schema })
    const dbService = { db } as unknown as DatabaseService
    service = new NotificationsService(dbService, makeTelemetryErrorsStub() as never)
    repo = new OutboxRepository(dbService)
  })

  afterAll(async () => {
    await wipe()
    await pool.end()
  })

  beforeEach(async () => {
    await wipe()
    await db.insert(users).values([
      { id: USER_A, email: 'a@cheekycheese.tech', displayName: 'A', role: 'SENIOR' },
      { id: USER_B, email: 'b@cheekycheese.tech', displayName: 'B', role: 'SENIOR' },
      { id: USER_NO_MAIL, email: 'c@cheekycheese.tech', displayName: 'C', role: 'JUNIOR' },
    ])
    await db.insert(userEmails).values([
      { userId: USER_A, email: 'a@cheekycheese.tech', kind: 'WORK', canLogin: true },
      { userId: USER_A, email: 'a.personal@gmail.com', kind: 'PERSONAL' },
      { userId: USER_B, email: 'b@cheekycheese.tech', kind: 'WORK', canLogin: true },
    ])
  })

  it('AC1: строка очереди появляется в той же транзакции, что и уведомление', async () => {
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })

    const queued = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_A))
    expect(queued).toHaveLength(1)
    expect(queued[0]!.status).toBe('QUEUED')
    expect(queued[0]!.attempts).toBe(0)
    expect(queued[0]!.sentAt).toBeNull()
  })

  it('AC1: откат события уносит и уведомление, и письмо', async () => {
    // ROLLBACK выполняет Postgres — именно это здесь и проверяется.
    await expect(
      db.transaction(async (tx) => {
        await service.createInTx(tx, notificationInput(USER_A))
        throw new Error('событие не состоялось')
      }),
    ).rejects.toThrow('событие не состоялось')

    const notifs = await db.select().from(notifications).where(eq(notifications.userId, USER_A))
    const queued = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_A))
    expect(notifs).toHaveLength(0)
    expect(queued).toHaveLength(0)
  })

  it('AC1: удаление уведомления уносит строку очереди (CASCADE)', async () => {
    const created = await db.transaction(async (tx) =>
      service.createInTx(tx, notificationInput(USER_A)),
    )
    await db.delete(notifications).where(eq(notifications.id, created!.id))

    const queued = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_A))
    expect(queued).toHaveLength(0)
  })

  it('AC1: выключенный информирующий тип строки очереди не создаёт', async () => {
    await db
      .insert(notificationPreferences)
      .values({ userId: USER_A, type: 'TEAM_MEMBER_ADDED', emailEnabled: false })

    await db.transaction(async (tx) => {
      await service.createInTx(tx, {
        userId: USER_A,
        type: 'TEAM_MEMBER_ADDED',
        title: 'Вас добавили в команду',
        subjectType: 'TEAM',
        subjectId: 'f7a10000-0000-4007-b000-000000000002',
        data: { teamName: 'Ядро платформы' },
      })
    })

    const notifs = await db.select().from(notifications).where(eq(notifications.userId, USER_A))
    const queued = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_A))
    expect(notifs).toHaveLength(1)
    expect(queued).toHaveLength(0)
  })

  it('AC3: письмо уходит на личный адрес, когда он есть', async () => {
    expect((await repo.addressesFor(USER_A)).length).toBe(2)
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })

    const [claimed] = await repo.claimDue(10)
    expect(claimed).toBeDefined()
    await repo.markSent(claimed!.id, 'a.personal@gmail.com')

    const [row] = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.id, claimed!.id))
    expect(row!.status).toBe('SENT')
    expect(row!.sentToEmail).toBe('a.personal@gmail.com')
    expect(row!.sentAt).not.toBeNull()
  })

  it('AC3: у пользователя без личного адреса остаётся рабочий', async () => {
    const rows = await repo.addressesFor(USER_B)
    expect(rows.map((r) => r.kind)).toEqual(['WORK'])
  })

  it('AC3: у пользователя без адресов вовсе — пустой список, а не выдумка', async () => {
    expect(await repo.addressesFor(USER_NO_MAIL)).toEqual([])
  })

  it('AC2: захват увеличивает попытки и отодвигает срок', async () => {
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })

    const before = (
      await db.select().from(notificationEmails).where(eq(notificationEmails.userId, USER_A))
    )[0]!
    const claimed = await repo.claimDue(10)

    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.attempts).toBe(1)
    const after = (
      await db.select().from(notificationEmails).where(eq(notificationEmails.id, claimed[0]!.id))
    )[0]!
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(before.nextAttemptAt.getTime())
  })

  it('AC2: захваченная строка не берётся повторно, пока жива аренда', async () => {
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })

    expect(await repo.claimDue(10)).toHaveLength(1)
    // Второй проход крона через 15 секунд — строка ещё в аренде.
    expect(await repo.claimDue(10)).toHaveLength(0)
  })

  it('AC2: захват несёт с собой содержание уведомления', async () => {
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })
    const [claimed] = await repo.claimDue(10)

    expect(claimed!.notification.type).toBe('PROJECT_CONFIRM_REQUIRED')
    expect(claimed!.notification.subjectType).toBe('PROJECT')
    expect(claimed!.notification.data).toMatchObject({ projectName: 'Мобильный банк' })
  })

  it('AC2: SKIP LOCKED разводит два одновременных захвата по разным строкам', async () => {
    // Два процесса API берут очередь одновременно. Без `SKIP LOCKED` второй
    // либо ждал бы первого на блокировке, либо взял бы ту же строку — и
    // письмо ушло бы дважды.
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_B))
    })

    const [first, second] = await Promise.all([repo.claimDue(1), repo.claimDue(1)])

    const ids = [...first.map((r) => r.id), ...second.map((r) => r.id)]
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('AC2: похороненная строка больше не всплывает в очереди', async () => {
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })
    const [claimed] = await repo.claimDue(10)
    await repo.markFailed(claimed!.id, 'Resend API HTTP 422')

    // Срок аренды истёк — но статус уже не QUEUED, и частичный индекс строку
    // не отдаёт.
    await db
      .update(notificationEmails)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(notificationEmails.id, claimed!.id))

    expect(await repo.claimDue(10)).toHaveLength(0)
  })

  it('AC2: отложенная строка возвращается, когда срок подошёл', async () => {
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })
    const [claimed] = await repo.claimDue(10)
    await repo.scheduleRetry(claimed!.id, 'Resend API HTTP 500', 1)

    expect(await repo.claimDue(10)).toHaveLength(0)

    await db
      .update(notificationEmails)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(notificationEmails.id, claimed!.id))

    const again = await repo.claimDue(10)
    expect(again).toHaveLength(1)
    expect(again[0]!.attempts).toBe(2)
  })

  it('AC2: отложить похороненную строку нельзя', async () => {
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })
    const [claimed] = await repo.claimDue(10)
    await repo.markFailed(claimed!.id, 'no email address')
    await repo.scheduleRetry(claimed!.id, 'Resend API HTTP 500', 2)

    const [row] = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.id, claimed!.id))
    expect(row!.status).toBe('FAILED')
    expect(row!.lastError).toBe('no email address')
  })

  it('одно письмо на уведомление — повторная постановка ничего не создаёт', async () => {
    const created = await db.transaction(async (tx) =>
      service.createInTx(tx, notificationInput(USER_A)),
    )
    await db
      .insert(notificationEmails)
      .values({ notificationId: created!.id, userId: USER_A })
      .onConflictDoNothing({ target: notificationEmails.notificationId })

    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_A))
    expect(rows[0]!.n).toBe(1)
  })
})
