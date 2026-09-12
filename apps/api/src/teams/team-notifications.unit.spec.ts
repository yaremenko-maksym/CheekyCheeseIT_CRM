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
import { makePassThroughEmitInTx } from '../notifications/__test-helpers__/notifications-stub'

const ADMIN: SessionUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN',
  name: 'Админ',
} as SessionUser

/**
 * `role: null` — строка членства, у которой не подтянулся пользователь.
 * В бою так бывает на гонке с удалением профиля; проверяется, что рассылка от
 * этого не падает, а не то, что так «должно» быть.
 */
type MemberSeed = { id: string; userId: string; role: string | null; leftAt: Date | null }

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
    emitInTx: makePassThroughEmitInTx(),
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
              user: m.role === null ? undefined : { id: m.userId, role: m.role },
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
    // Возврат снимает ИМЕННО отметку об уходе и ничего больше: пустая правка
    // оставила бы человека вне команды, а уведомление — уже разосланным.
    expect(h.updated[0]).toEqual({ leftAt: null })
    expect(h.inserted).toHaveLength(0)
    expect(h.created.map((c) => c['userId'])).toEqual(['hr-1', 'senior-1'])
  })

  it('свежая вставка кладёт ровно пару «команда — человек»', async () => {
    const h = makeHarness({
      members: [{ id: 'm-1', userId: 'senior-1', role: 'SENIOR', leftAt: null }],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
    })

    await h.svc.addMember('team-1', 'hr-1', ADMIN)

    expect(h.inserted).toEqual([{ teamId: 'team-1', userId: 'hr-1' }])
    expect(h.updated).toHaveLength(0)
  })

  it('добавивший САМ СЕБЯ не получает письма о себе — своё подтверждает тост', async () => {
    // §8.1: колокольчик — для входящего. Человек, нажавший кнопку, и так
    // видит результат; уведомление себе было бы эхом собственного действия.
    //
    // Подстраховка, а не бой: активное членство отсекается выше («уже
    // участник»), поэтому кадровик, добавляющий сам себя, до рассылки в бою не
    // доходит. Заглушка членства (`existingMembership` не задан) описывает
    // именно тот случай, ради которого условие и стоит.
    const HR: SessionUser = { ...ADMIN, id: 'hr-self', role: 'HR' } as SessionUser
    const h = makeHarness({
      members: [
        { id: 'm-1', userId: 'hr-self', role: 'HR', leftAt: null },
        { id: 'm-2', userId: 'senior-1', role: 'SENIOR', leftAt: null },
      ],
      addedUser: { id: 'hr-self', role: 'HR', displayName: 'Кадровик' },
    })

    await h.svc.addMember('team-1', 'hr-self', HR)

    expect(h.created.map((c) => c['userId'])).toEqual(['senior-1'])
  })

  it('участник без подтянутого профиля рассылку не роняет', async () => {
    const h = makeHarness({
      members: [
        { id: 'm-1', userId: 'ghost-1', role: null, leftAt: null },
        { id: 'm-2', userId: 'senior-1', role: 'SENIOR', leftAt: null },
      ],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
    })

    await h.svc.addMember('team-1', 'hr-1', ADMIN)

    expect(h.created.map((c) => c['userId'])).toEqual(['hr-1', 'ghost-1', 'senior-1'])
  })

  /**
   * SR-M-1 (security-review круг 1). Обратная сторона предыдущего случая — и
   * ровно та, которую предыдущий тест закреплял в опасную сторону: если у
   * строки членства не подтянулся профиль, роль НЕИЗВЕСТНА, и решать, что
   * такому участнику можно показать имя джуна, нельзя.
   *
   * В этом же файле сервиса `mapTeam` / `mapDropTeam` после #541 трактуют
   * оборванную личность как САМУЮ ОГРАНИЧЕННУЮ роль («a dangling identity is
   * treated as the MOST restricted role, not the least»). Производитель обязан
   * идти в ту же сторону: иначе колокольчик рассказывает то, что экран прячет.
   */
  it('о новом ДЖУНЕ участник без профиля не узнаёт — неизвестная роль = самая ограниченная', async () => {
    const h = makeHarness({
      members: [
        { id: 'm-1', userId: 'ghost-1', role: null, leftAt: null },
        { id: 'm-2', userId: 'senior-1', role: 'SENIOR', leftAt: null },
        { id: 'm-3', userId: 'acc-1', role: 'ACCOUNTANT', leftAt: null },
      ],
      addedUser: { id: 'junior-1', role: 'JUNIOR', displayName: 'Пётр Джунов' },
    })

    await h.svc.addMember('team-1', 'junior-1', ADMIN)

    // Рассылка при этом НЕ падает и не схлопывается: бухгалтер узнаёт, сам
    // добавленный узнаёт. Молчат только те, кому имя джуна не положено.
    expect(h.created.map((c) => c['userId'])).toEqual(['junior-1', 'acc-1'])
    const names = h.created.map((c) => JSON.stringify(c['data']))
    expect(names.filter((n) => n.includes('Пётр Джунов'))).toHaveLength(1)
  })

  it('добавленный не получает ВТОРОГО письма как «участник команды»', async () => {
    // Подстраховка, а не бой: активное членство отсекается выше («уже
    // участник»), поэтому сам себя в списке участников добавляемый увидеть не
    // должен. Если увидит — про себя же он узнает дважды, и порядок строк в
    // колокольчике станет бессмысленным.
    const h = makeHarness({
      members: [
        { id: 'm-1', userId: 'hr-1', role: 'HR', leftAt: null },
        { id: 'm-2', userId: 'senior-1', role: 'SENIOR', leftAt: null },
      ],
      addedUser: { id: 'hr-1', role: 'HR', displayName: 'Иван Петров' },
    })

    await h.svc.addMember('team-1', 'hr-1', ADMIN)

    expect(h.created.map((c) => c['userId'])).toEqual(['hr-1', 'senior-1'])
    expect(h.created.filter((c) => c['userId'] === 'hr-1')).toHaveLength(1)
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
