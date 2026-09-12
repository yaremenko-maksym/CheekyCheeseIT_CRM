/**
 * `GET` / `PUT /api/notifications/preferences` под ШЕСТЬЮ ролями, через
 * настоящий `JwtAuthGuard` и настоящую Postgres — AC5 позиции 7a.
 *
 * Почему через HTTP, а не вызовом сервиса: «замоканная спека ничего не знает
 * про глобальные guard'ы» — рецидив трижды в этом проекте
 * (`.claude/skills/security-review`, паттерн 4; инцидент #110). Вызов метода
 * сервиса напрямую доказал бы, что метод работает, и ничего не сказал бы о
 * том, доступна ли ручка и кому.
 *
 * Что здесь проверяется и чего тут НЕТ. Настройка СВОЕЙ почты — не
 * привилегия: все шесть ролей работают с ней одинаково, и ролевого запрета
 * тут нет намеренно. Проверяется поэтому другое — то, что делает отсутствие
 * запрета безопасным: **идентификатора пользователя нет ни в пути, ни в теле
 * запроса**, поэтому чужие настройки нельзя ни прочитать, ни записать, как ни
 * составляй запрос. Плюс сам запрет §3: письмо у типа, требующего действия,
 * не выключается.
 *
 * Рига повторяет `personal-email-controller-guards.rbac.integration.spec.ts`
 * (включая `Object.assign` поверх DI — `design:paramtypes` под vite/esbuild не
 * эмитится), но с ЖИВОЙ базой: настройки читаются и пишутся по-настоящему,
 * иначе «сохранилось» проверялось бы моком, который сам же и сохранил.
 */
import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { notificationPreferences, users } from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { NotificationPreferencesService } from './notification-preferences.service'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'
import { ZodExceptionFilter } from '../zod-exception.filter'

const JWT_SECRET = 'notification-preferences-rbac-secret-32-chars'

type Role = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'
interface Persona {
  id: string
  email: string
  role: Role
}

// Пространство идентификаторов: f7b10000-**-4007-b**-**
const PERSONAS: Persona[] = [
  { id: 'f7b10000-0000-4007-b000-000000000001', email: 'np-admin@test.spec', role: 'ADMIN' },
  { id: 'f7b10000-0000-4007-b000-000000000002', email: 'np-senior@test.spec', role: 'SENIOR' },
  { id: 'f7b10000-0000-4007-b000-000000000003', email: 'np-junior@test.spec', role: 'JUNIOR' },
  { id: 'f7b10000-0000-4007-b000-000000000004', email: 'np-hr@test.spec', role: 'HR' },
  { id: 'f7b10000-0000-4007-b000-000000000005', email: 'np-acct@test.spec', role: 'ACCOUNTANT' },
  { id: 'f7b10000-0000-4007-b000-000000000006', email: 'np-drop@test.spec', role: 'DROP' },
]
const ALL_IDS = PERSONAS.map((p) => p.id)

let pool: Pool
let db: ReturnType<typeof drizzle<typeof schema>>

const ROLE_ROWS = new Map<string, { role: Role; archivedAt: Date | null }>(
  PERSONAS.map((p) => [p.id, { role: p.role, archivedAt: null }]),
)
// `JwtAuthGuard` перечитывает роль и архивность через `UsersService.findById` —
// единственный метод, который ему нужен.
const usersServiceStub = { findById: (id: string) => Promise.resolve(ROLE_ROWS.get(id)) }

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [NotificationsController],
  providers: [
    Reflector,
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) =>
        new JwtAuthGuard(jwtSvc, reflector, usersServiceStub as never),
      inject: [JwtService, Reflector],
    },
  ],
})
class PreferencesTestModule {}

