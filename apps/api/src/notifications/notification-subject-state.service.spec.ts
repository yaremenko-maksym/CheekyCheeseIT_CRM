/**
 * `NotificationSubjectStateService` — unit tests (бэклог 208).
 *
 * Раньше этот код тестировался ТОЛЬКО как приватный `resolveSubjectStates` /
 * `loadSubjectStates` внутри `NotificationsService` (единственный вызывающий
 * был `listForUser`, ветка PROJECT). Теперь сервис отдельный и у него два
 * вызывающих — попап и крон (`resolveOne`) — и здесь проверяются ВСЕ пять
 * веток `loadSubjectStates` (PROJECT/TEAM/USER/TRANSACTION/EMPLOYEE_CONTRACT
 * default), не только та, которой хватало попапу.
 *
 * Условия отбора компилируются в настоящий SQL и ПРИМЕНЯЮТСЯ к строкам — как
 * их применила бы база, а не «заглушка отдаёт всё, что дали» (тот же приём,
 * что в `notifications.service.spec.ts`, откуда этот код переехал —
 * `PgDialect().sqlToQuery` вместо разбора внутренностей drizzle руками).
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { ApprovalStatus } from '@crm/shared'
import {
  approvals,
  employeeContracts,
  nonDeletedTransactions,
  projects,
  teams,
  users,
} from '../database/schema'
import type { DatabaseService } from '../database/database.service'
import { NotificationSubjectStateService } from './notification-subject-state.service'
import type { SubjectRef } from './notification-subject-resolver'

/** Компилирует условие drizzle и проверяет его против одной строки-сида. */
function matchesWhere(
  condition: unknown,
  row: Record<string, unknown>,
  columns: Record<string, string>,
): boolean {
  const compiled = new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0])
  const inner =
    compiled.sql.startsWith('(') && compiled.sql.endsWith(')')
      ? compiled.sql.slice(1, -1)
      : compiled.sql
  for (const part of inner.split(/\s+and\s+/i)) {
    const isNullMatch = /"[^"]+"\."([^"]+)"\s+is\s+null/i.exec(part)
    if (isNullMatch) {
      const field = columns[isNullMatch[1] as string]
      if (field === undefined) throw new Error(`заглушка не знает колонку: ${isNullMatch[1]}`)
      if (row[field] !== null) return false
      continue
    }
    const inMatch = /"[^"]+"\."([^"]+)"\s+in\s+\(([^)]+)\)/i.exec(part)
    if (inMatch) {
      const field = columns[inMatch[1] as string]
      if (field === undefined) throw new Error(`заглушка не знает колонку: ${inMatch[1]}`)
      const values = (inMatch[2] as string)
        .split(',')
        .map((p) => compiled.params[Number(p.trim().slice(1)) - 1])
      if (!values.includes(row[field])) return false
      continue
    }
    const eqMatch = /"[^"]+"\."([^"]+)"\s*=\s*\$(\d+)/.exec(part)
    if (eqMatch) {
      const field = columns[eqMatch[1] as string]
      if (field === undefined) throw new Error(`заглушка не знает колонку: ${eqMatch[1]}`)
      if (row[field] !== compiled.params[Number(eqMatch[2]) - 1]) return false
      continue
    }
    throw new Error(`заглушка не понимает условие: ${part}`)
  }
  return true
}

const APPROVALS_COLUMNS: Record<string, string> = {
  id: 'id',
  superseded_at: 'supersededAt',
  approver_user_id: 'approverUserId',
}
const ARCHIVABLE_COLUMNS: Record<string, string> = { id: 'id', archived_at: 'archivedAt' }
const CONTRACT_COLUMNS: Record<string, string> = { id: 'id', status: 'status' }

type ApprovalSeed = {
  id: string
  status: ApprovalStatus
  approverUserId: string
  supersededAt: Date | null
}
type ArchivableSeed = { id: string; archivedAt: Date | null }
type ContractSeed = { id: string; status: string }

function makeService(seed: {
  approvals?: ApprovalSeed[]
  projects?: ArchivableSeed[]
  teams?: ArchivableSeed[]
  users?: ArchivableSeed[]
  transactions?: { id: string }[]
  employeeContracts?: ContractSeed[]
}): NotificationSubjectStateService {
  const db = {
    db: {
      select: (_fields?: unknown) => ({
        from: (t: unknown) => {
          if (t === approvals) {
            return {
              where: async (cond: unknown) =>
                (seed.approvals ?? [])
                  .filter((r) =>
                    matchesWhere(cond, r as unknown as Record<string, unknown>, APPROVALS_COLUMNS),
                  )
                  .map((r) => ({ id: r.id, status: r.status })),
            }
          }
          if (t === projects) {
            return {
              where: async (cond: unknown) =>
                (seed.projects ?? []).filter((r) =>
                  matchesWhere(cond, r as unknown as Record<string, unknown>, ARCHIVABLE_COLUMNS),
                ),
            }
          }
          if (t === teams) {
            return {
              where: async (cond: unknown) =>
                (seed.teams ?? []).filter((r) =>
                  matchesWhere(cond, r as unknown as Record<string, unknown>, ARCHIVABLE_COLUMNS),
                ),
            }
          }
          if (t === users) {
            return {
              where: async (cond: unknown) =>
                (seed.users ?? []).filter((r) =>
                  matchesWhere(cond, r as unknown as Record<string, unknown>, ARCHIVABLE_COLUMNS),
                ),
            }
          }
          if (t === nonDeletedTransactions) {
            return {
              where: async (cond: unknown) =>
                (seed.transactions ?? []).filter((r) =>
                  matchesWhere(cond, r as unknown as Record<string, unknown>, { id: 'id' }),
                ),
            }
          }
          if (t === employeeContracts) {
            return {
              where: async (cond: unknown) =>
                (seed.employeeContracts ?? [])
                  .filter((r) =>
                    matchesWhere(cond, r as unknown as Record<string, unknown>, CONTRACT_COLUMNS),
                  )
                  .map((r) => ({ id: r.id })),
            }
          }
          throw new Error('NotificationSubjectStateService harness: unexpected table in .from()')
        },
      }),
    },
  }
  return new NotificationSubjectStateService(db as unknown as DatabaseService)
}

const ref = (over: Partial<SubjectRef> = {}): SubjectRef => ({
  userId: 'u-1',
  type: 'TEAM_MEMBER_ADDED',
  subjectType: 'TEAM',
  subjectId: 't-1',
  approvalId: null,
  ...over,
})

describe('resolveMany — по видам объекта', () => {
  it('PROJECT активен', async () => {
    const svc = makeService({ projects: [{ id: 'p-1', archivedAt: null }] })
    const [state] = await svc.resolveMany('u-1', [
      ref({ subjectType: 'PROJECT', subjectId: 'p-1' }),
    ])
    expect(state).toBe('active')
  })

  it('PROJECT архивирован', async () => {
    const svc = makeService({ projects: [{ id: 'p-1', archivedAt: new Date('2026-01-01') }] })
    const [state] = await svc.resolveMany('u-1', [
      ref({ subjectType: 'PROJECT', subjectId: 'p-1' }),
    ])
    expect(state).toBe('archived')
  })

  it('TEAM активна', async () => {
    const svc = makeService({ teams: [{ id: 't-1', archivedAt: null }] })
    const [state] = await svc.resolveMany('u-1', [ref({ subjectType: 'TEAM', subjectId: 't-1' })])
    expect(state).toBe('active')
  })

  it('TEAM архивирована', async () => {
    const svc = makeService({ teams: [{ id: 't-1', archivedAt: new Date('2026-01-01') }] })
    const [state] = await svc.resolveMany('u-1', [ref({ subjectType: 'TEAM', subjectId: 't-1' })])
    expect(state).toBe('archived')
  })

  it('USER активен', async () => {
    const svc = makeService({ users: [{ id: 'usr-1', archivedAt: null }] })
    const [state] = await svc.resolveMany('u-1', [ref({ subjectType: 'USER', subjectId: 'usr-1' })])
    expect(state).toBe('active')
  })

  it('USER архивирован (уволен)', async () => {
    const svc = makeService({ users: [{ id: 'usr-1', archivedAt: new Date('2026-01-01') }] })
    const [state] = await svc.resolveMany('u-1', [ref({ subjectType: 'USER', subjectId: 'usr-1' })])
    expect(state).toBe('archived')
  })

  it('TRANSACTION видна в non_deleted_transactions — активна', async () => {
    const svc = makeService({ transactions: [{ id: 'tx-1' }] })
    const [state] = await svc.resolveMany('u-1', [
      ref({ subjectType: 'TRANSACTION', subjectId: 'tx-1' }),
    ])
    expect(state).toBe('active')
  })

  it('TRANSACTION мягко удалена — отсутствует в non_deleted_transactions, missing', async () => {
    const svc = makeService({ transactions: [] })
    const [state] = await svc.resolveMany('u-1', [
      ref({ subjectType: 'TRANSACTION', subjectId: 'tx-1' }),
    ])
    expect(state).toBe('missing')
  })

  it('EMPLOYEE_CONTRACT ждёт подписи (READY_TO_SIGN) — активен', async () => {
    const svc = makeService({
      employeeContracts: [{ id: 'c-1', status: 'READY_TO_SIGN' }],
    })
    const [state] = await svc.resolveMany('u-1', [
      ref({
        type: 'DOCUMENT_SIGN_REQUIRED',
        subjectType: 'EMPLOYEE_CONTRACT',
        subjectId: 'c-1',
      }),
    ])
    expect(state).toBe('active')
  })

  it('EMPLOYEE_CONTRACT уже подписан (не READY_TO_SIGN) — missing, не активен', async () => {
    // Контракты не удаляются — только меняют статус. «Строка есть» здесь
    // ничего не значит: важно, ждёт ли она ещё подписи.
    const svc = makeService({
      employeeContracts: [{ id: 'c-1', status: 'ACTIVE' }],
    })
    const [state] = await svc.resolveMany('u-1', [
      ref({
        type: 'DOCUMENT_SIGN_REQUIRED',
        subjectType: 'EMPLOYEE_CONTRACT',
        subjectId: 'c-1',
      }),
    ])
    expect(state).toBe('missing')
  })

  it('subjectType/subjectId отсутствуют — active без единого запроса', async () => {
    const svc = makeService({})
    const [state] = await svc.resolveMany('u-1', [ref({ subjectType: null, subjectId: null })])
    expect(state).toBe('active')
  })
})

describe('resolveOne — арность входа/выхода один-к-одному', () => {
  it('оборачивает resolveMany пачкой длины один и возвращает единственный ответ', async () => {
    const svc = makeService({ projects: [{ id: 'p-1', archivedAt: null }] })
    const state = await svc.resolveOne('u-1', ref({ subjectType: 'PROJECT', subjectId: 'p-1' }))
    expect(state).toBe('active')
  })

  it('устаревшее согласование — approvalSuperseded (та же строка, что видит попап)', async () => {
    const APPROVAL_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    const svc = makeService({
      projects: [{ id: 'p-1', archivedAt: null }],
      approvals: [
        { id: APPROVAL_UUID, status: 'PENDING', approverUserId: 'u-OTHER', supersededAt: null },
      ],
    })
    const state = await svc.resolveOne('u-1', {
      userId: 'u-1',
      type: 'PROJECT_CONFIRM_REQUIRED',
      subjectType: 'PROJECT',
      subjectId: 'p-1',
      approvalId: APPROVAL_UUID,
    })
    // Строка существует и не погашена, но принадлежит ЧУЖОМУ подтверждающему
    // — читается КАК ОТСУТСТВУЮЩАЯ (SR-L-8), тем же путём для `resolveOne`,
    // что и для `resolveMany`, потому что это один и тот же вызов.
    expect(state).toBe('approvalSuperseded')
  })

  it('объект отсутствует вовсе — missing', async () => {
    const svc = makeService({ projects: [] })
    const state = await svc.resolveOne(
      'u-1',
      ref({ subjectType: 'PROJECT', subjectId: 'p-missing' }),
    )
    expect(state).toBe('missing')
  })
})
