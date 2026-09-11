/**
 * task-notification-types-producers (позиция 6) — то, что сервис уведомлений
 * ГОВОРИТ базе, и то, что он из её ответа собирает.
 *
 * Отдельно от `notifications.service.spec.ts`, у которого заглушка отвечает
 * заранее заготовленным, не глядя на запрос. Такая заглушка проверяет исход, но
 * не различает «спросил правильно» и «спросил что попало»: пустая цель
 * `ON CONFLICT`, потерянное условие частичного индекса и не переданный
 * `secondaryId` выглядят для неё одинаково успешными. Здесь заглушка ведёт себя
 * как база — запросы маршрутизируются по таблице, вставка честно сталкивается с
 * уникальным ключом, — и поэтому каждая из этих потерь становится видимой.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'
import { NotificationsService } from './notifications.service'
import {
  approvals,
  employeeContracts,
  nonDeletedTransactions,
  notifications,
  projects,
  teams,
  users,
} from '../database/schema'

type Row = typeof notifications.$inferSelect

const NOW = new Date('2026-09-07T10:00:00.000Z')

type Existing = {
  projects?: string[]
  teams?: string[]
  users?: string[]
  transactions?: string[]
  contracts?: string[]
  approvals?: { subjectType: string; subjectId: string; approverUserId: string }[]
}

function makeRow(over: Partial<Row> = {}): Row {
  return {
    id: 'n-1',
    userId: 'u-1',
    type: 'PROJECT_MEMBER_ADDED',
    title: 'Вас добавили в проект',
    body: null,
    link: null,
    readAt: null,
    createdAt: NOW,
    subjectType: 'PROJECT',
    subjectId: 'p-1',
    secondaryId: null,
    data: { projectName: 'Acme' },
    dedupeKey: null,
    ...over,
  } as Row
}

function makeHarness(seed: Row[] = [], existing: Existing = {}, insertReturnsNothing = false) {
  const rows = [...seed]
  const insertValues: Record<string, unknown>[] = []
  const conflictArgs: Record<string, unknown>[] = []
  /** Таблицы, у которых сервис спрашивал про существование объектов. */
  const askedTables: string[] = []
  /** Условия отбора, с которыми пришли запросы про живость объектов. */
  const whereClauses: { table: string; sql: unknown }[] = []

  /**
   * Ответ содержит РОВНО запрошенные колонки, как и настоящая база. Без этого
   * «спросил идентификатор» и «не спросил ничего» дают один и тот же результат,
   * и пустой список колонок остаётся незамеченным до боя, где он вернул бы
   * строки без `id` — то есть «объект исчез» для всех подряд.
   */
  const pick = (fields: Record<string, unknown> | undefined, source: Record<string, unknown>) => {
    if (fields === undefined) return source
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(fields)) out[key] = source[key]
    return out
  }

  const rowsFor = (table: unknown, fields?: Record<string, unknown>): unknown[] => {
    if (table === notifications) {
      if (fields !== undefined && 'count' in fields) {
        return [{ count: rows.filter((r) => r.readAt === null).length }]
      }
      return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    }
    if (table === approvals) {
      askedTables.push('approvals')
      return (existing.approvals ?? []).map((a) => pick(fields, a as Record<string, unknown>))
    }
    const byTable: [unknown, string, string[] | undefined][] = [
      [projects, 'projects', existing.projects],
      [teams, 'teams', existing.teams],
      [users, 'users', existing.users],
      [nonDeletedTransactions, 'transactions', existing.transactions],
      [employeeContracts, 'contracts', existing.contracts],
    ]
    for (const [candidate, name, ids] of byTable) {
      if (table === candidate) {
        askedTables.push(name)
        return (ids ?? []).map((id) => pick(fields, { id }))
      }
    }
    throw new Error('заглушка не знает такой таблицы')
  }

  const tableName = (table: unknown): string => {
    if (table === approvals) return 'approvals'
    if (table === projects) return 'projects'
    if (table === notifications) return 'notifications'
    return 'other'
  }

  const db = {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const builder: Record<string, unknown> = {}
          builder['where'] = (clause: unknown) => {
            whereClauses.push({ table: tableName(table), sql: clause })
            return builder
          }
          builder['orderBy'] = () => builder
          builder['limit'] = async (n: number) => rowsFor(table, fields).slice(0, n)
          // Запрос про живые согласования ждут прямо на `.where(...)` — как и
          // настоящий построитель drizzle, цепочка одновременно thenable.
          builder['then'] = (
            resolve: (v: unknown[]) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rowsFor(table, fields)).then(resolve, reject)
          return builder
        },
      }),
      transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db.db),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          insertValues.push(v)
          const insertRow = () => {
            const row = makeRow({
              ...(v as Partial<Row>),
              id: `n-new-${rows.length}`,
              createdAt: NOW,
              readAt: null,
            })
            rows.push(row)
            return [row]
          }
          return {
            returning: async () => (insertReturnsNothing ? [] : insertRow()),
            onConflictDoNothing: (arg: Record<string, unknown>) => {
              conflictArgs.push(arg)
              return {
                returning: async () => {
                  // Семантика ЧАСТИЧНОГО уникального индекса (user_id,
                  // dedupe_key) WHERE dedupe_key IS NOT NULL: строка без ключа
                  // не сталкивается ни с чем.
                  const key = (v['dedupeKey'] as string | null) ?? null
                  const clash =
                    key !== null &&
                    rows.some((r) => r.userId === v['userId'] && r.dedupeKey === key)
                  return clash ? [] : insertRow()
                },
              }
            },
          }
        },
      }),
    },
  } as unknown as ConstructorParameters<typeof NotificationsService>[0]

  const telemetry = makeTelemetryErrorsStub()
  return {
    svc: new NotificationsService(db, telemetry),
    telemetry,
    rows,
    insertValues,
    conflictArgs,
    askedTables,
    whereClauses,
    db,
  }
}

