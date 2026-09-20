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
import { HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
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
  it('impersonatorId задан — 403, updateForUser НЕ вызван', () => {
    const { controller, updateForUser } = makeController()
    const admin = sessionUser({ impersonatorId: 'f7b10000-0000-4007-b000-000000000002' })

    // task-i18n-stage2-task5: apiError() returns a plain HttpException, not
    // `instanceof ForbiddenException` — see the next test for the envelope
    // code this call actually throws.
    expect(() =>
      controller.updatePreferences(admin, {
        items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
      }),
    ).toThrow(HttpException)
    expect(updateForUser).not.toHaveBeenCalled()
  })

  it('код отказа — NOTIFICATION_PREFERENCES_IMPERSONATION (task-i18n-stage2-task5)', () => {
    const { controller } = makeController()
    const admin = sessionUser({ impersonatorId: 'f7b10000-0000-4007-b000-000000000002' })

    let caught: unknown
    try {
      controller.updatePreferences(admin, { items: [] })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HttpException)
    expect((caught as HttpException).getStatus()).toBe(403)
    expect((caught as HttpException).getResponse()).toMatchObject({
      code: 'NOTIFICATION_PREFERENCES_IMPERSONATION',
    })
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
