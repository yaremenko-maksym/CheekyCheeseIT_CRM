/**
 * task-notification-types-producers (позиция 6) — производитель двух типов
 * «админу» внутри `ApprovalsService`.
 *
 * Событие — решение сотрудника; получатель — автор предложения и никто
 * больше. Проверяется, что уведомление пишется В ТОЙ ЖЕ транзакции, что и
 * само решение (заглушка транзакции — единственный источник построителей),
 * и что вид объекта, который нечем назвать, не порождает уведомления вовсе.
 */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalsService } from './approvals.service'
import { approvalNotificationKind, approvalNotificationSubject } from './approval-notification'
import type { DatabaseService } from '../database/database.service'
import type { NotificationsService } from '../notifications/notifications.service'
import { makePassThroughEmitInTx } from '../notifications/__test-helpers__/notifications-stub'

const SUBJECT_ID = 'b1000000-0000-4000-a000-000000000001'
const APPROVER_ID = 'b1000000-0000-4000-a000-000000000002'
const ADMIN_ID = 'b1000000-0000-4000-a000-000000000004'

function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'b1000000-0000-4000-a000-000000000101',
    subjectType: 'PROJECT',
    subjectId: SUBJECT_ID,
    approverUserId: APPROVER_ID,
    status: 'PENDING' as const,
    rejectionReason: null,
    decidedAt: null,
    proposedByUserId: ADMIN_ID,
    supersededAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  }
}

function makeHarness(row: Record<string, unknown>, opts: { projectName?: string | null } = {}) {
  const created: Record<string, unknown>[] = []
  const notifications = {
    createInTx: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => {
      created.push(input)
      return null
    }),
    emitInTx: makePassThroughEmitInTx(),
  } as unknown as NotificationsService

  // Один и тот же построитель отвечает трём читателям: блокировке живых строк,
  // чтению имени сотрудника и чтению названия проекта. Различаем по порядку
  // вызова — `lockLiveRows` заканчивается на `.for(...)`, а два чтения
  // производителя на `.limit(1)`.
  let limitCall = 0
  /**
   * Заглушка УВАЖАЕТ список запрошенных колонок, как и настоящая база: что не
   * попросили — того в ответе нет. Иначе «прочитать имя сотрудника» и
   * «прочитать ничего» выглядели бы для теста одинаково, и производитель мог
   * бы спрашивать у базы пустоту, оставаясь зелёным.
   */
  const project = (
    fields: Record<string, unknown> | undefined,
    source: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (fields === undefined) return source
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(fields)) out[key] = source[key]
    return out
  }
  const txHandle = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      const chain: Record<string, unknown> = {}
      chain['from'] = vi.fn(() => chain)
      chain['where'] = vi.fn(() => chain)
      chain['orderBy'] = vi.fn(() => chain)
      // `.for('update')` обслуживает ДВА читателя: `lockLiveRows` ждёт его
      // напрямую, `loadLiveRowForUpdate` продолжает цепочку `.limit(1)`.
      // Поэтому цепочка одновременно и thenable, и продолжаемая — ровно как
      // настоящий построитель drizzle.
      chain['for'] = vi.fn(() => chain)
      chain['then'] = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve([row]).then(resolve, reject)
      chain['limit'] = vi.fn(async () => {
        limitCall += 1
        if (limitCall === 1) return [project(fields, row as unknown as Record<string, unknown>)]
        if (limitCall === 2) return [project(fields, { displayName: 'Иван Петров' })]
        // QA-M-4 (manual-qa круг 3, #664): строка проекта несёт ОБА имени, и
        // они намеренно различаются — уведомление обязано называть проект
        // `companyName` (тем же словом, что экран «Ждут решения» и список
        // проектов), а не `projects.name`. Регресс на `name` немедленно виден
        // в значении `subjectTitle`, а не прячется за одинаковыми строками.
        const companyName = opts.projectName === undefined ? 'Acme' : opts.projectName
        return companyName === null
          ? []
          : [project(fields, { companyName, name: 'Acme Draft Project' })]
      })
      return chain
    }),
    update: vi.fn(() => {
      // Заглушка ПРИМЕНЯЕТ правку и возвращает строку такой, какой она стала:
      // раньше здесь стоял жёсткий `status: 'APPROVED'`, и отказ был
      // неотличим от подтверждения — тест не мог сказать, применилось ли
      // решение вообще (SR-H-1: ровно этот вопрос и проверяется длинной
      // причиной).
      const patch: Record<string, unknown> = {}
      const whereResult = {
        returning: vi.fn(async () => [{ ...row, decidedAt: new Date(), ...patch }]),
        then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve([]).then(resolve, reject),
      }
      const chain = {
        set: vi.fn((values: Record<string, unknown>) => {
          Object.assign(patch, values)
          return chain
        }),
        where: vi.fn(() => whereResult),
      }
      return chain
    }),
  }

  const db = {
    db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txHandle)) },
  } as unknown as DatabaseService

  return { svc: new ApprovalsService(db, notifications), created }
}

