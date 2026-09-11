/**
 * task-notification-types-producers (позиция 6) — производитель уведомлений в
 * `finance/transactions`.
 *
 * Два типа: «транзакция добавлена» и «статус транзакции изменился». Проверяется
 * то, что задание требует дословно: «событие → запись нужного типа нужным
 * получателям И НИКОМУ БОЛЬШЕ», плюс правило раскрытия (§10): отправитель
 * парной строки раздела не должен узнать сумму другой стороны.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { NotificationsService } from '../notifications/notifications.service'
import type { TransactionsService } from './transactions.service'

const ADMIN: SessionUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN',
  name: 'Админ',
} as SessionUser

type TxRow = {
  id: string
  type: string
  status: string
  amount: string
  currency: string
  receiverId: string | null
  senderId: string | null
  projectId: string | null
  deletedAt: Date | null
}

function makeTxRow(over: Partial<TxRow> = {}): TxRow {
  return {
    id: 'tx-1',
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '1200.00',
    currency: 'USD',
    receiverId: 'senior-1',
    senderId: 'drop-1',
    projectId: 'proj-1',
    deletedAt: null,
    ...over,
  }
}

function makeHarness(tx: TxRow, projectName: string | null = 'Acme') {
  const created: Record<string, unknown>[] = []
  const notifications = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input)
      return null
    }),
  } as unknown as NotificationsService

  const auditInserts: unknown[] = []
  const dbtx = {
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => [{ id: tx.id }] }),
      }),
    }),
    insert: () => ({
      values: async (v: unknown) => {
        auditInserts.push(v)
      },
    }),
  }

  // Заглушки чтения ведут себя как база в двух вещах, на которых иначе
  // нельзя отличить «спросил правильно» от «спросил что попало»:
  //   - без условия отбора строка не находится (запрос «дай хоть что-нибудь»
  //     в бою вернул бы ЧУЖУЮ транзакцию — то есть чужие деньги);
  //   - в ответе ровно те колонки, которые попросили.
  const findFirstArgs: Record<string, unknown>[] = []
  const pickColumns = (
    args: { columns?: Record<string, boolean> } | undefined,
    source: Record<string, unknown>,
  ): Record<string, unknown> => {
    const columns = args?.columns
    if (columns === undefined) return source
    const out: Record<string, unknown> = {}
    for (const [key, wanted] of Object.entries(columns)) if (wanted) out[key] = source[key]
    return out
  }

  const db = {
    db: {
      query: {
        transactions: {
          findFirst: async (args?: { where?: unknown }) => {
            findFirstArgs.push({ scope: 'transactions', ...(args ?? {}) })
            return args?.where === undefined ? undefined : tx
          },
        },
        projects: {
          findFirst: async (args?: { where?: unknown; columns?: Record<string, boolean> }) => {
            findFirstArgs.push({ scope: 'projects', ...(args ?? {}) })
            if (args?.where === undefined) return undefined
            if (projectName === null) return undefined
            return pickColumns(args, { id: 'proj-1', name: projectName })
          },
        },
      },
      insert: () => ({ values: async () => undefined }),
      transaction: async <T>(cb: (t: unknown) => Promise<T>): Promise<T> => cb(dbtx),
    },
  } as never

  const svc = makeTransactionsService({ db, notificationsService: notifications })
  return { svc, created, notifications, auditInserts, findFirstArgs }
}

/**
 * Журнал — единственный наблюдаемый выход best-effort производителя: он ничего
 * не возвращает и ничем не падает. Поэтому «промолчал» и «упал, но проглотил»
 * различаются только здесь. Возвращается список сообщений, а не сам шпион,
 * чтобы утверждение читалось про текст.
 */
function spyOnLoggerErrors(svc: TransactionsService): string[] {
  const messages: string[] = []
  const logger = (svc as unknown as { logger: { error: (m: string, s?: string) => void } }).logger
  vi.spyOn(logger, 'error').mockImplementation((m: string) => {
    messages.push(String(m))
  })
  return messages
}

/** `afterTransactionCreated` — приватный шов, который зовут все пути создания. */
function created(svc: TransactionsService) {
  return svc as unknown as {
    afterTransactionCreated: (
      txId: string,
      created: { type: string; amount: string; currency: string },
      user: SessionUser,
    ) => Promise<void>
  }
}

