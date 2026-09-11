import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { ApprovalsService } from '../approvals/approvals.service'
import { NotificationsService } from './notifications.service'
import { approvals, notifications, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'

/**
 * SR-H-2 / SR-M-3 (security-review круг 2) — уведомление не имеет права вето
 * над событием ДАЖЕ тогда, когда отказ приходит от самой базы.
 *
 * Почему это нельзя проверить двойником. Ошибка Postgres внутри транзакции
 * АБОРТИРУЕТ её целиком: перехват в JS не воскрешает транзакцию, и любой
 * следующий запрос падает с «current transaction is aborted, commands ignored
 * until end of transaction block». Проверено исполнением на этой же базе
 * (PostgreSQL 16.14) до написания теста:
 *
 *   INSERT REJECTED: invalid input syntax for type json
 *   tx aborted: current transaction is aborted, …
 *
 * Двойник этого не воспроизводит — у него нет транзакции, которую можно
 * абортировать, — поэтому единственная честная проверка савепойнта живёт
 * здесь, на живом Postgres.
 *
 * Порча payload вносится НАМЕРЕННО (одинокий суррогат в `data`): после
 * SR-M-3 усечение по код-поинтам больше не порождает его само, а проверяемый
 * инвариант — не «как именно payload испортился», а «отказ базы на вставке
 * уведомления не уносит с собой само событие». `JSON.stringify` кодирует
 * одинокий суррогат escape-последовательностью `\\ud83d`, и её отвергает уже
 * парсер `jsonb` — то есть ошибка прилетает из `INSERT`, за контуром
 * `safeParse`, который круг 1 обезвредил.
 *
 * Seed namespace: d9c8b7a6-1e2f-4a3b-** (отдельный от остальных спек).
 *
 * DB-SKIP-GUARD: `describe.skipIf(!hasDatabaseUrl())` — без DATABASE_URL
 * спека помечается SKIPPED; недостижимая база роняет `beforeAll` (FAILED).
 * Пройти с нулём ассертов она не может ни в одном из двух случаев.
 */

const LONE_SURROGATE = '\ud83d'

const PROPOSER_ID = 'd9c8b7a6-1e2f-4a3b-aa00-000000000001'
const APPROVER_ID = 'd9c8b7a6-1e2f-4a3b-aa00-000000000002'
const SUBJECT_ID = 'd9c8b7a6-1e2f-4a3b-bb00-000000000010'
const TEST_USER_IDS = [PROPOSER_ID, APPROVER_ID]

describe.skipIf(!hasDatabaseUrl())(
  'SR-H-2 — отказ базы на уведомлении не откатывает событие',
  () => {
    let pool: Pool
    let dbSvc: DatabaseService

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[producer-veto integration] FAILED — no DB reachable at DATABASE_URL')
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })
      const db = drizzle(pool, { schema })
      dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })

      await db
        .insert(users)
        .values([
          {
            id: PROPOSER_ID,
            email: 'pv-proposer@test.spec',
            displayName: 'PV Proposer',
            role: 'ADMIN',
            googleId: `test-pv-${PROPOSER_ID}`,
          },
          {
            id: APPROVER_ID,
            email: 'pv-approver@test.spec',
            displayName: 'PV Approver',
            role: 'SENIOR',
            googleId: `test-pv-${APPROVER_ID}`,
          },
        ])
        .onConflictDoNothing()
    }, 30_000)

    beforeEach(async () => {
      await dbSvc.db.delete(notifications).where(inArray(notifications.userId, TEST_USER_IDS))
      await dbSvc.db.delete(approvals).where(inArray(approvals.proposedByUserId, TEST_USER_IDS))
    })

    afterAll(async () => {
      try {
        await dbSvc.db.delete(notifications).where(inArray(notifications.userId, TEST_USER_IDS))
        await dbSvc.db.delete(approvals).where(inArray(approvals.proposedByUserId, TEST_USER_IDS))
        await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // non-fatal cleanup
      }
      await pool.end()
    })

    /** Реальный сервис уведомлений с заглушенным журналом: отказ здесь ожидаем. */
    function makeQuietNotifications(): NotificationsService {
      const svc = new NotificationsService(dbSvc, makeTelemetryErrorsStub())
      vi.spyOn(
        (svc as unknown as { logger: { error: (m: string) => void } }).logger,
        'error',
      ).mockImplementation(() => {})
      return svc
    }

    async function openProposal(approvalsSvc: ApprovalsService): Promise<void> {
      await approvalsSvc.propose({
        subjectType: 'PROJECT',
        subjectId: SUBJECT_ID,
        approverUserIds: [APPROVER_ID],
        proposedByUserId: PROPOSER_ID,
      })
    }

    it('payload, который Postgres отвергает, не отменяет отказ согласования', async () => {
      const notificationsSvc = makeQuietNotifications()
      const approvalsSvc = new ApprovalsService(dbSvc, notificationsSvc)
      await openProposal(approvalsSvc)

      // Порча ровно на границе с базой: форма данных её пропускает (длина в
      // символах в норме), а парсер `jsonb` — нет.
      const original = notificationsSvc.createInTx.bind(notificationsSvc)
      vi.spyOn(notificationsSvc, 'createInTx').mockImplementation((tx, input) =>
        original(tx, {
          ...input,
          data: {
            ...(input.data as Record<string, unknown>),
            approverName: `Иван${LONE_SURROGATE}`,
          },
        }),
      )

      await expect(
        approvalsSvc.reject({
          subjectType: 'PROJECT',
          subjectId: SUBJECT_ID,
          approverUserId: APPROVER_ID,
          reason: 'не подходит',
        }),
      ).resolves.toMatchObject({ status: 'REJECTED' })

      // Главное: отказ ЗАКОММИЧЕН. До савепойнта ошибка `jsonb` абортировала
      // транзакцию отказа целиком — синьор не мог отклонить, и клиент получал
      // 500.
      const [row] = await dbSvc.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.subjectId, SUBJECT_ID), eq(approvals.approverUserId, APPROVER_ID)))
      expect(row?.status).toBe('REJECTED')
      expect(row?.rejectionReason).toBe('не подходит')

      // Потерялось РОВНО уведомление — и ничего сверх него.
      const notifRows = await dbSvc.db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, PROPOSER_ID))
      expect(notifRows).toHaveLength(0)
    })

    it('контроль: без порчи payload тот же путь пишет уведомление', async () => {
      const notificationsSvc = makeQuietNotifications()
      const approvalsSvc = new ApprovalsService(dbSvc, notificationsSvc)
      await openProposal(approvalsSvc)

      await approvalsSvc.reject({
        subjectType: 'PROJECT',
        subjectId: SUBJECT_ID,
        approverUserId: APPROVER_ID,
        reason: 'не подходит',
      })

      // Без этого теста предыдущий доказывал бы только то, что уведомлений
      // тут не бывает вовсе.
      const notifRows = await dbSvc.db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, PROPOSER_ID))
      expect(notifRows).toHaveLength(1)
      expect(notifRows[0]?.type).toBe('APPROVAL_REJECTED')
    })
  },
)
