/**
 * task-notification-types-producers (позиция 6) — производитель уведомлений в
 * `projects`: «ждёт решения: новый проект», «вас добавили в проект» и
 * проектная половина «ждёт решения: новая доля».
 *
 * Все три пишутся в ТОЙ ЖЕ транзакции, что и событие, поэтому заглушка
 * транзакции — единственный источник построителей: запись, созданная мимо неё,
 * тестом просто не будет видна.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CreateProjectDto, SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'
import type { NotificationsService } from '../notifications/notifications.service'
import { makePassThroughEmitInTx } from '../notifications/__test-helpers__/notifications-stub'

const ADMIN: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const SENIOR_ID = 'senior-1'
const DROP_ID = 'drop-1'

const MINIMAL_DTO: CreateProjectDto = {
  name: 'Acme',
  companyName: 'Acme Corp',
  domain: 'Other',
  startDate: '2026-01-01T00:00:00.000Z',
  seniorId: SENIOR_ID,
  rate: 1000,
  currency: 'USDT',
}

function makeNotificationsSpy() {
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
  return { notifications, created }
}

// ---------------------------------------------------------------------------
// create → «ждёт решения: новый проект»
// ---------------------------------------------------------------------------

function buildCreateHarness(dropId?: string) {
  const { notifications, created } = makeNotificationsSpy()
  const userRows: Record<string, unknown> = {
    [SENIOR_ID]: { id: SENIOR_ID, role: 'SENIOR', archivedAt: null },
    [DROP_ID]: { id: DROP_ID, role: 'DROP', archivedAt: null },
  }
  const db = {
    db: {
      query: {
        users: { findFirst: async (args: { where: unknown }) => lookupUser(args, userRows) },
        projects: {
          findFirst: async () => ({
            id: 'proj-new',
            status: 'DRAFT',
            senior: null,
            drop: null,
            members: [],
            legend: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            startDate: new Date(),
          }),
        },
      },
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
        fn({
          insert: () => ({
            values: (values: Record<string, unknown>) => ({
              returning: async () => [{ id: 'proj-new', ...values }],
            }),
          }),
        }),
    },
  }
  const hrAccess = new HrAccessService(db as never)
  const service = new ProjectsService(
    db as never,
    { record: vi.fn(async () => undefined) } as never,
    {} as never,
    hrAccess,
    { proposeInTx: vi.fn(async () => undefined) } as never,
    notifications,
  )
  return { service, created, dto: dropId ? { ...MINIMAL_DTO, dropId } : MINIMAL_DTO }
}

/**
 * `users.findFirst` обслуживает и синьора, и дропа. Заглушка не разбирает
 * условие drizzle — она отдаёт следующего по порядку обращения, что и повторяет
 * фактический порядок в `create` (сначала синьор, затем дроп).
 */
let userLookupCall = 0
function lookupUser(_args: unknown, rows: Record<string, unknown>) {
  userLookupCall += 1
  return userLookupCall === 1 ? rows[SENIOR_ID] : rows[DROP_ID]
}

