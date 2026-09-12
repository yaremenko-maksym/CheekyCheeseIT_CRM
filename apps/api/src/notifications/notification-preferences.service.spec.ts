import { describe, expect, it } from 'vitest'
import { NEW_NOTIFICATION_TYPES, notificationPreferencesResponseSchema } from '@crm/shared'
import { NotificationPreferencesService } from './notification-preferences.service'

/**
 * Настройки каналов — AC5 позиции 7a.
 *
 * Заглушка базы держит строки массивом: проверяется ПОВЕДЕНИЕ («ответ несёт
 * все десять типов», «выключение запертого типа не сохраняется»), а не форма
 * запроса. Живая проверка доступа под шестью ролями — в
 * `notification-preferences.rbac.integration.spec.ts`: контроллер стоит за
 * глобальным `JwtAuthGuard`, и мок про guard-цепочку не знает ничего
 * (`.claude/skills/security-review`, паттерн 4).
 */
function makeService(seed: { userId: string; type: string; emailEnabled: boolean }[] = []) {
  const rows = seed.map((s) => ({ ...s }))
  const db = {
    db: {
      select: (_f?: unknown) => ({
        from: (_t: unknown) => ({
          where: async (_p: unknown) => rows.filter((r) => r.userId === scope.userId),
        }),
      }),
      insert: (_t: unknown) => ({
        values: (vals: Record<string, unknown>[]) => ({
          onConflictDoUpdate: async (_c: unknown) => {
            for (const v of vals) {
              const existing = rows.find((r) => r.userId === v['userId'] && r.type === v['type'])
              if (existing) existing.emailEnabled = v['emailEnabled'] as boolean
              else
                rows.push({
                  userId: v['userId'] as string,
                  type: v['type'] as string,
                  emailEnabled: v['emailEnabled'] as boolean,
                })
            }
          },
        }),
      }),
    },
  }
  const scope = { userId: 'u-1' }
  const service = new NotificationPreferencesService(db as never)
  return { service, rows, scope }
}

describe('чтение настроек', () => {
  it('отдаёт все десять типов, даже когда в базе пусто', async () => {
    const { service } = makeService()
    const result = await service.listForUser('u-1')

    expect(result.items).toHaveLength(NEW_NOTIFICATION_TYPES.length)
    // Ответ обязан пройти собственную форму — иначе сервер волен прислать
    // клиенту `locked`, не совпадающий с типом.
    expect(() => notificationPreferencesResponseSchema.parse(result)).not.toThrow()
  })

  it('без записей всё включено', async () => {
    const { service } = makeService()
    const result = await service.listForUser('u-1')
    expect(result.items.every((i) => i.emailEnabled)).toBe(true)
  })

  it('сохранённое выключение видно в ответе', async () => {
    const { service } = makeService([
      { userId: 'u-1', type: 'TRANSACTION_ADDED', emailEnabled: false },
    ])
    const result = await service.listForUser('u-1')
    expect(result.items.find((i) => i.type === 'TRANSACTION_ADDED')?.emailEnabled).toBe(false)
  })

  it('три типа помечены locked, остальные семь — нет', async () => {
    const { service } = makeService()
    const result = await service.listForUser('u-1')
    expect(result.items.filter((i) => i.locked).map((i) => i.type)).toEqual([
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'DOCUMENT_SIGN_REQUIRED',
    ])
  })

  it('запертый тип отдаётся включённым даже при записи «выключено» в базе', async () => {
    // Запись могла остаться от прежней версии или быть вписана руками. Врать
    // про неё пользователю нельзя: он увидел бы выключенный переключатель и
    // продолжал получать письма.
    const { service } = makeService([
      { userId: 'u-1', type: 'DOCUMENT_SIGN_REQUIRED', emailEnabled: false },
    ])
    const result = await service.listForUser('u-1')
    expect(result.items.find((i) => i.type === 'DOCUMENT_SIGN_REQUIRED')?.emailEnabled).toBe(true)
  })

  it('чужие записи не видны', async () => {
    const { service } = makeService([
      { userId: 'u-2', type: 'TRANSACTION_ADDED', emailEnabled: false },
    ])
    const result = await service.listForUser('u-1')
    expect(result.items.find((i) => i.type === 'TRANSACTION_ADDED')?.emailEnabled).toBe(true)
  })
})

describe('запись настроек', () => {
  it('сохраняет выключение и возвращает новое состояние', async () => {
    const { service } = makeService()
    const result = await service.updateForUser('u-1', {
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
    })
    expect(result.items.find((i) => i.type === 'TRANSACTION_ADDED')?.emailEnabled).toBe(false)
  })

  it('повторная запись того же типа перезаписывает, а не плодит строки', async () => {
    const { service, rows } = makeService()
    await service.updateForUser('u-1', {
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
    })
    await service.updateForUser('u-1', {
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: true }],
    })
    expect(rows.filter((r) => r.type === 'TRANSACTION_ADDED')).toHaveLength(1)
    expect(rows[0]!.emailEnabled).toBe(true)
  })

  it('пустой запрос ничего не пишет', async () => {
    const { service, rows } = makeService()
    await service.updateForUser('u-1', { items: [] })
    expect(rows).toHaveLength(0)
  })

  it('пишет ровно тому пользователю, который спросил', async () => {
    const { service, rows } = makeService()
    await service.updateForUser('u-1', {
      items: [{ type: 'TEAM_NEW_MEMBER', emailEnabled: false }],
    })
    expect(rows.every((r) => r.userId === 'u-1')).toBe(true)
  })
})
