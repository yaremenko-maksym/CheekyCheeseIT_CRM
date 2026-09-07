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
  } as unknown as NotificationsService

  // Один и тот же построитель отвечает трём читателям: блокировке живых строк,
  // чтению имени сотрудника и чтению названия проекта. Различаем по порядку
  // вызова — `lockLiveRows` заканчивается на `.for(...)`, а два чтения
  // производителя на `.limit(1)`.
  let limitCall = 0
  const txHandle = {
    select: vi.fn(() => {
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
        if (limitCall === 1) return [row]
        if (limitCall === 2) return [{ displayName: 'Иван Петров' }]
        const name = opts.projectName === undefined ? 'Acme' : opts.projectName
        return name === null ? [] : [{ name }]
      })
      return chain
    }),
    update: vi.fn(() => {
      const whereResult = {
        returning: vi.fn(async () => [{ ...row, status: 'APPROVED', decidedAt: new Date() }]),
        then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve([]).then(resolve, reject),
      }
      const chain = { set: vi.fn(() => chain), where: vi.fn(() => whereResult) }
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
      title: 'Сотрудник подтвердил',
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
      title: 'Сотрудник отклонил',
    })
    expect(h.created[0]?.['data']).toMatchObject({ reason: 'Доля не та' })
    expect(String(h.created[0]?.['title'])).not.toContain('Доля не та')
  })
})
