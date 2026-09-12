import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { NEW_NOTIFICATION_TYPES, notificationPreferencesResponseSchema } from '@crm/shared'
import { NotificationPreferencesService } from './notification-preferences.service'

/** Текст SQL-фрагмента — единственный способ увидеть, что в нём написано. */
function compiled(fragment: unknown): string {
  return new PgDialect().sqlToQuery(fragment as SQL).sql
}

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
  /** Что сервис попросил у базы — по нему проверяется, что он просит нужное. */
  const calls = {
    selectedFields: [] as string[],
    inserts: 0,
    insertedValues: [] as Record<string, unknown>[],
    conflictTarget: [] as string[],
    conflictSet: {} as Record<string, unknown>,
  }
  const db = {
    db: {
      // Заглушка ПРОЕЦИРУЕТ по запрошенным полям, а не отдаёт строку целиком:
      // сервис, забывший попросить `emailEnabled`, обязан получить строку без
      // него — иначе проверка «сохранённое выключение видно» проходила бы и
      // тогда, когда сервис читает не те колонки.
      select: (fields?: Record<string, { name: string }>) => {
        const names = Object.keys(fields ?? {})
        calls.selectedFields = names
        return {
          from: (_t: unknown) => ({
            where: async (_p: unknown) =>
              rows
                .filter((r) => r.userId === 'u-1')
                .map((r) => {
                  const projected: Record<string, unknown> = {}
                  for (const n of names) projected[n] = (r as Record<string, unknown>)[n]
                  return projected
                }),
          }),
        }
      },
      insert: (_t: unknown) => ({
        values: (vals: Record<string, unknown>[]) => {
          calls.inserts += 1
          calls.insertedValues = vals
          return {
            onConflictDoUpdate: async (c: {
              target: { name: string }[]
              set: Record<string, unknown>
            }) => {
              calls.conflictTarget = (c.target ?? []).map((col) => col.name)
              calls.conflictSet = c.set ?? {}
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
          }
        },
      }),
    },
  }
  const service = new NotificationPreferencesService(db as never)
  return { service, rows, calls }
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

  it('пустой запрос вообще НЕ ходит в базу', async () => {
    // Не «ничего не записал», а «не пытался»: `INSERT … VALUES ()` без строк —
    // синтаксическая ошибка Postgres, и разница между «не пошёл» и «пошёл с
    // пустым списком» тут не стилистическая.
    const { service, rows, calls } = makeService()
    await service.updateForUser('u-1', { items: [] })
    expect(calls.inserts).toBe(0)
    expect(rows).toHaveLength(0)
  })

  it('читает ровно те колонки, из которых строит ответ', async () => {
    const { service, calls } = makeService()
    await service.listForUser('u-1')
    expect(calls.selectedFields.sort()).toEqual(['emailEnabled', 'type'])
  })

  it('конфликт разрешается по паре (пользователь, тип), а значение берётся из запроса', async () => {
    // Цель конфликта — тот же индекс `uq_notification_preferences_user_type`.
    // Промахнись он мимо, Postgres упал бы на «no unique constraint matching»;
    // а `set` без `excluded` перезаписал бы значение старым.
    const { service, calls } = makeService()
    await service.updateForUser('u-1', {
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
    })
    expect(calls.conflictTarget).toEqual(['user_id', 'type'])
    expect(String(compiled(calls.conflictSet['emailEnabled']))).toContain('excluded.email_enabled')
    expect(calls.conflictSet['updatedAt']).toBeInstanceOf(Date)
  })

  it('в базу уходит именно то, что прислал клиент', async () => {
    const { service, calls } = makeService()
    await service.updateForUser('u-1', {
      items: [
        { type: 'TRANSACTION_ADDED', emailEnabled: false },
        { type: 'TEAM_NEW_MEMBER', emailEnabled: true },
      ],
    })
    expect(calls.insertedValues).toEqual([
      { userId: 'u-1', type: 'TRANSACTION_ADDED', emailEnabled: false },
      { userId: 'u-1', type: 'TEAM_NEW_MEMBER', emailEnabled: true },
    ])
  })

  it('пишет ровно тому пользователю, который спросил', async () => {
    const { service, rows } = makeService()
    await service.updateForUser('u-1', {
      items: [{ type: 'TEAM_NEW_MEMBER', emailEnabled: false }],
    })
    expect(rows.every((r) => r.userId === 'u-1')).toBe(true)
  })
})
