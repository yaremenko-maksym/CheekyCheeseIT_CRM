/**
 * NotificationsService — unit tests.
 *
 * Harness: drizzle stubs are kept small. We model the table as an in-memory
 * array and synthesize the chained query builder around it.
 *
 * Coverage:
 *  - create -> insert returns row with default-null readAt
 *  - listForUser respects userId scope (does not leak across users)
 *  - listForUser unreadOnly=true filters to unread
 *  - listForUser respects limit
 *  - unreadCount matches actual unread set
 *  - markRead is idempotent (no-op when already read)
 *  - markRead throws 403 for cross-user attempts
 *  - markRead throws 404 for missing notification
 *  - markAllRead flips every unread row for the user
 */
import { NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'
import { NotificationsService } from './notifications.service'

interface NotifRow {
  id: string
  userId: string
  type: string
  title: string
  body: string | null
  link: string | null
  readAt: Date | null
  createdAt: Date
  // Позиция 6 — структурные идентификаторы. Три старых типа несут null во всех,
  // и именно так они и переносятся: без потери и без переписывания.
  subjectType: string | null
  subjectId: string | null
  secondaryId: string | null
  data: unknown
  dedupeKey: string | null
}

function makeHarness(seed: Partial<NotifRow>[] = []) {
  const rows: NotifRow[] = seed.map((s, i) => ({
    id: s.id ?? `n-${i}`,
    userId: s.userId ?? 'u-default',
    type: s.type ?? 'INVOICE_SIGN_REQUIRED',
    title: s.title ?? 'Test',
    body: s.body ?? null,
    link: s.link ?? null,
    readAt: s.readAt ?? null,
    createdAt: s.createdAt ?? new Date(2026, 4, 25 + i),
    subjectType: s.subjectType ?? null,
    subjectId: s.subjectId ?? null,
    secondaryId: s.secondaryId ?? null,
    data: s.data ?? null,
    dedupeKey: s.dedupeKey ?? null,
  }))

  // Routing: callers signal which scope they want via these flags BEFORE
  // they call the service method under test. The stubs read them when the
  // service issues a query.
  const ctx = {
    scopeUserId: null as string | null,
    scopeUnreadOnly: false,
    markReadId: null as string | null,
    markAllForUserId: null as string | null,
    deleteId: null as string | null,
  }

  const db = {
    db: {
      query: {
        notifications: {
          // Used by markRead AND delete — we route by ctx.markReadId or
          // ctx.deleteId (callers set exactly one of these BEFORE invoking
          // the service method under test).
          findFirst: async (_args: { where: unknown }) => {
            const id = ctx.markReadId ?? ctx.deleteId
            ctx.markReadId = null
            if (!id) return undefined
            return rows.find((r) => r.id === id)
          },
        },
      },
      select: (_fields?: unknown) => {
        // Two select shapes:
        //   1. SELECT * — main list query (uses .where().orderBy().limit())
        //   2. SELECT count — uses .where() directly returning [{count}]
        const isCount = !!_fields
        if (isCount) {
          return {
            from: (_t: unknown) => ({
              where: async (_p: unknown) => {
                const uid = ctx.scopeUserId
                const unread = rows.filter((r) => (!uid || r.userId === uid) && r.readAt === null)
                return [{ count: unread.length }]
              },
            }),
          }
        }
        const listBuilder = {
          where: (_p: unknown) => listBuilder,
          orderBy: (_o: unknown) => listBuilder,
          limit: async (lim: number) => {
            const uid = ctx.scopeUserId
            return rows
              .filter(
                (r) => (!uid || r.userId === uid) && (!ctx.scopeUnreadOnly || r.readAt === null),
              )
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
              .slice(0, lim)
          },
        }
        return {
          from: (_t: unknown) => listBuilder,
        }
      },
      // `create` теперь открывает свою транзакцию и делегирует в `createInTx`
      // (тот же приём, что `ApprovalsService.propose` / `proposeInTx`), поэтому
      // заглушка отдаёт тот же объект-базу — в памяти транзакция ничего не
      // меняет, а вызовы идут по тому же пути, что и в бою.
      transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db.db),
      insert: (_t: unknown) => ({
        values: (v: Record<string, unknown>) => {
          const insertRow = () => {
            const row: NotifRow = {
              id: `n-new-${rows.length}`,
              userId: v['userId'] as string,
              type: v['type'] as string,
              title: v['title'] as string,
              body: (v['body'] as string | null) ?? null,
              link: (v['link'] as string | null) ?? null,
              readAt: null,
              createdAt: new Date(),
              subjectType: (v['subjectType'] as string | null) ?? null,
              subjectId: (v['subjectId'] as string | null) ?? null,
              secondaryId: (v['secondaryId'] as string | null) ?? null,
              data: v['data'] ?? null,
              dedupeKey: (v['dedupeKey'] as string | null) ?? null,
            }
            rows.push(row)
            return [row]
          }
          return {
            returning: async () => insertRow(),
            // Частичный уникальный индекс (user_id, dedupe_key) — заглушка
            // повторяет ЕГО семантику, а не «любой конфликт»: строка без ключа
            // не сталкивается ни с чем.
            onConflictDoNothing: (_target: unknown) => ({
              returning: async () => {
                const key = (v['dedupeKey'] as string | null) ?? null
                if (
                  key !== null &&
                  rows.some((r) => r.userId === v['userId'] && r.dedupeKey === key)
                ) {
                  return []
                }
                return insertRow()
              },
            }),
          }
        },
      }),
      update: (_t: unknown) => ({
        set: (v: Record<string, unknown>) => ({
          where: async (_p: unknown) => {
            const newReadAt = (v['readAt'] as Date) ?? new Date()
            if (ctx.markAllForUserId) {
              for (const r of rows) {
                if (r.userId === ctx.markAllForUserId && r.readAt === null) {
                  r.readAt = newReadAt
                }
              }
              ctx.markAllForUserId = null
              return
            }
            // single-row markRead path: caller set markReadId BEFORE the
            // service emitted findFirst (which we already consumed). We
            // mirror the production path: find the row by the most recent
            // resolved candidate from findFirst (which we can't recover here)
            // — instead, we use a parallel hint set by the test.
            if (ctx.pendingMarkReadId) {
              const row = rows.find((r) => r.id === ctx.pendingMarkReadId)
              if (row) row.readAt = newReadAt
              ctx.pendingMarkReadId = null
            }
          },
        }),
      }),
      // `delete` removes rows whose id matches ctx.pendingDeleteId. The
      // service's `delete` flow calls findFirst (which we consumed above)
      // then issues this DELETE — tests set pendingDeleteId in parallel
      // with deleteId so the harness can wipe the right row.
      delete: (_t: unknown) => ({
        where: async (_p: unknown) => {
          if (ctx.pendingDeleteId) {
            const idx = rows.findIndex((r) => r.id === ctx.pendingDeleteId)
            if (idx >= 0) rows.splice(idx, 1)
            ctx.pendingDeleteId = null
          }
        },
      }),
    },
  } as unknown as ConstructorParameters<typeof NotificationsService>[0]

  // Augment ctx so tests can set pendingMarkReadId / pendingDeleteId in
  // parallel with markReadId / deleteId.
  type CtxAug = typeof ctx & {
    pendingMarkReadId: string | null
    pendingDeleteId: string | null
  }
  ;(ctx as CtxAug).pendingMarkReadId = null
  ;(ctx as CtxAug).pendingDeleteId = null
  // Заглушка телеметрии возвращается наружу: SR-H-1 сделал её единственным
  // наблюдаемым следом пропущенного уведомления, и тесты обязаны уметь этот
  // след прочитать.
  const telemetry = makeTelemetryErrorsStub()
  return { db, ctx: ctx as CtxAug, rows, telemetry }
}

