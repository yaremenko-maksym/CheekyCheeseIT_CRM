/**
 * task-notification-types-producers (позиция 6) — БАЗОВАЯ половина «ждёт
 * решения: новая доля». Близнец проектной половины
 * (`projects/project-notifications.unit.spec.ts`); различие ровно одно и
 * содержательное: `scope: 'BASE'` и объект — сам сотрудник, а не проект.
 */
import { describe, expect, it, vi } from 'vitest'
import { UsersService } from './users.service'
import type { NotificationsService } from '../notifications/notifications.service'
import { makePassThroughEmitInTx } from '../notifications/__test-helpers__/notifications-stub'

function callSeam(input: {
  subjectId: string
  approverUserId: string
  proposedPercent: number
  previousPercent: number
}) {
  const created: Record<string, unknown>[] = []
  const notifications = {
    createInTx: vi.fn(async (_tx: unknown, i: Record<string, unknown>) => {
      created.push(i)
      return null
    }),
    emitInTx: makePassThroughEmitInTx(),
  } as unknown as NotificationsService

  const service = new UsersService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifications,
  )
  const seam = service as unknown as {
    notifyPendingSeniorShareProposed: (tx: unknown, i: unknown) => Promise<void>
  }
  return seam.notifyPendingSeniorShareProposed({}, input).then(() => created)
}

describe('«ждёт решения: новая доля» — базовая половина', () => {
  it('уходит тому, чья доля меняется, и ведёт на его профиль', async () => {
    const created = await callSeam({
      subjectId: 'senior-1',
      approverUserId: 'senior-1',
      proposedPercent: 80,
      previousPercent: 26,
    })

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      userId: 'senior-1',
      type: 'SHARE_CONFIRM_REQUIRED',
      // COPY-H-1/COPY-H-5 (copy-review круг 1, #664): предмет первым, без
      // семейного префикса.
      title: 'Предложение по доле',
      subjectType: 'USER',
      subjectId: 'senior-1',
      data: {
        scope: 'BASE',
        projectName: null,
        previousPercent: 26,
        proposedPercent: 80,
      },
    })
  })

  it('заголовок цифр не несёт — в письмо (позиция 7) уйдёт только он', async () => {
    const created = await callSeam({
      subjectId: 'senior-1',
      approverUserId: 'senior-1',
      proposedPercent: 80,
      previousPercent: 26,
    })
    expect(String(created[0]?.['title'])).not.toMatch(/\d/)
  })

  it('ключа идемпотентности нет — повторное предложение спрашивает заново', async () => {
    const created = await callSeam({
      subjectId: 'senior-1',
      approverUserId: 'senior-1',
      proposedPercent: 80,
      previousPercent: 26,
    })
    expect(created[0]?.['dedupeKey']).toBeUndefined()
  })
})