describe('«транзакция добавлена»', () => {
  it('уходит получателю денег — одной записью нужного типа', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'senior-1',
      type: 'TRANSACTION_ADDED',
      title: 'Добавлена транзакция',
      subjectType: 'TRANSACTION',
      subjectId: 'tx-1',
      dedupeKey: 'TRANSACTION_ADDED:tx-1',
    })
  })

  it('и НИКОМУ больше — отправитель парной строки не узнаёт чужую сумму (§10)', async () => {
    const tx = makeTxRow({ type: 'PAYOUT_DROP', receiverId: 'drop-1', senderId: 'senior-1' })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)

    expect(h.created.map((c) => c['userId'])).toEqual(['drop-1'])
  })

  it('данные несут сумму и снятое название проекта, а заголовок — нет', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)

    expect(h.created[0]?.['data']).toEqual({
      amount: '1200.00',
      currency: 'USD',
      projectName: 'Acme',
    })
    expect(h.created[0]?.['title']).not.toContain('1200')
  })

  it('транзакция без проекта — название null, а не выдуманное', async () => {
    const tx = makeTxRow({ projectId: null })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created[0]?.['data']).toMatchObject({ projectName: null })
  })

  it('проект исчез между событием и чтением — название null', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx, null)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created[0]?.['data']).toMatchObject({ projectName: null })
  })

  it('автор действия сам себе уведомления не шлёт — своё подтверждает тост (§8.1)', async () => {
    const tx = makeTxRow({ receiverId: ADMIN.id })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created).toHaveLength(0)
  })

  it('под входом за другого сотрудника автором считается реальный оператор', async () => {
    const tx = makeTxRow({ receiverId: 'real-admin' })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, {
      ...ADMIN,
      id: 'senior-1',
      impersonatorId: 'real-admin',
    } as SessionUser)
    expect(h.created).toHaveLength(0)
  })

  it('строка без получателя не порождает уведомления', async () => {
    const tx = makeTxRow({ receiverId: null })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created).toHaveLength(0)
  })

  it('строки уже нет — молча ничего', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    const db = (h.svc as unknown as { db: { db: { query: { transactions: unknown } } } }).db
    db.db.query.transactions = { findFirst: async () => undefined }
    const errors = spyOnLoggerErrors(h.svc)

    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)

    expect(h.created).toHaveLength(0)
    // «Молча» — это ровно тишина, а не проглоченное падение: ушедшая строка —
    // обычный исход гонки, и жалоба в журнал на каждый такой случай заглушила
    // бы настоящие сбои доставки.
    expect(errors).toHaveLength(0)
  })

  it('сбой доставки не превращает записанные деньги в ошибку', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    const errors = spyOnLoggerErrors(h.svc)
    ;(h.notifications.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('нет связи'),
    )

    await expect(created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)).resolves.toBeUndefined()

    // Но и молчать нельзя: не доехавшее уведомление о деньгах обязано остаться
    // следом в журнале — с той строкой, о которой речь, и с причиной.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('notifyTransactionAdded')
    expect(errors[0]).toContain('tx-1')
    expect(errors[0]).toContain('нет связи')
  })

  it('спека без своей заглушки уведомлений производителя не роняет', async () => {
    // Пинует умолчание из `__test-helpers__/make-transactions-service`: десятки
    // финансовых спек не передают `notificationsService` вовсе, и производитель
    // обязан у них проходить бесшумно — иначе «best-effort» превратится в
    // журнал, полный ложных сбоев.
    const tx = makeTxRow()
    const db = {
      db: {
        query: {
          transactions: {
            findFirst: async (args?: { where?: unknown }) => (args ? tx : undefined),
          },
          projects: { findFirst: async () => ({ name: 'Acme' }) },
        },
        // Рядом с производителем на том же пути живёт запись в аудит — без неё
        // молчание проверялось бы на упавшем соседе, а не на производителе.
        insert: () => ({ values: async () => undefined }),
      },
    } as never
    const svc = makeTransactionsService({ db })
    const errors = spyOnLoggerErrors(svc)

    await expect(created(svc).afterTransactionCreated(tx.id, tx, ADMIN)).resolves.toBeUndefined()
    expect(errors).toHaveLength(0)
  })

  it('читает ИМЕННО свою строку и ровно нужную колонку проекта', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)

    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)

    const txRead = h.findFirstArgs.find((a) => a['scope'] === 'transactions')
    const projectRead = h.findFirstArgs.find((a) => a['scope'] === 'projects')
    // Запрос без условия отбора в бою вернул бы ЧУЖУЮ строку, то есть чужие
    // деньги; запрос без списка колонок притащил бы весь профиль проекта.
    expect(txRead?.['where']).toBeDefined()
    expect(projectRead?.['where']).toBeDefined()
    expect(projectRead?.['columns']).toEqual({ name: true })
  })
})

