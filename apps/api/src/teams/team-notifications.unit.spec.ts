/**
 * task-notification-types-producers (позиция 6) — производитель уведомлений в
 * `teams`.
 *
 * Два типа из одного события: добавленному — «вас добавили в команду»,
 * остальным участникам — «в команде новый участник». Проверяется адресация
 * («нужным получателям и никому больше») и то, что обе ветки добавления —
 * свежая вставка и возврат ранее удалённого участника — ведут себя одинаково:
 * человек, вернувшийся в команду, узнаёт об этом так же, как новый.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TeamsService } from './teams.service'
import type { NotificationsService } from '../notifications/notifications.service'

const ADMIN: SessionUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN',
  name: 'Админ',
} as SessionUser

type MemberSeed = { id: string; userId: string; role: string; leftAt: Date | null }

function makeHarness(opts: {
  members: MemberSeed[]
  addedUser: { id: string; role: string; displayName: string; archivedAt?: Date | null }
  existingMembership?: { id: string; leftAt: Date | null }
}) {
  const created: Record<string, unknown>[] = []
  const notifications = {
    createInTx: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => {
      created.push(input)
      return null
    }),
    createManyInTx: vi.fn(async (_tx: unknown, inputs: Record<string, unknown>[]) => {
      created.push(...inputs)
    }),
  } as unknown as NotificationsService

  const inserted: unknown[] = []
  const updated: unknown[] = []
  const txHandle = {
    insert: () => ({
      values: async (v: unknown) => {
        inserted.push(v)
      },
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: async () => {
          updated.push(v)
        },
      }),
    }),
  }

  const db = {
    db: {
      query: {
        teams: {
          findFirst: async () => ({
            id: 'team-1',
            name: 'Alpha',
            members: opts.members.map((m) => ({
              id: m.id,
              userId: m.userId,
              leftAt: m.leftAt,
              user: { id: m.userId, role: m.role },
            })),
          }),
        },
        users: {
          findFirst: async () => ({ archivedAt: null, ...opts.addedUser }),
        },
        teamMembers: { findFirst: async () => opts.existingMembership },
        projects: { findMany: async () => [] },
      },
      transaction: async <T>(cb: (t: unknown) => Promise<T>): Promise<T> => cb(txHandle),
    },
  } as never

  const svc = new TeamsService(db, {} as never, { record: vi.fn() } as never, notifications)
  return { svc, created, inserted, updated }
}

describe('«вас добавили в команду» и «в команде новый участник»', () => {
  it('добавленный узнаёт про себя, остальные активные — про него, и никто больше', async () => {
    const h = makeHarness({
      members: [
        { id: 'm-1', userId: 'senior-1', role: 'SENIOR', leftAt: null },
        { id: 'm-2', userId: 'junior-9', role: 'JUNIOR', leftAt: new Date() },
      ],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
    })

    await h.svc.addMember('team-1', 'hr-1', ADMIN)

    expect(h.created.map((c) => [c['userId'], c['type']])).toEqual([
      ['hr-1', 'TEAM_MEMBER_ADDED'],
      ['senior-1', 'TEAM_NEW_MEMBER'],
    ])
  })

  it('добавленному — название команды; остальным — ещё и имя новичка', async () => {
    const h = makeHarness({
      members: [{ id: 'm-1', userId: 'senior-1', role: 'SENIOR', leftAt: null }],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
    })

    await h.svc.addMember('team-1', 'hr-1', ADMIN)

    expect(h.created[0]).toMatchObject({
      title: 'Вас добавили в команду',
      subjectType: 'TEAM',
      subjectId: 'team-1',
      data: { teamName: 'Alpha' },
    })
    expect(h.created[1]).toMatchObject({
      title: 'В команде новый участник',
      subjectType: 'TEAM',
      subjectId: 'team-1',
      secondaryId: 'hr-1',
      data: { teamName: 'Alpha', memberName: 'Иван Петров' },
    })
  })

  it('вернувшийся участник узнаёт так же, как новый (ветка реактивации)', async () => {
    const h = makeHarness({
      members: [{ id: 'm-1', userId: 'senior-1', role: 'SENIOR', leftAt: null }],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
      existingMembership: { id: 'm-old', leftAt: new Date() },
    })

    await h.svc.addMember('team-1', 'hr-1', ADMIN)

    expect(h.updated).toHaveLength(1)
    expect(h.created.map((c) => c['userId'])).toEqual(['hr-1', 'senior-1'])
  })

  it('администратор, добавляющий сам себя в свою же команду, себе не пишет', async () => {
    const h = makeHarness({
      members: [{ id: 'm-1', userId: ADMIN.id, role: 'HR', leftAt: null }],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
    })

    await h.svc.addMember('team-1', 'hr-1', ADMIN)

    expect(h.created.map((c) => c['userId'])).toEqual(['hr-1'])
  })

  it('отказ по правам не порождает ни членства, ни уведомления', async () => {
    const h = makeHarness({
      members: [],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
    })
    const junior = { ...ADMIN, id: 'junior-1', role: 'JUNIOR' } as SessionUser

    await expect(h.svc.addMember('team-1', 'hr-1', junior)).rejects.toThrow()
    expect(h.inserted).toHaveLength(0)
    expect(h.created).toHaveLength(0)
  })

  // Раскрытие. `mapTeam` прячет джунов от синьора целиком, а от другого джуна —
  // всех, кроме него самого. Колокольчик обязан подчиняться тому же контуру:
  // иначе он рассказывал бы то, что экран прячет.
  it('о новом ДЖУНЕ не узнаёт ни синьор, ни другой джун — а бухгалтер узнаёт', async () => {
    const h = makeHarness({
      members: [
        { id: 'm-1', userId: 'senior-1', role: 'SENIOR', leftAt: null },
        { id: 'm-2', userId: 'junior-2', role: 'JUNIOR', leftAt: null },
        { id: 'm-3', userId: 'acc-1', role: 'ACCOUNTANT', leftAt: null },
      ],
      addedUser: { id: 'junior-1', role: 'JUNIOR', displayName: 'Пётр Иванов' },
    })

    await h.svc.addMember('team-1', 'junior-1', ADMIN)

    expect(h.created.map((c) => c['userId'])).toEqual(['junior-1', 'acc-1'])
  })

  it('о новом синьоре джун узнаёт — его личность экран и так показывает', async () => {
    const h = makeHarness({
      members: [{ id: 'm-2', userId: 'junior-2', role: 'JUNIOR', leftAt: null }],
      addedUser: { id: 'senior-1', role: 'SENIOR', displayName: 'Сергей Синьоров' },
    })

    await h.svc.addMember('team-1', 'senior-1', ADMIN)

    expect(h.created.map((c) => c['userId'])).toEqual(['senior-1', 'junior-2'])
  })

  it('повторное добавление активного участника отклоняется — и молчит', async () => {
    const h = makeHarness({
      members: [{ id: 'm-1', userId: 'hr-1', role: 'HR', leftAt: null }],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
      existingMembership: { id: 'm-1', leftAt: null },
    })

    await expect(h.svc.addMember('team-1', 'hr-1', ADMIN)).rejects.toThrow()
    expect(h.created).toHaveLength(0)
  })
})