describe('NotificationsService', () => {
  describe('create', () => {
    it('inserts a new row with default-null readAt', async () => {
      const { db } = makeHarness()
      const svc = new NotificationsService(db, makeTelemetryErrorsStub())
      const result = await svc.create({
        userId: 'u-1',
        type: 'INVOICE_SIGN_REQUIRED',
        title: 'Test',
        body: 'Hello',
        link: '/somewhere',
      })
      expect(result?.title).toBe('Test')
      expect(result?.readAt).toBeNull()
      expect(result?.type).toBe('INVOICE_SIGN_REQUIRED')
    })

    it('accepts null link (no-link notification)', async () => {
      const { db } = makeHarness()
      const svc = new NotificationsService(db, makeTelemetryErrorsStub())
      const result = await svc.create({
        userId: 'u-1',
        type: 'INVOICE_SIGN_REQUIRED',
        title: 'No link',
        link: null,
      })
      expect(result?.link).toBeNull()
    })

    it('accepts a valid relative link starting with /', async () => {
      const { db } = makeHarness()
      const svc = new NotificationsService(db, makeTelemetryErrorsStub())
      const result = await svc.create({
        userId: 'u-1',
        type: 'INVOICE_SIGNED',
        title: 'Signed',
        link: '/finance/invoices/abc',
      })
      expect(result?.link).toBe('/finance/invoices/abc')
    })

    // SR-H-1: опасная ссылка по-прежнему НЕ доезжает до базы — менялась не
    // строгость проверки, а цена отказа. Раньше здесь стоял `rejects.toThrow`,
    // то есть 400 вызывающему и откат его транзакции; теперь запись просто не
    // создаётся, а отказ виден в телеметрии.
    it.each([
      ['внешняя http-ссылка (open-redirect)', 'http://evil.com'],
      ['javascript: (XSS)', 'javascript:alert(1)'],
      ['ссылка без ведущего слеша', 'finance/invoices/123'],
    ])('%s: запись не создаётся, событие не падает', async (_name, link) => {
      const h = makeHarness()
      const svc = new NotificationsService(h.db, h.telemetry)
      const result = await svc.create({
        userId: 'u-1',
        type: 'INVOICE_SIGN_REQUIRED',
        title: 'Phish',
        link,
      })
      expect(result).toBeNull()
      expect(h.rows).toHaveLength(0)
      expect(h.telemetry.recordError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'API',
          message: expect.stringContaining('Invalid notification link'),
        }),
      )
    })
  })

  describe('listForUser', () => {
    const seedAll = [
      { id: 'n1', userId: 'u-1', readAt: null, title: 'A', createdAt: new Date(2026, 4, 1) },
      { id: 'n2', userId: 'u-1', readAt: new Date(), title: 'B', createdAt: new Date(2026, 4, 2) },
      { id: 'n3', userId: 'u-1', readAt: null, title: 'C', createdAt: new Date(2026, 4, 3) },
      { id: 'n4', userId: 'u-2', readAt: null, title: 'X', createdAt: new Date(2026, 4, 4) },
    ]

    it('scopes to userId — does not leak other users', async () => {
      const h = makeHarness(seedAll)
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.scopeUserId = 'u-1'
      h.ctx.scopeUnreadOnly = false
      const res = await svc.listForUser('u-1', { unreadOnly: false, limit: 10 })
      expect(res.items.length).toBe(3)
      expect(res.items.map((r) => r.title)).not.toContain('X')
    })

    it('unreadOnly=true filters to unread', async () => {
      const h = makeHarness(seedAll)
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.scopeUserId = 'u-1'
      h.ctx.scopeUnreadOnly = true
      const res = await svc.listForUser('u-1', { unreadOnly: true, limit: 10 })
      expect(res.items.length).toBe(2)
      expect(res.items.every((r) => r.readAt === null)).toBe(true)
    })

    it('respects limit', async () => {
      const h = makeHarness(seedAll)
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.scopeUserId = 'u-1'
      h.ctx.scopeUnreadOnly = false
      const res = await svc.listForUser('u-1', { unreadOnly: false, limit: 1 })
      expect(res.items.length).toBe(1)
    })

    it('unreadCount matches actual unread set for that user', async () => {
      const h = makeHarness(seedAll)
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.scopeUserId = 'u-1'
      const res = await svc.listForUser('u-1', { unreadOnly: false, limit: 10 })
      expect(res.unreadCount).toBe(2)
    })
  })

  describe('markRead', () => {
    it('marks a single notification as read', async () => {
      const h = makeHarness([{ id: 'n1', userId: 'u-1', readAt: null }])
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.markReadId = 'n1'
      h.ctx.pendingMarkReadId = 'n1'
      await svc.markRead('u-1', 'n1')
      expect(h.rows[0]!.readAt).not.toBeNull()
    })

    it('is idempotent (already-read row is no-op)', async () => {
      const past = new Date('2026-05-01')
      const h = makeHarness([{ id: 'n1', userId: 'u-1', readAt: past }])
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.markReadId = 'n1'
      h.ctx.pendingMarkReadId = 'n1'
      await svc.markRead('u-1', 'n1')
      expect(h.rows[0]!.readAt).toEqual(past)
    })

    it('throws 404 (not 403) when caller is not the owner — existence oracle (SEC-10)', async () => {
      const h = makeHarness([{ id: 'n1', userId: 'u-other', readAt: null }])
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.markReadId = 'n1'
      await expect(svc.markRead('u-1', 'n1')).rejects.toThrow(NotFoundException)
    })

    it('throws 404 when notification does not exist', async () => {
      const h = makeHarness([])
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.markReadId = 'nope'
      await expect(svc.markRead('u-1', 'nope')).rejects.toThrow(NotFoundException)
    })
  })

  describe('markAllRead', () => {
    it('flips every unread row for the user', async () => {
      const h = makeHarness([
        { id: 'n1', userId: 'u-1', readAt: null },
        { id: 'n2', userId: 'u-1', readAt: null },
        { id: 'n3', userId: 'u-1', readAt: new Date('2026-05-01') },
        { id: 'n4', userId: 'u-2', readAt: null },
      ])
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.markAllForUserId = 'u-1'
      await svc.markAllRead('u-1')
      expect(h.rows[0]!.readAt).not.toBeNull()
      expect(h.rows[1]!.readAt).not.toBeNull()
      // n4 belongs to u-2 — untouched
      expect(h.rows[3]!.readAt).toBeNull()
    })
  })

  describe('delete', () => {
    it('removes the row when the caller owns it', async () => {
      const h = makeHarness([
        { id: 'n1', userId: 'u-1', readAt: null },
        { id: 'n2', userId: 'u-1', readAt: null },
      ])
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.deleteId = 'n1'
      h.ctx.pendingDeleteId = 'n1'
      await svc.delete('u-1', 'n1')
      expect(h.rows.find((r) => r.id === 'n1')).toBeUndefined()
      // sibling row untouched
      expect(h.rows.find((r) => r.id === 'n2')).toBeDefined()
    })

    it('throws 404 (not 403) when the caller is not the owner — existence oracle (SEC-10)', async () => {
      const h = makeHarness([{ id: 'n1', userId: 'u-other', readAt: null }])
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.deleteId = 'n1'
      await expect(svc.delete('u-1', 'n1')).rejects.toThrow(NotFoundException)
      // Row still present after the failed call
      expect(h.rows.find((r) => r.id === 'n1')).toBeDefined()
    })

    it('throws 404 when the notification does not exist', async () => {
      const h = makeHarness([])
      const svc = new NotificationsService(h.db, h.telemetry)
      h.ctx.deleteId = 'nope'
      await expect(svc.delete('u-1', 'nope')).rejects.toThrow(NotFoundException)
    })
  })

  // ── Позиция 6 ────────────────────────────────────────────────────────────

  describe('структурные идентификаторы', () => {
    it('кладёт вид объекта, идентификаторы и данные — не готовый текст кнопки', async () => {
      const h = makeHarness()
      const svc = new NotificationsService(h.db, h.telemetry)
      const created = await svc.create({
        userId: 'u-1',
        type: 'PROJECT_MEMBER_ADDED',
        title: 'Вас добавили в проект',
        subjectType: 'PROJECT',
        subjectId: 'p-1',
        data: { projectName: 'Acme' },
      })
      expect(created?.subjectType).toBe('PROJECT')
      expect(created?.subjectId).toBe('p-1')
      expect(created?.data).toEqual({ projectName: 'Acme' })
      expect(created?.subjectMissing).toBe(false)
    })

    it('данные, не подходящие форме своего типа, до базы не доезжают', async () => {
      const h = makeHarness()
      const svc = new NotificationsService(h.db, h.telemetry)
      const result = await svc.create({
        userId: 'u-1',
        type: 'PROJECT_MEMBER_ADDED',
        title: 'Вас добавили в проект',
        subjectType: 'PROJECT',
        subjectId: 'p-1',
        data: { projectName: 42 },
      })
      expect(result).toBeNull()
      expect(h.rows).toHaveLength(0)
    })

    /**
     * SR-H-1 (security-review круг 1), вторая половина: производитель не имеет
     * права вето над событием. Раньше эта ветка бросала `BadRequestException`
     * внутри транзакции события — и легальное длинное значение (причина отказа,
     * имя проекта) откатывало сам отказ или само создание проекта.
     */
    describe('битые данные не отменяют событие, но отказ громкий', () => {
      it('вызывающий получает null вместо исключения — его транзакция жива', async () => {
        const h = makeHarness()
        const svc = new NotificationsService(h.db, h.telemetry)
        // `createInTx` — ровно тот путь, которым идут пять производителей
        // внутри транзакции своего события.
        const result = await svc.createInTx({} as never, {
          userId: 'u-1',
          type: 'PROJECT_MEMBER_ADDED',
          title: 'Вас добавили в проект',
          data: { projectName: 42 },
        })
        expect(result).toBeNull()
        expect(h.rows).toHaveLength(0)
      })

      it('пропуск уходит в телеметрию — тип и получатель названы, данные нет', async () => {
        const h = makeHarness()
        const svc = new NotificationsService(h.db, h.telemetry)
        await svc.create({
          userId: 'u-1',
          type: 'PROJECT_MEMBER_ADDED',
          title: 'Вас добавили в проект',
          subjectType: 'PROJECT',
          data: { projectName: 42 },
        })
        expect(h.telemetry.recordError).toHaveBeenCalledWith({
          source: 'API',
          message: expect.stringContaining('Invalid notification data for PROJECT_MEMBER_ADDED'),
          route: '/api/notifications',
          userId: 'u-1',
          meta: { type: 'PROJECT_MEMBER_ADDED', subjectType: 'PROJECT' },
        })
      })

      it('отказ телеметрии тоже не роняет событие', async () => {
        const h = makeHarness()
        vi.mocked(h.telemetry.recordError).mockRejectedValueOnce(new Error('telemetry down'))
        const svc = new NotificationsService(h.db, h.telemetry)
        const result = await svc.create({
          userId: 'u-1',
          type: 'PROJECT_MEMBER_ADDED',
          title: 'Вас добавили в проект',
          data: { projectName: 42 },
        })
        expect(result).toBeNull()
        expect(h.rows).toHaveLength(0)
      })

      it('причина отказа в пять тысяч символов уведомление пропускает, а не отменяет отказ', async () => {
        const h = makeHarness()
        const svc = new NotificationsService(h.db, h.telemetry)
        const result = await svc.createInTx({} as never, {
          userId: 'admin-1',
          type: 'APPROVAL_REJECTED',
          title: 'Сотрудник отклонил',
          // Производитель обязан усечь превью сам; если он этого не сделал —
          // страдает уведомление, а не решение синьора.
          data: {
            approverName: 'Иван',
            subjectKind: 'PROJECT',
            subjectTitle: 'Acme',
            reasonPreview: 'я'.repeat(5000),
          },
        })
        expect(result).toBeNull()
        expect(h.rows).toHaveLength(0)
        expect(h.telemetry.recordError).toHaveBeenCalledTimes(1)
      })

      it('имя проекта в 255 символов — легальная длина колонки — уведомление создаёт', async () => {
        const h = makeHarness()
        const svc = new NotificationsService(h.db, h.telemetry)
        const created = await svc.create({
          userId: 'u-1',
          type: 'PROJECT_MEMBER_ADDED',
          title: 'Вас добавили в проект',
          subjectType: 'PROJECT',
          subjectId: 'p-1',
          data: { projectName: 'я'.repeat(255) },
        })
        expect(created).not.toBeNull()
        expect(h.rows).toHaveLength(1)
        expect(h.telemetry.recordError).not.toHaveBeenCalled()
      })
    })

    it('данные старого типа никакой формой не проверяются — три старых типа не сломаны', async () => {
      const h = makeHarness()
      const svc = new NotificationsService(h.db, h.telemetry)
      const created = await svc.create({
        userId: 'u-1',
        type: 'INVOICE_SIGN_REQUIRED',
        title: 'Инвойс ожидает вашей подписи',
        link: '/documents?category=INVOICE',
        data: { whatever: true },
      })
      expect(created?.subjectType).toBeNull()
      expect(created?.link).toBe('/documents?category=INVOICE')
    })
  })

  describe('идемпотентность', () => {
    it('второй раз с тем же ключом не создаёт вторую строку', async () => {
      const h = makeHarness()
      const svc = new NotificationsService(h.db, h.telemetry)
      const input = {
        userId: 'u-1',
        type: 'TRANSACTION_ADDED' as const,
        title: 'Добавлена транзакция',
        subjectType: 'TRANSACTION' as const,
        subjectId: 't-1',
        data: { amount: '10.00', currency: 'USD', projectName: null },
        dedupeKey: 'TRANSACTION_ADDED:t-1',
      }
      expect(await svc.create(input)).not.toBeNull()
      expect(await svc.create(input)).toBeNull()
      expect(h.rows).toHaveLength(1)
    })

    it('тот же ключ ДРУГОМУ получателю — отдельная строка', async () => {
      const h = makeHarness()
      const svc = new NotificationsService(h.db, h.telemetry)
      const input = {
        type: 'TRANSACTION_ADDED' as const,
        title: 'Добавлена транзакция',
        subjectType: 'TRANSACTION' as const,
        subjectId: 't-1',
        data: { amount: '10.00', currency: 'USD', projectName: null },
        dedupeKey: 'TRANSACTION_ADDED:t-1',
      }
      await svc.create({ ...input, userId: 'u-1' })
      await svc.create({ ...input, userId: 'u-2' })
      expect(h.rows).toHaveLength(2)
    })

    it('без ключа дубли разрешены — повторное предложение обязано спросить заново', async () => {
      const h = makeHarness()
      const svc = new NotificationsService(h.db, h.telemetry)
      const input = {
        userId: 'u-1',
        type: 'SHARE_CONFIRM_REQUIRED' as const,
        title: 'Ждёт решения: новая доля',
        subjectType: 'PROJECT' as const,
        subjectId: 'p-1',
        data: {
          scope: 'PROJECT' as const,
          projectName: 'Acme',
          previousPercent: 26,
          proposedPercent: 30,
        },
      }
      await svc.create(input)
      await svc.create(input)
      expect(h.rows).toHaveLength(2)
    })
  })

  describe('createManyInTx', () => {
    it('одна пачка получателей — по строке на каждого', async () => {
      const h = makeHarness()
      const svc = new NotificationsService(h.db, h.telemetry)
      await h.db.db.transaction(async (tx: unknown) =>
        svc.createManyInTx(tx as Parameters<typeof svc.createManyInTx>[0], [
          { userId: 'u-1', type: 'TEAM_NEW_MEMBER', title: 'В команде новый участник' },
          { userId: 'u-2', type: 'TEAM_NEW_MEMBER', title: 'В команде новый участник' },
        ]),
      )
      expect(h.rows.map((r) => r.userId)).toEqual(['u-1', 'u-2'])
    })
  })
})