describe('«статус транзакции изменился»', () => {
  it('проверка дохода → получателю, с суммой и статусом VALIDATED', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)

    await h.svc.validateTransaction('tx-1', 'validate', null, ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'senior-1',
      type: 'TRANSACTION_STATUS_CHANGED',
      title: 'Статус транзакции изменился',
      subjectType: 'TRANSACTION',
      subjectId: 'tx-1',
      dedupeKey: 'TRANSACTION_STATUS_CHANGED:tx-1:VALIDATED',
    })
    expect(h.created[0]?.['data']).toMatchObject({
      status: 'VALIDATED',
      rejectionReasonPreview: null,
    })
  })

  it('отклонение → получателю, с причиной в данных', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)

    await h.svc.validateTransaction('tx-1', 'reject', 'Нет чека', ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'senior-1',
      dedupeKey: 'TRANSACTION_STATUS_CHANGED:tx-1:REJECTED',
    })
    expect(h.created[0]?.['data']).toMatchObject({
      status: 'REJECTED',
      rejectionReasonPreview: 'Нет чека',
    })
  })

  // SR-H-1 (круг 1): причина отказа — текст, написанный человеком, и его длина
  // не имеет права решать судьбу уведомления. В запись едет превью.
  it('длинная причина отклонения сводится к превью в 200 символов', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)

    await h.svc.validateTransaction('tx-1', 'reject', 'я'.repeat(5000), ADMIN)

    expect(h.created).toHaveLength(1)
    const preview = (h.created[0]?.['data'] as { rejectionReasonPreview: string })
      .rejectionReasonPreview
    expect(preview).toHaveLength(200)
    expect(preview.endsWith('…')).toBe(true)
  })

  // `validateTransactionSchema.rejectionReason` — `z.string().max(500)`, без
  // `min(1)` и без `trim()`: причина из одних пробелов сюда реально доезжает
  // (в отличие от согласований, где непустота гарантирована формой ввода).
  // Для человека это «отклонили без причины», и запись обязана говорить то же,
  // а не показывать пустой хвост после тире.
  it('причина из одних пробелов = причины нет', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)

    await h.svc.validateTransaction('tx-1', 'reject', '   ', ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]?.['data']).toMatchObject({ rejectionReasonPreview: null })
  })

  it('отказ в доступе не порождает уведомления — события не было', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    const junior = { ...ADMIN, id: 'junior-1', role: 'JUNIOR' } as SessionUser
    await expect(h.svc.validateTransaction('tx-1', 'validate', null, junior)).rejects.toThrow()
    expect(h.created).toHaveLength(0)
  })

  it('строка уже не PENDING — ни перехода, ни уведомления', async () => {
    const tx = makeTxRow({ status: 'VALIDATED' })
    const h = makeHarness(tx)
    await expect(h.svc.validateTransaction('tx-1', 'validate', null, ADMIN)).rejects.toThrow()
    expect(h.created).toHaveLength(0)
  })

  it('отклонение без причины отклоняется до всякой записи', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    await expect(h.svc.validateTransaction('tx-1', 'reject', null, ADMIN)).rejects.toThrow()
    expect(h.created).toHaveLength(0)
  })

  it('строка без получателя: писать некому — и никто посторонний не узнаёт', async () => {
    const tx = makeTxRow({ receiverId: null })
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)

    await h.svc.validateTransaction('tx-1', 'validate', null, ADMIN)

    expect(h.created).toHaveLength(0)
  })

  it('проверивший СВОЮ строку себе не пишет — своё подтверждает тост (§8.1)', async () => {
    const tx = makeTxRow({ receiverId: ADMIN.id })
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)

    await h.svc.validateTransaction('tx-1', 'validate', null, ADMIN)

    expect(h.created).toHaveLength(0)
  })

  it('под входом за другого сотрудника автором считается реальный оператор', async () => {
    // Вход за другого: решение принимает администратор, значит и «своё» здесь
    // — его. Получателю-сотруднику написать обязаны, иначе человек не узнает о
    // судьбе своего дохода.
    const tx = makeTxRow({ receiverId: 'senior-1' })
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)
    const impersonating = { ...ADMIN, id: 'senior-1', impersonatorId: ADMIN.id } as SessionUser

    await h.svc.validateTransaction('tx-1', 'validate', null, impersonating)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ userId: 'senior-1' })
  })

  it('строки уже нет — молча ничего, без жалобы в журнал', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)
    const errors = spyOnLoggerErrors(h.svc)
    const db = (h.svc as unknown as { db: { db: { query: { transactions: unknown } } } }).db
    let call = 0
    const before = db.db.query.transactions as { findFirst: (a?: unknown) => Promise<unknown> }
    // Первое чтение обслуживает сам переход статуса; исчезает строка к моменту
    // рассылки — то есть ровно на гонке с удалением.
    db.db.query.transactions = {
      findFirst: async (a?: unknown) => {
        call += 1
        return call === 1 ? before.findFirst(a) : undefined
      },
    }

    await h.svc.validateTransaction('tx-1', 'validate', null, ADMIN)

    expect(h.created).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })
})