describe('approvalNotificationKind — вид согласования → вид уведомления', () => {
  it.each([
    ['PROJECT', 'PROJECT'],
    ['PROJECT_SENIOR_SHARE', 'PROJECT_SHARE'],
    ['USER_SENIOR_SHARE', 'BASE_SHARE'],
  ] as const)('%s → %s', (subjectType, kind) => {
    expect(approvalNotificationKind(subjectType)).toBe(kind)
  })

  it('неизвестный вид описать нечем — null, и уведомления не будет', () => {
    expect(approvalNotificationKind('SOMETHING_ELSE')).toBeNull()
  })
})

describe('approvalNotificationSubject — куда ведёт кнопка администратора', () => {
  it('доли и проекта — на проект, с названием', () => {
    expect(approvalNotificationSubject('PROJECT')).toEqual({
      subjectType: 'PROJECT',
      needsProjectName: true,
    })
    expect(approvalNotificationSubject('PROJECT_SHARE')).toEqual({
      subjectType: 'PROJECT',
      needsProjectName: true,
    })
  })

  it('базовой доли — на профиль сотрудника, название не нужно', () => {
    expect(approvalNotificationSubject('BASE_SHARE')).toEqual({
      subjectType: 'USER',
      needsProjectName: false,
    })
  })
})

