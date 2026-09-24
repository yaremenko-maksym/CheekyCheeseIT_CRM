import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { NotificationsService } from './notifications.service'
import { decideDelivery } from './notification-email-outbox'
import { NotificationEmailCronService } from './notification-email.cron'
import { OutboxRepository } from './notification-email.repository'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import {
  approvals,
  notificationEmails,
  notificationPreferences,
  notifications,
  projects,
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
/** Уволенный: строка `users` жива, `archived_at` заполнен, личный адрес на месте. */
const USER_ARCHIVED = 'f7a10000-0000-4007-a000-000000000004'
const ALL_USERS = [USER_A, USER_B, USER_NO_MAIL, USER_ARCHIVED]

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

/**
 * Соседние спеки тоже кладут письма в очередь — таблица одна на всю базу, а
 * захват по построению ГЛОБАЛЬНЫЙ (крон ничего не знает про наших
 * пользователей). Поэтому утверждения — про НАШУ строку, а не про размер
 * пачки. Первый полный прогон интеграционной сьюты это и показал: два теста,
 * зелёные в одиночку, покраснели в общем прогоне.
 *
 * Захват чужих строк безвреден: единственная спека, которая вообще смотрит на
 * `notification_emails`, — эта; остальные уведомления только создают.
 */
const CLAIM_BATCH = 100

/** Положить письмо в очередь и вернуть id его строки. */
async function queueFor(userId: string): Promise<string> {
  await db.transaction(async (tx) => {
    await service.createInTx(tx, notificationInput(userId))
  })
  const [row] = await db
    .select({ id: notificationEmails.id })
    .from(notificationEmails)
    .where(eq(notificationEmails.userId, userId))
  if (!row) throw new Error(`письмо для ${userId} не встало в очередь`)
  return row.id
}

/** Захватывать, пока в пачке не окажется наша строка. */
async function claimUntilFound(id: string) {
  for (let pass = 0; pass < 10; pass++) {
    const batch = await repo.claimDue(CLAIM_BATCH)
    const mine = batch.find((r) => r.id === id)
    if (mine) return mine
    if (batch.length === 0) break
  }
  throw new Error(`строка ${id} не попала ни в одну пачку захвата`)
}

/** Наша строка очередью НЕ отдаётся — сколько бы проходов ни сделали. */
async function expectNotClaimable(id: string): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    const batch = await repo.claimDue(CLAIM_BATCH)
    expect(batch.map((r) => r.id)).not.toContain(id)
    if (batch.length === 0) return
  }
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