describe.skipIf(!hasDatabaseUrl())('настройки каналов под шестью ролями (позиция 7a)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    await assertRealDbSchema([{ table: 'notification_preferences', column: 'email_enabled' }])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    db = drizzle(pool, { schema })
    const dbService = { db } as unknown as DatabaseService

    const moduleRef = await Test.createTestingModule({ imports: [PreferencesTestModule] }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'notification-preferences-cookie-secret' })
    app.setGlobalPrefix('api')
    // Тот же фильтр, что `main.ts` ставит глобально: без него `ZodError`
    // всплывает как 500, и «сервер отверг запись» было бы неотличимо от
    // «сервер сломался». Рига обязана повторять продовую обработку ошибок —
    // иначе она проверяет не тот ответ, который получит клиент.
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)

    // См. шапку: под vite/esbuild нет `design:paramtypes`, и Nest строит
    // контроллер с пустыми полями. Проставляются после сборки — тот же приём,
    // что в риге `personal-email-controller-guards`.
    Object.assign(app.get(NotificationsController), {
      svc: new NotificationsService(dbService, { recordError: () => Promise.resolve() } as never),
      prefs: new NotificationPreferencesService(dbService),
    })
  })

  afterAll(async () => {
    await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, ALL_IDS))
    await db.delete(users).where(inArray(users.id, ALL_IDS))
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, ALL_IDS))
    await db.delete(users).where(inArray(users.id, ALL_IDS))
    await db.insert(users).values(
      PERSONAS.map((p) => ({
        id: p.id,
        email: p.email,
        displayName: p.role,
        role: p.role,
      })),
    )
  })

  const tokenFor = (p: Persona) => jwt.sign({ id: p.id, email: p.email, role: p.role })

  async function get(p: Persona) {
    return app.inject({
      method: 'GET',
      url: '/api/notifications/preferences',
      cookies: { jwt: tokenFor(p) },
    })
  }
  async function put(p: Persona, payload: unknown) {
    return app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      cookies: { jwt: tokenFor(p) },
      payload: payload as object,
    })
  }

  describe('доступ', () => {
    it('без куки — 401, а не пустые настройки', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/notifications/preferences' })
      expect(res.statusCode).toBe(401)
    })

    for (const persona of PERSONAS) {
      it(`${persona.role} читает свои настройки — 200 и все десять типов`, async () => {
        const res = await get(persona)
        expect(res.statusCode).toBe(200)
        const body = res.json<{ items: { type: string; locked: boolean }[] }>()
        expect(body.items).toHaveLength(10)
        expect(body.items.filter((i) => i.locked)).toHaveLength(3)
      })
    }

    for (const persona of PERSONAS) {
      it(`${persona.role} пишет свои настройки — 200 и запись видна`, async () => {
        const res = await put(persona, {
          items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
        })
        expect(res.statusCode).toBe(200)

        const stored = await db
          .select()
          .from(notificationPreferences)
          .where(inArray(notificationPreferences.userId, [persona.id]))
        expect(stored).toHaveLength(1)
        expect(stored[0]!.emailEnabled).toBe(false)
      })
    }
  })

  describe('чужие настройки недостижимы', () => {
    it('настройки одного не видны другому', async () => {
      const [admin, senior] = PERSONAS
      await put(admin!, { items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }] })

      const res = await get(senior!)
      const body = res.json<{ items: { type: string; emailEnabled: boolean }[] }>()
      expect(body.items.find((i) => i.type === 'TRANSACTION_ADDED')?.emailEnabled).toBe(true)
    })

    it('подложенный в тело чужой userId ничего не меняет', async () => {
      // Единственная форма IDOR, доступная на этой ручке, — попытаться
      // назвать чужого в теле. Схема такого поля не знает, и запись всё равно
      // уходит владельцу куки.
      const [admin, senior] = PERSONAS
      const res = await put(admin!, {
        userId: senior!.id,
        items: [{ type: 'TEAM_NEW_MEMBER', emailEnabled: false }],
      })
      expect(res.statusCode).toBe(200)

      const seniorRows = await db
        .select()
        .from(notificationPreferences)
        .where(inArray(notificationPreferences.userId, [senior!.id]))
      expect(seniorRows).toHaveLength(0)
    })
  })

  describe('запрет §3 держится на сервере', () => {
    for (const type of [
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'DOCUMENT_SIGN_REQUIRED',
    ]) {
      it(`${type}: попытка выключить письмо — 400 и ничего не записано`, async () => {
        const [admin] = PERSONAS
        const res = await put(admin!, { items: [{ type, emailEnabled: false }] })
        expect(res.statusCode).toBe(400)

        const rows = await db
          .select()
          .from(notificationPreferences)
          .where(inArray(notificationPreferences.userId, [admin!.id]))
        expect(rows).toHaveLength(0)
      })
    }

    it('неизвестный тип — 400', async () => {
      const [admin] = PERSONAS
      const res = await put(admin!, { items: [{ type: 'NOT_A_TYPE', emailEnabled: false }] })
      expect(res.statusCode).toBe(400)
    })

    it('повторная правка перезаписывает, а не плодит строки', async () => {
      const [admin] = PERSONAS
      await put(admin!, { items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }] })
      await put(admin!, { items: [{ type: 'TRANSACTION_ADDED', emailEnabled: true }] })

      const rows = await db
        .select()
        .from(notificationPreferences)
        .where(inArray(notificationPreferences.userId, [admin!.id]))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.emailEnabled).toBe(true)
    })
  })
})