describe('«сотрудник подтвердил»', () => {
  it('уходит автору предложения — и никому больше', async () => {
    const h = makeHarness(makeRow())
    await h.svc.approve({
      subjectType: 'PROJECT',
      subjectId: SUBJECT_ID,
      approverUserId: APPROVER_ID,
    })

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: ADMIN_ID,
      type: 'APPROVAL_CONFIRMED',
      title: 'Предложение принято',
      subjectType: 'PROJECT',
      subjectId: SUBJECT_ID,
      secondaryId: APPROVER_ID,
      data: { approverName: 'Иван Петров', subjectKind: 'PROJECT', subjectTitle: 'Acme' },
    })
  })

  it('проект уже исчез — имя решившего остаётся, название честно пустое', async () => {
    const h = makeHarness(makeRow(), { projectName: null })
    await h.svc.approve({
      subjectType: 'PROJECT',
      subjectId: SUBJECT_ID,
      approverUserId: APPROVER_ID,
    })
    expect(h.created[0]?.['data']).toMatchObject({ subjectTitle: null })
  })

  it('базовая доля ведёт на профиль сотрудника и названия не запрашивает', async () => {
    const h = makeHarness(makeRow({ subjectType: 'USER_SENIOR_SHARE' }))
    await h.svc.approve({
      subjectType: 'USER_SENIOR_SHARE',
      subjectId: SUBJECT_ID,
      approverUserId: APPROVER_ID,
    })
    expect(h.created[0]).toMatchObject({ subjectType: 'USER' })
    expect(h.created[0]?.['data']).toMatchObject({ subjectKind: 'BASE_SHARE', subjectTitle: null })
  })

  it('вид объекта, который нечем назвать, уведомления не порождает', async () => {
    const h = makeHarness(makeRow({ subjectType: 'SOMETHING_ELSE' }))
    await h.svc.approve({
      subjectType: 'SOMETHING_ELSE',
      subjectId: SUBJECT_ID,
      approverUserId: APPROVER_ID,
    })
    expect(h.created).toHaveLength(0)
  })

  it('сам себе предложивший сам себе не пишет', async () => {
    const h = makeHarness(makeRow({ proposedByUserId: APPROVER_ID }))
    await h.svc.approve({
      subjectType: 'PROJECT',
      subjectId: SUBJECT_ID,
      approverUserId: APPROVER_ID,
    })
    expect(h.created).toHaveLength(0)
  })

  it('сотрудник исчез — подпись не пустая, а честно обезличенная', async () => {
    const h = makeHarness(makeRow())
    const svcDb = (
      h.svc as unknown as { db: { db: { transaction: (cb: (t: unknown) => unknown) => unknown } } }
    ).db
    const original = svcDb.db.transaction
    svcDb.db.transaction = (cb: (tx: unknown) => unknown) =>
      original((tx: unknown) => {
        const handle = tx as { select: () => Record<string, () => unknown> }
        const realSelect = handle.select
        let call = 0
        handle.select = () => {
          call += 1
          const chain = realSelect()
          if (call === 2) {
            ;(chain as unknown as { limit: () => Promise<unknown[]> }).limit = async () => []
          }
          return chain
        }
        return cb(tx)
      })

    await h.svc.approve({
      subjectType: 'PROJECT',
      subjectId: SUBJECT_ID,
      approverUserId: APPROVER_ID,
    })
    expect(h.created[0]?.['data']).toMatchObject({ approverName: 'Сотрудник' })
  })
})

describe('«сотрудник отклонил, с причиной»', () => {
  it('причина едет в данных записи, а не в заголовке', async () => {
    const h = makeHarness(makeRow())
    await h.svc.reject({
      subjectType: 'PROJECT',
      subjectId: SUBJECT_ID,
      approverUserId: APPROVER_ID,
      reason: 'Доля не та',
    })

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: ADMIN_ID,
      type: 'APPROVAL_REJECTED',
      title: 'Предложение отклонено',
    })
    expect(h.created[0]?.['data']).toMatchObject({ reasonPreview: 'Доля не та' })
    expect(String(h.created[0]?.['title'])).not.toContain('Доля не та')
  })

  /**
   * SR-H-1 (security-review круг 1). Длина причины — легального текста,
   * который пишет синьор, — управляла судьбой САМОГО отказа: разбор данных
   * уведомления бросал внутри транзакции решения, и причина длиннее потолка
   * формы откатывала отказ целиком.
   *
   * 500 символов — не «краевой случай», а ровно тот потолок, который
   * `rejectApprovalInputSchema` разрешает написать (`.max(500)`, добавлен
   * SR-L-1 на PR #646). Всё, что длиннее, получает честный 400 ПРО ПРИЧИНУ на
   * границе запроса — это правило ввода, а не вето уведомления.
   */
  it('причина максимальной разрешённой длины: отказ применён, в записи — превью на 200', async () => {
    const h = makeHarness(makeRow())
    const updated = await h.svc.reject({
      subjectType: 'PROJECT',
      subjectId: SUBJECT_ID,
      approverUserId: APPROVER_ID,
      reason: 'я'.repeat(500),
    })

    expect(updated.status).toBe('REJECTED')
    expect(h.created).toHaveLength(1)
    const preview = (h.created[0]?.['data'] as { reasonPreview: string }).reasonPreview
    expect(preview).toHaveLength(200)
    expect(preview.endsWith('…')).toBe(true)
  })
})
