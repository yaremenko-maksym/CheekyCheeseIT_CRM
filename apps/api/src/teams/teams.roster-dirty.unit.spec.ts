import type { SessionUser } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markSeniorDirty, markSeniorsDirty } from '../job-sourcing/dirty-producers'
import { makeNotificationsStub } from '../notifications/__test-helpers__/notifications-stub'
import { TeamsService } from './teams.service'

// r5 4.6 S5 (CR-M-6): the producer is inert here; its own behaviour is proven in its own specs.
vi.mock('../job-sourcing/dirty-producers')

/**
 * r5 Task 4.6 S5 fix round 2 (CR-M-6): the two DROP-team roster hooks of `TeamsService` that no
 * unit spec drove — the senior detach in `archiveDropTeam` and the senior swap in `rotateSenior` —
 * against a queue-driven mock, so the mutation gate covers them (the real-DB proof of
 * `rotateSenior` is `dirty-producers.services.integration.spec.ts`).
 */
const admin = { id: 'admin-1', role: 'ADMIN' } as SessionUser
const TEAM = { id: 'team-1', name: 'D', type: 'DROP', archivedAt: null, telegramChannel: null }

/** A handle whose every select resolves to the next queued result; writes resolve to `[TEAM]`. */
function handle(selects: unknown[][]) {
  const queue = [...selects]
  const writes: string[] = []
  const chain = (result: () => unknown): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'innerJoin', 'for', 'limit', 'orderBy', 'set', 'values'])
      c[m] = () => c
    c['returning'] = () => Promise.resolve(result())
    c['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(ok, ko)
    return c
  }
  const h: Record<string, unknown> = {
    select: () => chain(() => queue.shift() ?? []),
    update: (t: unknown) => (writes.push(`update:${tableName(t)}`), chain(() => [TEAM])),
    insert: (t: unknown) => (writes.push(`insert:${tableName(t)}`), chain(() => [TEAM])),
  }
  h['transaction'] = (cb: (t: unknown) => unknown) => cb(h)
  return { h, writes }
}

const tableName = (t: unknown) =>
  String((t as Record<symbol, unknown>)[Symbol.for('drizzle:Name')] ?? '?')

function service(h: unknown) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) }
  return new TeamsService({ db: h } as never, {} as never, audit as never, makeNotificationsStub())
}

describe('TeamsService DROP-team roster hooks (S5)', () => {
  beforeEach(() => {
    vi.mocked(markSeniorDirty).mockClear()
    vi.mocked(markSeniorsDirty).mockClear()
  })

  it('archiveDropTeam marks the detached senior dirty on the caller transaction', async () => {
    const { h, writes } = handle([[TEAM], [], [{ id: 'tm-1', userId: 'sn-1' }]])
    await expect(service(h).archiveDropTeam('team-1', h as never)).resolves.toEqual({
      archivedProjects: 0,
      detachedSeniorId: 'sn-1',
    })
    expect(vi.mocked(markSeniorDirty).mock.calls).toEqual([[h, 'sn-1', 'senior.team']])
    expect(writes).toEqual(['update:team_members', 'update:teams'])
  })

  it('archiveDropTeam without a senior enqueues nothing', async () => {
    const { h } = handle([[TEAM], [], []])
    await expect(service(h).archiveDropTeam('team-1', h as never)).resolves.toMatchObject({
      detachedSeniorId: null,
    })
    expect(markSeniorDirty).not.toHaveBeenCalled()
  })

  it('rotateSenior marks BOTH seniors dirty in one call on its transaction', async () => {
    const { h, writes } = handle([
      [TEAM],
      [{ id: 'new-1', role: 'SENIOR', archivedAt: null }],
      [],
      [{ id: 'tm-1', userId: 'old-1' }],
    ])
    await expect(service(h).rotateSenior('team-1', 'new-1', admin)).resolves.toEqual(TEAM)
    expect(vi.mocked(markSeniorsDirty).mock.calls).toEqual([[h, ['old-1', 'new-1'], 'senior.team']])
    expect(writes).toEqual(['update:team_members', 'insert:team_members', 'update:teams'])
  })

  it('rotateSenior into a team with no current senior marks only the new one', async () => {
    const { h } = handle([[TEAM], [{ id: 'new-1', role: 'SENIOR', archivedAt: null }], [], []])
    await service(h).rotateSenior('team-1', 'new-1', admin)
    expect(vi.mocked(markSeniorsDirty).mock.calls).toEqual([[h, ['new-1'], 'senior.team']])
  })
})