describe('«ждёт решения: новый проект»', () => {
  it('уходит приглашённому подтверждающему — с названием КОМПАНИИ в данных', async () => {
    userLookupCall = 0
    const h = buildCreateHarness()
    await h.service.create(h.dto, ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: SENIOR_ID,
      type: 'PROJECT_CONFIRM_REQUIRED',
      title: 'Проект ждёт решения',
      subjectType: 'PROJECT',
      subjectId: 'proj-new',
      // ORCH-3 (fix-round 7): `companyName` ('Acme Corp' в `MINIMAL_DTO`),
      // не `name` ('Acme') — регрессия на `inserted.name` ловится тем, что
      // DTO намеренно несёт разные значения.
      data: { projectName: 'Acme Corp' },
    })
  })

  it('проект подтверждают оба — просьба уходит и синьору, и дропу', async () => {
    userLookupCall = 0
    const h = buildCreateHarness(DROP_ID)
    await h.service.create(h.dto, ADMIN)

    expect(h.created.map((c) => c['userId'])).toEqual([SENIOR_ID, DROP_ID])
  })

  it('админ, создавший проект сам себе, себе не пишет', async () => {
    userLookupCall = 0
    const h = buildCreateHarness()
    await h.service.create(h.dto, { ...ADMIN, id: SENIOR_ID } as SessionUser)
    expect(h.created).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// createFromInterview → «ждёт решения: новый проект» (SR-L-1)
// ---------------------------------------------------------------------------

/**
 * SR-L-1 (security-review круг 1). Черновик проекта заводят ДВЕ двери:
 * `create` (руками) и `createFromInterview` (из нанятого собеседования). Обе
 * открывают согласование через `proposeInTx`, но производитель стоял только у
 * первой — синьор, которому прислали проект из собеседования, не узнавал, что
 * от него ждут подтверждения.
 *
 * Это ровно тот риск, который PR сам назвал главным в комментарии к
 * `afterTransactionCreated`: «объём, на котором „обнови везде“ теряет одно
 * место».
 */
function buildFromInterviewHarness() {
  const { notifications, created } = makeNotificationsSpy()
  const inserted: Record<string, unknown>[] = []
  const db = {
    db: {
      query: {
        // Синьор не состоит ни в одной команде — путь досева HR/бухгалтера
        // здесь не проверяется, он не про уведомления.
        teamMembers: { findMany: async () => [] },
      },
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            inserted.push(values)
            return [{ id: 'proj-from-interview', ...values }]
          },
        }),
      }),
    },
  }
  const service = new ProjectsService(
    db as never,
    { record: vi.fn(async () => undefined) } as never,
    {} as never,
    new HrAccessService(db as never),
    { proposeInTx: vi.fn(async () => undefined) } as never,
    notifications,
  )
  const interview = {
    id: 'int-1',
    companyName: 'Acme',
    seniorId: SENIOR_ID,
    notesDomain: 'Other',
    notesTechStack: null,
    senior: null,
  }
  return { service, created, interview }
}

