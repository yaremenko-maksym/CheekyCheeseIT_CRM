import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../schema'
import { HR2_ID, SENIOR_SHARED_ID } from './ids'
import { d, type SeedDb } from './shared'
import { seedTeams } from './teams'

/**
 * Task 7.6a — the memberships the job-queue E2E reads its scopes from: U-HR2 in Team Kovalenko,
 * S-SHARED in Team Kovalenko and Team Marchenko. A recording fake db captures every inserted row.
 */
const recordInserts = () => {
  const inserts: { table: unknown; values: unknown; rows: { id: string }[] }[] = []
  const db = {
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const rows = [{ id: `row-${inserts.length + 1}` }]
        inserts.push({ table, values, rows })
        return Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) })
      },
    }),
  } as unknown as SeedDb
  return { db, inserts }
}

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => undefined))
afterEach(() => vi.restoreAllMocks())

describe('seedTeams — the job-queue E2E memberships', () => {
  it('puts U-HR2 in Team Kovalenko and S-SHARED in Team Kovalenko and Team Marchenko', async () => {
    const { db, inserts } = recordInserts()
    await seedTeams({ db })
    const teamId = (name: string) =>
      inserts.find((i) => i.table === schema.teams && (i.values as { name: string }).name === name)!
        .rows[0]!.id
    const members = inserts
      .filter((i) => i.table === schema.teamMembers)
      .flatMap((i) => i.values as unknown[])
    const joinedAt = d(2025, 11, 15)
    expect(members).toContainEqual({ teamId: teamId('Team Kovalenko'), userId: HR2_ID, joinedAt })
    expect(members).toContainEqual({
      teamId: teamId('Team Kovalenko'),
      userId: SENIOR_SHARED_ID,
      joinedAt,
    })
    expect(members).toContainEqual({
      teamId: teamId('Team Marchenko'),
      userId: SENIOR_SHARED_ID,
      joinedAt,
    })
  })
})