/**
 * SR-L-2 (security-review круг 1). Зарплатный крон вызывает
 * `createMonthlySalaries` БЕЗ сессионного актора (его некому дать — это
 * расписание, а не запрос), и производитель стоял за условием
 * `if (actor && inserted[0])`. То есть сотрудник узнавал о начисленной
 * зарплате, только если строку завёл человек руками.
 *
 * Уведомление получателю от актора не зависит: актор нужен ровно для одного —
 * не написать человеку о его же собственном действии (§8.1). Нет актора —
 * некого и исключать, событие системное.
 */
describe('«транзакция добавлена» — системное событие без актора', () => {
  it('получатель узнаёт о строке, созданной без сессионного пользователя', async () => {
    const tx = makeTxRow({ type: 'SALARY', receiverId: 'hr-1', senderId: null, projectId: null })
    const h = makeHarness(tx, null)

    await created(h.svc).afterTransactionCreated(tx.id, tx, null)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'hr-1',
      type: 'TRANSACTION_ADDED',
      dedupeKey: 'TRANSACTION_ADDED:tx-1',
    })
  })

  it('журнал действий без актора не пишется — писать в него нечего', async () => {
    const tx = makeTxRow({ type: 'SALARY', receiverId: 'hr-1', senderId: null, projectId: null })
    const h = makeHarness(tx, null)

    await created(h.svc).afterTransactionCreated(tx.id, tx, null)

    // Аудит остаётся привязан к человеку: системная строка несёт `createdBy`
    // (резервный админ), и второй записи «кто это сделал» у неё нет.
    expect(h.auditInserts).toHaveLength(0)
  })

  it('кроновый проход зарплат порождает уведомление получателю', async () => {
    const salaryRow = makeTxRow({
      id: 'tx-salary',
      type: 'SALARY',
      receiverId: 'hr-1',
      senderId: null,
      projectId: null,
    })
    const h = makeHarness(salaryRow, null)

    // Кому начислять — не предмет этого теста; важно, что актора НЕТ.
    const internals = h.svc as unknown as {
      resolveHrAccountantSalaryReceivers: () => Promise<unknown[]>
      resolveJuniorSalaryReceivers: () => Promise<unknown[]>
    }
    vi.spyOn(internals, 'resolveHrAccountantSalaryReceivers').mockResolvedValue([
      { id: 'hr-1', email: 'hr@example.com', monthlySalary: '1000.00' },
    ])
    vi.spyOn(internals, 'resolveJuniorSalaryReceivers').mockResolvedValue([])

    const db = (h.svc as unknown as { db: { db: Record<string, unknown> } }).db.db
    // Резервный админ — тот, кого крон записывает в `createdBy`.
    ;(db['query'] as Record<string, unknown>)['users'] = {
      findFirst: async () => ({ id: 'admin-fallback', role: 'ADMIN' }),
    }
    db['insert'] = () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [{ id: 'tx-salary' }] }),
      }),
    })

    await h.svc.createMonthlySalaries('2026-09')

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ userId: 'hr-1', type: 'TRANSACTION_ADDED' })
  })
})