/** Раскрывает условие отбора в настоящий SQL с параметрами — как его увидит база. */
function compileWhere(clause: unknown): { sql: string; params: unknown[] } {
  const compiled = new PgDialect().sqlToQuery(clause as Parameters<PgDialect['sqlToQuery']>[0])
  return { sql: compiled.sql.toLowerCase(), params: compiled.params }
}

// ---------------------------------------------------------------------------
// Что уезжает в строку
// ---------------------------------------------------------------------------

describe('создание записи: в базу уезжает ровно то, что дал производитель', () => {
  it('тело и второй участник события доезжают, а не теряются по дороге', async () => {
    const h = makeHarness()

    const dto = await h.svc.create({
      userId: 'u-9',
      type: 'TEAM_NEW_MEMBER',
      title: 'В команде новый участник',
      body: 'Иван Петров',
      subjectType: 'TEAM',
      subjectId: 't-1',
      secondaryId: 'u-new',
      data: { teamName: 'Alpha', memberName: 'Иван Петров' },
    })

    expect(h.insertValues[0]).toMatchObject({
      userId: 'u-9',
      body: 'Иван Петров',
      subjectId: 't-1',
      secondaryId: 'u-new',
    })
    // И обратно: прочитанная запись несёт их же. Второй участник — адресация,
    // по нему строится ссылка, поэтому потерять его тише, чем заголовок.
    expect(dto).toMatchObject({ body: 'Иван Петров', secondaryId: 'u-new' })
  })

  it('не переданные тело и второй участник становятся null, а не пропадают из строки', async () => {
    const h = makeHarness()

    const dto = await h.svc.create({
      userId: 'u-9',
      type: 'PROJECT_MEMBER_ADDED',
      title: 'Вас добавили в проект',
      subjectType: 'PROJECT',
      subjectId: 'p-1',
      data: { projectName: 'Acme' },
    })

    expect(h.insertValues[0]).toMatchObject({ body: null, secondaryId: null })
    expect(dto?.body).toBeNull()
    expect(dto?.secondaryId).toBeNull()
  })

  it('запись без ключа идёт обычной вставкой — сталкиваться ей не с чем', async () => {
    const h = makeHarness()

    await h.svc.create({
      userId: 'u-9',
      type: 'SHARE_CONFIRM_REQUIRED',
      title: 'Ждёт решения: новая доля',
      subjectType: 'PROJECT',
      subjectId: 'p-1',
      data: { scope: 'PROJECT', projectName: 'Acme', previousPercent: 26, proposedPercent: 30 },
    })

    // Повторное предложение доли ОБЯЗАНО спросить заново, поэтому путь без
    // ключа не должен даже пытаться погасить конфликт.
    expect(h.conflictArgs).toHaveLength(0)
  })

  it('запись с ключом гасит повтор по паре «получатель + ключ»', async () => {
    const h = makeHarness()
    const input = {
      userId: 'u-9',
      type: 'TRANSACTION_ADDED' as const,
      title: 'Добавлена транзакция',
      subjectType: 'TRANSACTION' as const,
      subjectId: 'tx-1',
      data: { amount: '100.00', currency: 'USD', projectName: null },
      dedupeKey: 'TRANSACTION_ADDED:tx-1',
    }

    const first = await h.svc.create(input)
    const second = await h.svc.create(input)

    expect(first).not.toBeNull()
    expect(second).toBeNull()

    // Цель конфликта — ИМЕННО частичный уникальный индекс: пустая цель или
    // потерянное условие в бою дают «no unique or exclusion constraint
    // matching», а не тихую вставку.
    const [target, where] = [
      h.conflictArgs[0]?.['target'] as { name: string }[] | undefined,
      h.conflictArgs[0]?.['where'],
    ]
    expect(target?.map((c) => c.name)).toEqual(['user_id', 'dedupe_key'])
    expect(where, 'предикат частичного индекса обязателен').toBeDefined()
    expect(
      new PgDialect()
        .sqlToQuery(where as Parameters<PgDialect['sqlToQuery']>[0])
        .sql.replace(/"/g, '')
        .replace(/\bnotifications\./g, '')
        .toLowerCase(),
    ).toBe('dedupe_key is not null')
  })

  it('вставка без ключа не вернула строку — честная ошибка, а не тихий null', async () => {
    // Подстраховка: обычная вставка обязана вернуть строку. Возврат `null`
    // здесь означал бы «погашено идемпотентностью», а гасить было нечего —
    // производитель решил бы, что получатель уже уведомлён, и промолчал бы.
    const h = makeHarness([], {}, true)

    await expect(
      h.svc.create({
        userId: 'u-9',
        type: 'PROJECT_MEMBER_ADDED',
        title: 'Вас добавили в проект',
        subjectType: 'PROJECT',
        subjectId: 'p-1',
        data: { projectName: 'Acme' },
      }),
    ).rejects.toThrow('Failed to insert notification')
  })

  it('тот же ключ ДРУГОМУ получателю — отдельная строка', async () => {
    const h = makeHarness()
    const base = {
      type: 'TRANSACTION_ADDED' as const,
      title: 'Добавлена транзакция',
      subjectType: 'TRANSACTION' as const,
      subjectId: 'tx-1',
      data: { amount: '100.00', currency: 'USD', projectName: null },
      dedupeKey: 'TRANSACTION_ADDED:tx-1',
    }

    expect(await h.svc.create({ ...base, userId: 'u-1' })).not.toBeNull()
    expect(await h.svc.create({ ...base, userId: 'u-2' })).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Проверка данных на последнем рубеже
// ---------------------------------------------------------------------------

describe('данные проверяются формой своего типа — последний рубеж перед базой', () => {
  it('отсутствие данных — не ошибка: не у каждого события есть подробности', async () => {
    const h = makeHarness()

    await expect(
      h.svc.create({
        userId: 'u-9',
        type: 'PROJECT_MEMBER_ADDED',
        title: 'Вас добавили в проект',
        subjectType: 'PROJECT',
        subjectId: 'p-1',
        data: null,
      }),
    ).resolves.not.toBeNull()
  })

  it('неподходящие данные отклоняются с причиной, а не молча', async () => {
    const h = makeHarness()

    // Сообщение несёт И тип, И то, что именно не сошлось: без первого не
    // понять, чей производитель сломался, без второго — что чинить. С SR-H-1
    // адресат сообщения сменился — это больше не 400 вызывающему (его
    // транзакция не при чём), а строка телеметрии; проверяется она же.
    const result = await h.svc.create({
      userId: 'u-9',
      type: 'PROJECT_MEMBER_ADDED',
      title: 'Вас добавили в проект',
      subjectType: 'PROJECT',
      subjectId: 'p-1',
      data: { projectName: 42 },
    })
    expect(result).toBeNull()
    expect(h.insertValues).toHaveLength(0)
    expect(h.telemetry.recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /Invalid notification data for PROJECT_MEMBER_ADDED: .*expected string/i,
        ),
      }),
    )
  })

  it('ссылка проверяется тем же способом и с той же причиной', async () => {
    const h = makeHarness()

    const result = await h.svc.create({
      userId: 'u-9',
      type: 'INVOICE_SIGN_REQUIRED',
      title: 'Инвойс ожидает вашей подписи',
      link: 'javascript:alert(1)',
    })
    expect(result).toBeNull()
    expect(h.insertValues).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// §7.4 — уведомление живёт дольше объекта
// ---------------------------------------------------------------------------

describe('исчезнувший объект вычисляется на чтении списка', () => {
  it('объект на месте — кнопка ведёт, «исчез» не выставляется', async () => {
    const h = makeHarness([makeRow()], { projects: ['p-1'] })

    const list = await h.svc.listForUser('u-1', { limit: 10 })

    expect(list.items[0]?.subjectMissing).toBe(false)
  })

  it('объекта нет — строка честно говорит об этом', async () => {
    const h = makeHarness([makeRow()], { projects: [] })

    const list = await h.svc.listForUser('u-1', { limit: 10 })

    expect(list.items[0]?.subjectMissing).toBe(true)
  })

  it('из двух строк «исчезла» ровно одна — а не обе и не ни одной', async () => {
    const h = makeHarness(
      [
        makeRow({ id: 'n-live', subjectId: 'p-1' }),
        makeRow({
          id: 'n-gone',
          subjectId: 'p-2',
          createdAt: new Date('2026-09-06T10:00:00.000Z'),
        }),
      ],
      { projects: ['p-1'] },
    )

    const list = await h.svc.listForUser('u-1', { limit: 10 })

    expect(list.items.map((i) => [i.id, i.subjectMissing])).toEqual([
      ['n-live', false],
      ['n-gone', true],
    ])
  })

  it('строка без структурного объекта не «исчезает» — у неё его и не было', async () => {
    const h = makeHarness(
      [
        makeRow({
          type: 'INVOICE_SIGN_REQUIRED',
          subjectType: null,
          subjectId: null,
          data: null,
          link: '/documents?category=INVOICE',
        }),
      ],
      { projects: [] },
    )

    const list = await h.svc.listForUser('u-1', { limit: 10 })

    expect(list.items[0]?.subjectMissing).toBe(false)
    // И спрашивать о ней базу не о чем: вид объекта — это и есть таблица.
    expect(h.askedTables).toHaveLength(0)
  })

  it('про согласования спрашивают отдельно — и только когда есть о чём', async () => {
    const h = makeHarness(
      [makeRow({ type: 'PROJECT_CONFIRM_REQUIRED', subjectId: 'p-1' })],
      // Проект жив, но живого согласования по нему больше нет: предложение
      // отозвали или погасил отказ соседа.
      { projects: ['p-1'], approvals: [] },
    )

    const list = await h.svc.listForUser('u-1', { limit: 10 })

    expect(list.items[0]?.subjectMissing).toBe(true)
    expect(h.askedTables).toContain('approvals')
  })

  it('согласование живо — кнопка ведёт', async () => {
    const h = makeHarness([makeRow({ type: 'PROJECT_CONFIRM_REQUIRED', subjectId: 'p-1' })], {
      projects: ['p-1'],
      approvals: [{ subjectType: 'PROJECT', subjectId: 'p-1', approverUserId: 'u-1' }],
    })

    const list = await h.svc.listForUser('u-1', { limit: 10 })

    expect(list.items[0]?.subjectMissing).toBe(false)
  })

  it('про живость согласования спрашивают ИМЕННО про этот объект', async () => {
    const h = makeHarness([makeRow({ type: 'PROJECT_CONFIRM_REQUIRED', subjectId: 'p-1' })], {
      projects: ['p-1'],
      approvals: [{ subjectType: 'PROJECT', subjectId: 'p-1', approverUserId: 'u-1' }],
    })

    await h.svc.listForUser('u-1', { limit: 10 })

    // Запрос «про что угодно» вернул бы ЧУЖИЕ живые согласования, и кнопка
    // повела бы к объекту, решение по которому ждут не от этого человека.
    const approvalWhere = h.whereClauses.find((w) => w.table === 'approvals')
    expect(approvalWhere, 'запрос к согласованиям обязан нести условие').toBeDefined()
    const compiled = compileWhere(approvalWhere!.sql)
    expect(compiled.params).toContain('p-1')
    expect(compiled.sql).toContain('superseded_at')
  })

  it('информирующей строке согласования не нужны — лишнего запроса нет', async () => {
    const h = makeHarness([makeRow()], { projects: ['p-1'] })

    await h.svc.listForUser('u-1', { limit: 10 })

    // Список читают на каждое открытие колокольчика: запрос «на всякий
    // случай» здесь — постоянная цена ни за что.
    expect(h.askedTables).toEqual(['projects'])
  })
})