describe('«ждёт решения: новый проект» — вторая дверь, из собеседования', () => {
  it('синьор узнаёт о черновике, созданном из нанятого собеседования', async () => {
    const h = buildFromInterviewHarness()

    await h.service.createFromInterview(h.interview as never, ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: SENIOR_ID,
      type: 'PROJECT_CONFIRM_REQUIRED',
      title: 'Проект ждёт решения',
      subjectType: 'PROJECT',
      subjectId: 'proj-from-interview',
      // ORCH-3 (fix-round 7): производитель читает `project.companyName`
      // (см. `createFromInterview`), но на ЭТОМ пути `name` и `companyName`
      // намеренно равны обе — `interview.companyName` — и различить их этот
      // тест не может; регрессия ловится соседними тестами `create`/
      // `addMember`, где значения различаются.
      data: { projectName: 'Acme' },
    })
  })

  it('синьор, заведший проект из СВОЕГО собеседования, себе не пишет', async () => {
    const h = buildFromInterviewHarness()

    await h.service.createFromInterview(
      h.interview as never,
      {
        ...ADMIN,
        id: SENIOR_ID,
      } as SessionUser,
    )

    expect(h.created).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// addMember → «вас добавили в проект»
// ---------------------------------------------------------------------------

function buildAddMemberHarness(memberRole = 'JUNIOR') {
  const { notifications, created } = makeNotificationsSpy()
  const inserted: unknown[] = []
  const db = {
    db: {
      query: {
        projects: {
          findFirst: async () => ({
            id: 'proj-1',
            name: 'Acme',
            // ORCH-3 (fix-round 7): различается от `name` намеренно — иначе
            // регрессия на `project.name` в производителе не ловилась бы.
            companyName: 'Acme Corp',
            seniorId: SENIOR_ID,
            senior: null,
            drop: null,
            members: [],
          }),
        },
        users: {
          findFirst: async () => ({ id: 'junior-1', role: memberRole, archivedAt: null }),
        },
        projectMembers: { findFirst: async () => undefined },
      },
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
        fn({
          insert: () => ({
            values: async (v: unknown) => {
              inserted.push(v)
            },
          }),
        }),
    },
  }
  const service = new ProjectsService(
    db as never,
    { record: vi.fn(async () => undefined) } as never,
    {} as never,
    new HrAccessService(db as never),
    {} as never,
    notifications,
  )
  return { service, created, inserted }
}

describe('«вас добавили в проект»', () => {
  it('уходит добавленному, с названием КОМПАНИИ — и никому больше', async () => {
    const h = buildAddMemberHarness()
    await h.service.addMember('proj-1', 'junior-1', ADMIN)

    expect(h.inserted).toHaveLength(1)
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'junior-1',
      type: 'PROJECT_MEMBER_ADDED',
      title: 'Вас добавили в проект',
      subjectType: 'PROJECT',
      subjectId: 'proj-1',
      // ORCH-3 (fix-round 7): `companyName`, не `name` — см. комментарий у
      // мока `projects.findFirst` выше.
      data: { projectName: 'Acme Corp' },
    })
  })

  it('отказ по правам не порождает ни членства, ни уведомления', async () => {
    const h = buildAddMemberHarness()
    const junior = { ...ADMIN, id: 'x', role: 'JUNIOR' } as SessionUser
    await expect(h.service.addMember('proj-1', 'junior-1', junior)).rejects.toThrow()
    expect(h.inserted).toHaveLength(0)
    expect(h.created).toHaveLength(0)
  })

  it('роль, которую в проект добавлять нельзя, не порождает уведомления', async () => {
    const h = buildAddMemberHarness('SENIOR')
    await expect(h.service.addMember('proj-1', 'junior-1', ADMIN)).rejects.toThrow()
    expect(h.created).toHaveLength(0)
  })

  it('членство кладётся ровно парой «проект — человек»', async () => {
    const h = buildAddMemberHarness()
    await h.service.addMember('proj-1', 'junior-1', ADMIN)

    // Пустая вставка оставила бы человека вне проекта, а уведомление о
    // добавлении — уже разосланным: обе записи идут одной транзакцией и
    // обязаны говорить одно и то же.
    expect(h.inserted).toEqual([{ projectId: 'proj-1', userId: 'junior-1' }])
  })

  it('добавивший САМ СЕБЯ не получает письма о себе — своё подтверждает тост', async () => {
    // §8.1. Подстраховка, а не бой: кадровик сам себя в проект добавить не
    // может (роль не та), поэтому равенство проверяется на заглушке — ради
    // того случая, ради которого условие и стоит.
    const h = buildAddMemberHarness()
    const self = { ...ADMIN, id: 'junior-1' } as SessionUser

    await h.service.addMember('proj-1', 'junior-1', self)

    expect(h.inserted).toHaveLength(1)
    expect(h.created).toHaveLength(0)
  })

  it('под входом за другого автором считается реальный оператор, и письмо уходит', async () => {
    // Вход за сотрудника: нажимает администратор, значит «своё» — его, а
    // добавленный обязан узнать.
    const h = buildAddMemberHarness()
    const impersonating = { ...ADMIN, id: 'junior-1', impersonatorId: ADMIN.id } as SessionUser

    await h.service.addMember('proj-1', 'junior-1', impersonating)

    expect(h.created.map((c) => c['userId'])).toEqual(['junior-1'])
  })
})

// ---------------------------------------------------------------------------
// шов позиции 5 → «ждёт решения: новая доля» (проектная половина)
// ---------------------------------------------------------------------------

describe('«ждёт решения: новая доля» — проектная половина', () => {
  function callSeam(input: {
    subjectId: string
    approverUserId: string
    proposedPercent: number | null
    previousPercent: number | null
    projectName: string | null
  }) {
    const { notifications, created } = makeNotificationsSpy()
    const service = new ProjectsService(
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

  it('уходит тому, чья доля меняется, с прежним и предложенным процентом', async () => {
    const created = await callSeam({
      subjectId: 'proj-1',
      approverUserId: SENIOR_ID,
      proposedPercent: 30,
      previousPercent: 26,
      projectName: 'Acme',
    })

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      userId: SENIOR_ID,
      type: 'SHARE_CONFIRM_REQUIRED',
      title: 'Предложение по доле',
      subjectType: 'PROJECT',
      subjectId: 'proj-1',
      data: {
        scope: 'PROJECT',
        projectName: 'Acme',
        previousPercent: 26,
        proposedPercent: 30,
      },
    })
  })

  it('заголовок цифр не несёт — они только в данных (§10)', async () => {
    const created = await callSeam({
      subjectId: 'proj-1',
      approverUserId: SENIOR_ID,
      proposedPercent: 30,
      previousPercent: 26,
      projectName: 'Acme',
    })
    expect(String(created[0]?.['title'])).not.toMatch(/\d/)
  })

  it('ключа идемпотентности нет — повторное предложение обязано спросить заново', async () => {
    const created = await callSeam({
      subjectId: 'proj-1',
      approverUserId: SENIOR_ID,
      proposedPercent: null,
      previousPercent: 26,
      projectName: null,
    })
    expect(created[0]?.['dedupeKey']).toBeUndefined()
  })
})
