/**
 * `NotificationsController` — unit tests, бэклог 205.
 *
 * Гейт мутаций не исполняет интеграционных спек
 * (`.claude/rules/common/mutation-gate-integration-specs.md`), а RBAC-рига
 * `notification-preferences.rbac.integration.spec.ts` — именно такая: живая
 * база, настоящий `JwtAuthGuard`. Она доказывает 403 «сквозь HTTP», но не
 * даёт гейту увидеть саму строку `if (user.impersonatorId)`. Этот файл —
 * прямой юнит-тест метода контроллера: `@CurrentUser()` подделывается
 * объектом (то, чем он реально является при каждом запросе, кроме `/me` —
 * см. doc-комментарий `sessionUserSchema.impersonatorId`), сервис —
 * шпионом, вызван он или нет.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE, type SessionUser } from '@crm/shared'
import { NotificationsController } from './notifications.controller'

function makeController(): {
  controller: NotificationsController
  updateForUser: ReturnType<typeof vi.fn>
  listForUser: ReturnType<typeof vi.fn>
} {
  const updateForUser = vi.fn(() => Promise.resolve({ items: [] }))
  const listForUser = vi.fn(() => Promise.resolve({ items: [] }))
  const controller = new NotificationsController(
    { listForUser: vi.fn() } as never,
    { updateForUser, listForUser } as never,
  )
  return { controller, updateForUser, listForUser }
}

function sessionUser(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'f7b10000-0000-4007-b000-000000000001',
    email: 'a@cheekycheese.tech',
    displayName: 'A',
    avatarUrl: null,
    role: 'ADMIN',
    seniorSharePercent: 26,
    ...over,
  }
}

describe('PUT /notifications/preferences под имперсонацией — бэклог 205', () => {
  it('impersonatorId задан — 403 по-русски, updateForUser НЕ вызван', () => {
    const { controller, updateForUser } = makeController()
    const admin = sessionUser({ impersonatorId: 'f7b10000-0000-4007-b000-000000000002' })

    expect(() =>
      controller.updatePreferences(admin, {
        items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
      }),
    ).toThrow(ForbiddenException)
    expect(updateForUser).not.toHaveBeenCalled()
  })

  it('текст отказа — ровно тот, что видит клиент (проверка на дословность строки)', () => {
    const { controller } = makeController()
    const admin = sessionUser({ impersonatorId: 'f7b10000-0000-4007-b000-000000000002' })

    let caught: unknown
    try {
      controller.updatePreferences(admin, { items: [] })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ForbiddenException)
    expect((caught as ForbiddenException).message).toBe(
      NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE,
    )
  })

  it('impersonatorId отсутствует — запись проходит как обычно', () => {
    const { controller, updateForUser } = makeController()
    const owner = sessionUser()

    controller.updatePreferences(owner, {
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
    })

    expect(updateForUser).toHaveBeenCalledWith(owner.id, {
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
    })
  })

  it('GET /preferences под имперсонацией НЕ запрещён — админ видит, что настроено', () => {
    const { controller, listForUser } = makeController()
    const admin = sessionUser({ impersonatorId: 'f7b10000-0000-4007-b000-000000000002' })

    expect(() => controller.getPreferences(admin)).not.toThrow()
    expect(listForUser).toHaveBeenCalledWith(admin.id)
  })
})