/** Информирующий тип — письмо по нему МОЖНО выключить настройкой. */
function teamNotificationInput(userId: string) {
  return {
    userId,
    type: 'TEAM_MEMBER_ADDED' as const,
    title: 'Вас добавили в команду',
    subjectType: 'TEAM' as const,
    subjectId: 'f7a10000-0000-4007-b000-000000000002',
    data: { teamName: 'Ядро платформы' },
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
      { table: 'notification_emails', column: 'skip_reason' },
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
      {
        id: USER_ARCHIVED,
        email: 'd@cheekycheese.tech',
        displayName: 'D',
        role: 'SENIOR',
        // Именно так выглядит увольнение в этой базе: строка остаётся, доступ
        // отзывает `JwtAuthGuard`. Письмо — единственный канал, который до
        // такого человека ещё ДОХОДИТ, поэтому его и надо закрыть (SR-H-1).
        archivedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ])
    await db.insert(userEmails).values([
      { userId: USER_A, email: 'a@cheekycheese.tech', kind: 'WORK', canLogin: true },
      { userId: USER_A, email: 'a.personal@gmail.com', kind: 'PERSONAL' },
      { userId: USER_B, email: 'b@cheekycheese.tech', kind: 'WORK', canLogin: true },
      { userId: USER_ARCHIVED, email: 'd.personal@gmail.com', kind: 'PERSONAL' },
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

  it('AC6: выключенный тип всё равно встаёт в очередь — решает отправка', async () => {
    // SPEC-H-2: круг 1 не создавал строку вовсе, и человек, включивший канал
    // между событием и отправкой, письма уже не получал — строки не было и
    // появиться ей было негде.
    await db
      .insert(notificationPreferences)
      .values({ userId: USER_A, type: 'TEAM_MEMBER_ADDED', emailEnabled: false })

    await db.transaction(async (tx) => {
      await service.createInTx(tx, teamNotificationInput(USER_A))
    })

    const notifs = await db.select().from(notifications).where(eq(notifications.userId, USER_A))
    const queued = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_A))
    expect(notifs).toHaveLength(1)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.status).toBe('QUEUED')
    expect(queued[0]!.skipReason).toBeNull()
  })

  it('AC6: настройка, выключенная ПОСЛЕ постановки, останавливает письмо', async () => {
    // Ровно то окно, на которое указывал SR-M-2: между событием и отправкой
    // проходит до пятнадцати секунд, а при ретраях — часы.
    await db.transaction(async (tx) => {
      await service.createInTx(tx, teamNotificationInput(USER_A))
    })
    const [row] = await db
      .select({ id: notificationEmails.id })
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_A))

    // Человек выключил канал уже после того, как письмо встало в очередь.
    await db
      .insert(notificationPreferences)
      .values({ userId: USER_A, type: 'TEAM_MEMBER_ADDED', emailEnabled: false })

    const context = await repo.deliveryContextFor(USER_A, 'TEAM_MEMBER_ADDED')
    expect(context.emailEnabled).toBe(false)
    expect(decideDelivery('TEAM_MEMBER_ADDED', context)).toEqual({
      send: false,
      skipReason: 'CHANNEL_OFF',
    })

    await repo.markSkipped(row!.id, 'CHANNEL_OFF')
    const [after] = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.id, row!.id))
    expect(after!.status).toBe('SKIPPED')
    expect(after!.skipReason).toBe('CHANNEL_OFF')
    // Ошибки не было — `last_error` обязан остаться пустым, иначе «не
    // полагалось отправлять» снова станет похоже на сбой.
    expect(after!.lastError).toBeNull()
    // И строка больше не всплывает: частичный индекс отдаёт только `QUEUED`.
    await expectNotClaimable(row!.id)
  })

  it('AC6: настройка «выключено» у запертого типа письмо не останавливает', async () => {
    await db
      .insert(notificationPreferences)
      .values({ userId: USER_A, type: 'PROJECT_CONFIRM_REQUIRED', emailEnabled: false })

    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })

    const context = await repo.deliveryContextFor(USER_A, 'PROJECT_CONFIRM_REQUIRED')
    expect(context.emailEnabled).toBe(false)
    // SR-L-1: subjectState обязателен для action-required типа —
    // этот тест проверяет запертый канал, а не устаревание, поэтому объект
    // явно живой.
    expect(
      decideDelivery('PROJECT_CONFIRM_REQUIRED', { ...context, subjectState: 'active' }),
    ).toEqual({
      send: true,
      to: 'a.personal@gmail.com',
    })
  })

  it('AC3: архивированному получателю строка заводится сразу SKIPPED/USER_ARCHIVED', async () => {
    // SR-H-1, первая половина гварда — на постановке. Проверяется на ЖИВОЙ
    // базе, потому что `archived_at` читает запрос, а не мок.
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_ARCHIVED))
    })

    const queued = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_ARCHIVED))
    expect(queued).toHaveLength(1)
    expect(queued[0]!.status).toBe('SKIPPED')
    expect(queued[0]!.skipReason).toBe('USER_ARCHIVED')
    // Крону такая строка не достаётся вовсе.
    await expectNotClaimable(queued[0]!.id)
  })

  it('AC3: архив ПОСЛЕ постановки останавливает письмо на отправке', async () => {
    // Вторая половина гварда. Строка встала, когда человек был жив; уволили
    // его, пока она ждала своей очереди (или пятого ретрая — это часы).
    const id = await queueFor(USER_A)
    await db
      .update(users)
      .set({ archivedAt: new Date('2026-09-01T00:00:00Z') })
      .where(eq(users.id, USER_A))

    const context = await repo.deliveryContextFor(USER_A, 'PROJECT_CONFIRM_REQUIRED')
    expect(context.archived).toBe(true)
    // Адрес при этом на месте — то есть письмо ушло бы, если бы решение
    // смотрело только на адреса.
    expect(context.addresses.length).toBe(2)
    expect(decideDelivery('PROJECT_CONFIRM_REQUIRED', context)).toEqual({
      send: false,
      skipReason: 'USER_ARCHIVED',
    })

    await repo.markSkipped(id, 'USER_ARCHIVED')
    const [after] = await db.select().from(notificationEmails).where(eq(notificationEmails.id, id))
    expect(after!.status).toBe('SKIPPED')
    expect(after!.skipReason).toBe('USER_ARCHIVED')
  })

  it('AC3: старому типу заводится строка SKIPPED/LEGACY_TYPE', async () => {
    // task-i18n-stage4-task6: `INVOICE_SIGN_REQUIRED` здесь раньше был
    // примером «старого типа без письма» — реестр его теперь регистрирует
    // (`NEW_NOTIFICATION_TYPES`), поэтому пример заменён вымышленным именем;
    // смысл теста (тип вне реестра) не завязан на конкретное имя.
    await db.transaction(async (tx) => {
      await service.createInTx(tx, {
        userId: USER_A,
        type: 'SOME_TYPE_OUTSIDE_THE_REGISTRY' as never,
        title: 'Тип вне реестра',
        link: '/finance/invoices/f7a10000-0000-4007-b000-000000000009',
      })
    })

    const queued = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.userId, USER_A))
    expect(queued).toHaveLength(1)
    expect(queued[0]!.status).toBe('SKIPPED')
    expect(queued[0]!.skipReason).toBe('LEGACY_TYPE')
  })

  it('AC3: письмо уходит на личный адрес, когда он есть', async () => {
    const context = await repo.deliveryContextFor(USER_A, 'PROJECT_CONFIRM_REQUIRED')
    expect(context.addresses.length).toBe(2)
    expect(context.archived).toBe(false)
    // SR-L-1: см. комментарий у соседнего теста «выключено» выше.
    expect(
      decideDelivery('PROJECT_CONFIRM_REQUIRED', { ...context, subjectState: 'active' }),
    ).toEqual({
      send: true,
      to: 'a.personal@gmail.com',
    })
    const id = await queueFor(USER_A)

    const claimed = await claimUntilFound(id)
    await repo.markSent(claimed.id, 'a.personal@gmail.com')

    const [row] = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.id, claimed.id))
    expect(row!.status).toBe('SENT')
    expect(row!.sentToEmail).toBe('a.personal@gmail.com')
    expect(row!.sentAt).not.toBeNull()
  })

  it('AC3: у пользователя без личного адреса остаётся рабочий', async () => {
    const context = await repo.deliveryContextFor(USER_B, 'PROJECT_CONFIRM_REQUIRED')
    expect(context.addresses.map((r) => r.kind)).toEqual(['WORK'])
    // SR-L-1: см. комментарий у соседнего теста «выключено» выше.
    expect(
      decideDelivery('PROJECT_CONFIRM_REQUIRED', { ...context, subjectState: 'active' }),
    ).toEqual({
      send: true,
      to: 'b@cheekycheese.tech',
    })
  })

  it('AC3: у пользователя без адресов вовсе — пустой список, а не выдумка', async () => {
    // LEFT JOIN, а не INNER: человек без адресов обязан вернуть контекст, в
    // котором «уволен» отличимо от «адреса нет». INNER JOIN вернул бы ноль
    // строк в обоих случаях, и `skip_reason` соврал бы про причину.
    const context = await repo.deliveryContextFor(USER_NO_MAIL, 'PROJECT_CONFIRM_REQUIRED')
    expect(context.addresses).toEqual([])
    expect(context.archived).toBe(false)
    // SR-L-1: см. комментарий у соседнего теста «выключено» выше.
    expect(
      decideDelivery('PROJECT_CONFIRM_REQUIRED', { ...context, subjectState: 'active' }),
    ).toEqual({
      send: false,
      skipReason: 'NO_ADDRESS',
    })
  })

  it('AC3: у архивированного контекст говорит «уволен», а не «нет адреса»', async () => {
    const context = await repo.deliveryContextFor(USER_ARCHIVED, 'PROJECT_CONFIRM_REQUIRED')
    expect(context.archived).toBe(true)
    expect(context.addresses.map((r) => r.email)).toEqual(['d.personal@gmail.com'])
  })

  it('AC2: захват увеличивает попытки и отодвигает срок', async () => {
    await db.transaction(async (tx) => {
      await service.createInTx(tx, notificationInput(USER_A))
    })

    const before = (
      await db.select().from(notificationEmails).where(eq(notificationEmails.userId, USER_A))
    )[0]!
    // Захват — операция ГЛОБАЛЬНАЯ (крон не знает про наших пользователей), а
    // на общей scratch-базе соседние спеки тоже кладут письма в очередь.
    // Поэтому утверждения — про НАШУ строку, а не про размер пачки: иначе
    // спека зелёная в одиночку и красная в общем прогоне (именно так она и
    // упала при первом полном прогоне интеграционной сьюты).
    const claimed = await claimUntilFound(before.id)

    expect(claimed.attempts).toBe(1)
    const after = (
      await db.select().from(notificationEmails).where(eq(notificationEmails.id, claimed.id))
    )[0]!
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(before.nextAttemptAt.getTime())
  })

  it('AC2: захваченная строка не берётся повторно, пока жива аренда', async () => {
    const id = await queueFor(USER_A)

    await claimUntilFound(id)
    // Второй проход крона через 15 секунд — строка ещё в аренде.
    await expectNotClaimable(id)
  })

  it('AC2: захват несёт с собой содержание уведомления', async () => {
    const id = await queueFor(USER_A)
    const claimed = await claimUntilFound(id)

    expect(claimed.notification.type).toBe('PROJECT_CONFIRM_REQUIRED')
    expect(claimed.notification.subjectType).toBe('PROJECT')
    expect(claimed.notification.data).toMatchObject({ projectName: 'Мобильный банк' })
  })

  it('AC2: SKIP LOCKED разводит два одновременных захвата по разным строкам', async () => {
    // Два процесса API берут очередь одновременно. Без `SKIP LOCKED` второй
    // либо ждал бы первого на блокировке, либо взял бы ту же строку — и
    // письмо ушло бы дважды.
    await queueFor(USER_A)
    await queueFor(USER_B)

    const [first, second] = await Promise.all([repo.claimDue(1), repo.claimDue(1)])

    const ids = [...first.map((r) => r.id), ...second.map((r) => r.id)]
    expect(ids).toHaveLength(2)
    // Главное утверждение: одна и та же строка не досталась обоим.
    expect(new Set(ids).size).toBe(2)
  })

  it('AC2: похороненная строка больше не всплывает в очереди', async () => {
    const id = await queueFor(USER_A)
    const claimed = await claimUntilFound(id)
    await repo.markFailed(claimed.id, 'Resend API HTTP 422')

    // Срок аренды истёк — но статус уже не QUEUED, и частичный индекс строку
    // не отдаёт.
    await db
      .update(notificationEmails)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(notificationEmails.id, claimed.id))

    await expectNotClaimable(id)
  })

  it('AC2: отложенная строка возвращается, когда срок подошёл', async () => {
    const id = await queueFor(USER_A)
    const claimed = await claimUntilFound(id)
    await repo.scheduleRetry(claimed.id, 'Resend API HTTP 500', 1)

    await expectNotClaimable(id)

    await db
      .update(notificationEmails)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(notificationEmails.id, claimed.id))

    const again = await claimUntilFound(id)
    expect(again.attempts).toBe(2)
  })

  it('AC2: отложить похороненную строку нельзя', async () => {
    const id = await queueFor(USER_A)
    const claimed = await claimUntilFound(id)
    await repo.markFailed(claimed.id, 'Resend API HTTP 422')
    await repo.scheduleRetry(claimed.id, 'Resend API HTTP 500', 2)

    const [row] = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.id, claimed.id))
    expect(row!.status).toBe('FAILED')
    expect(row!.lastError).toBe('Resend API HTTP 422')
  })

  it('поздний markSkipped после markSent не переписывает отправленную строку (SR-L-6)', async () => {
    // Аренда — 60 секунд, а пятиминутный байпас зависшего прохода (SR-L-4) на
    // короткое время может дать двум проходам одну и ту же строку. Без
    // `WHERE status = 'QUEUED'` второй, опоздавший `markSkipped` переписал бы
    // уже отправленную строку обратно в `SKIPPED`, оставив `sent_at` /
    // `sent_to_email` заполненными, — след доставки начал бы врать.
    const id = await queueFor(USER_A)
    const claimed = await claimUntilFound(id)
    await repo.markSent(claimed.id, 'a.personal@gmail.com')

    await repo.markSkipped(claimed.id, 'CHANNEL_OFF')

    const [row] = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.id, claimed.id))
    expect(row!.status).toBe('SENT')
    expect(row!.sentToEmail).toBe('a.personal@gmail.com')
    expect(row!.skipReason).toBeNull()
  })

  it('поздний markFailed после markSent не переписывает отправленную строку (SR-L-6)', async () => {
    const id = await queueFor(USER_A)
    const claimed = await claimUntilFound(id)
    await repo.markSent(claimed.id, 'a.personal@gmail.com')

    await repo.markFailed(claimed.id, 'Resend API HTTP 500')

    const [row] = await db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.id, claimed.id))
    expect(row!.status).toBe('SENT')
    expect(row!.lastError).toBeNull()
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

  /**
   * Бэклог 208, AC2 — «предложить долю → отозвать до тика → тик → строка
   * SKIPPED/STALE, `send` не вызван» на РЕАЛЬНОМ Postgres, гоняя настоящий
   * `NotificationEmailCronService.drainOnce()` через настоящий
   * `OutboxRepository` (только HTTP к провайдеру подменён — цена реального
   * письма в тесте не нужна). Юнит-спека крона доказывает решение через мок
   * шлюза; здесь — что `resolveSubjectState` реально читает
   * `approvals`/`projects` и что итоговая строка `notification_emails`
   * несёт `STALE`, а не что-то другое.
   *
   * Вложено в тот же `describe`, а не соседний top-level: `pool`/`db`
   * закрываются внешним `afterAll` ВЫШЕ — соседний блок стартовал бы уже
   * после `pool.end()`.
   */
  describe('бэклог 208: устаревшее согласование', () => {
    const PROJECT_ID = 'f7a20000-0000-4007-c000-000000000001'
    const LIVE_APPROVAL_ID = 'f7a20000-0000-4007-9000-000000000001'
    const SUPERSEDED_APPROVAL_ID = 'f7a20000-0000-4007-9000-000000000002'

    let cron: NotificationEmailCronService

    function shareNotificationInput(approvalId: string) {
      return {
        userId: USER_A,
        type: 'PROJECT_CONFIRM_REQUIRED' as const,
        title: 'Проект ждёт решения',
        subjectType: 'PROJECT' as const,
        subjectId: PROJECT_ID,
        data: { projectName: 'Мобильный банк', approvalId },
      }
    }

    beforeAll(() => {
      // Тот же способ создания, что `makeService` в
      // `notification-email.cron.spec.ts` (unit-мок мейлера) — но здесь он
      // получает НАСТОЯЩИЙ `repo`, а не мок шлюза, поэтому
      // `resolveSubjectState` реально ходит в Postgres.
      const mailer = {
        isConfigured: true,
        send: async () => undefined,
      }
      const config = {
        get: (key: string) =>
          key === 'FRONTEND_URL' ? 'https://app.cheekycheese.tech' : 'hr@cheekycheese.tech',
      }
      cron = new NotificationEmailCronService(
        repo,
        mailer as never,
        makeTelemetryErrorsStub() as never,
        config as never,
      )
    })

    beforeEach(async () => {
      await db.insert(projects).values({
        id: PROJECT_ID,
        name: 'Мобильный банк',
        companyName: 'Mobile Bank LLC',
        domain: 'FINTECH',
        startDate: new Date('2026-01-01'),
        seniorId: USER_A,
        rate: 100,
        status: 'ACTIVE',
      })
    })

    // `afterEach`, не `afterAll`: внешний `beforeEach` (см. выше в файле)
    // зовёт `wipe()` перед КАЖДЫМ тестом всего дерева, включая этот
    // вложенный `describe`, и `wipe()` удаляет `users` — что упало бы на
    // FK `approvals.approver_user_id`, если бы строка согласования
    // пережила свой тест.
    afterEach(async () => {
      await db
        .delete(approvals)
        .where(inArray(approvals.id, [LIVE_APPROVAL_ID, SUPERSEDED_APPROVAL_ID]))
      await db.delete(projects).where(eq(projects.id, PROJECT_ID))
    })

    it('контроль: живое предложение — SENT', async () => {
      await db.insert(approvals).values({
        id: LIVE_APPROVAL_ID,
        subjectType: 'PROJECT',
        subjectId: PROJECT_ID,
        approverUserId: USER_A,
        proposedByUserId: USER_B,
        status: 'PENDING',
        supersededAt: null,
      })
      let id = ''
      await db.transaction(async (tx) => {
        const created = await service.createInTx(tx, shareNotificationInput(LIVE_APPROVAL_ID))
        id = created!.id
      })
      const [row] = await db
        .select({ id: notificationEmails.id })
        .from(notificationEmails)
        .where(eq(notificationEmails.notificationId, id))

      // НЕ `claimUntilFound` — он сам захватывает строку (двигает
      // `next_attempt_at`), и `cron.drainOnce()` ниже уже не нашёл бы её:
      // `drainOnce` делает захват САМ, внутри себя.
      await cron.drainOnce()

      const [after] = await db
        .select()
        .from(notificationEmails)
        .where(eq(notificationEmails.id, row!.id))
      expect(after!.status).toBe('SENT')
    })

    it('предложение отозвали до тика — SKIPPED/STALE, письма нет', async () => {
      // "Отозвали" = supersededAt проставлен ДО того, как крон успел взять
      // строку — ровно то окно, которое AC2 требует проверить.
      await db.insert(approvals).values({
        id: SUPERSEDED_APPROVAL_ID,
        subjectType: 'PROJECT',
        subjectId: PROJECT_ID,
        approverUserId: USER_A,
        proposedByUserId: USER_B,
        status: 'PENDING',
        supersededAt: new Date(),
      })

      let id = ''
      await db.transaction(async (tx) => {
        const created = await service.createInTx(tx, shareNotificationInput(SUPERSEDED_APPROVAL_ID))
        id = created!.id
      })
      const [row] = await db
        .select({ id: notificationEmails.id })
        .from(notificationEmails)
        .where(eq(notificationEmails.notificationId, id))

      await cron.drainOnce()

      const [after] = await db
        .select()
        .from(notificationEmails)
        .where(eq(notificationEmails.id, row!.id))
      expect(after!.status).toBe('SKIPPED')
      expect(after!.skipReason).toBe('STALE')
    })
  })
})
