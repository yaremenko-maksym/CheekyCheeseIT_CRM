import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openCrmAppSession, type CrmAppSession } from '../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'
import { RESUME_AI_METER_ACCOUNT_KEY, ResumeAiDailyBudget } from './resume-ai-daily-budget'

/**
 * The reservation statement of ResumeAiDailyBudget against a REAL database, AS `crm_app` (so the
 * class-A grant on `job_account_meters` is proven too): the cap refuses call N+1, the UTC day
 * rolls over, concurrent reservations cannot overshoot, and a changed code cap takes effect.
 * Every test uses its own meter key, so runs and tests never share a row.
 */
const KEY_PREFIX = 'cloudflare:resume-spec-'
const freshKey = () => `${KEY_PREFIX}${randomUUID()}`
const at = (iso: string) => new Date(iso)

describe.skipIf(!hasDatabaseUrl())('ResumeAiDailyBudget against Postgres as crm_app', () => {
  let session: CrmAppSession
  let budget: ResumeAiDailyBudget

  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 8 })
    budget = new ResumeAiDailyBudget(session.databaseService)
  }, 120_000)

  afterAll(async () => {
    await session?.admin.query(
      `DELETE FROM job_account_meters WHERE account_key LIKE $1 OR account_key = $2`,
      [`${KEY_PREFIX}%`, RESUME_AI_METER_ACCOUNT_KEY],
    )
    await session?.close()
  })

  async function row(key: string) {
    const { rows } = await session.admin.query<{
      used: string
      limit_amount: string
      window_started_at: Date
      resets_at: Date
    }>(
      `SELECT used, limit_amount, window_started_at, resets_at FROM job_account_meters
        WHERE account_key = $1 AND unit = 'MODEL_CALL' AND window_kind = 'DAY'`,
      [key],
    )
    return rows[0]
  }

  it('reserves exactly the cap, then refuses call N+1', async () => {
    const key = freshKey()
    const now = at('2026-11-17T10:00:00.000Z')
    const results: boolean[] = []
    for (let i = 0; i < 4; i += 1) results.push(await budget.reserveCall(now, key, 3))

    expect(results).toEqual([true, true, true, false])
    expect(await row(key)).toEqual({
      used: '3',
      limit_amount: '3',
      window_started_at: at('2026-11-17T00:00:00.000Z'),
      resets_at: at('2026-11-18T00:00:00.000Z'),
    })
  })

  it('resets at the UTC day boundary, not before', async () => {
    const key = freshKey()
    for (let i = 0; i < 2; i += 1) {
      expect(await budget.reserveCall(at('2026-11-17T08:00:00.000Z'), key, 2)).toBe(true)
    }
    expect(await budget.reserveCall(at('2026-11-17T23:59:59.999Z'), key, 2)).toBe(false)

    expect(await budget.reserveCall(at('2026-11-18T00:00:00.000Z'), key, 2)).toBe(true)
    expect(await row(key)).toMatchObject({
      used: '1',
      window_started_at: at('2026-11-18T00:00:00.000Z'),
      resets_at: at('2026-11-19T00:00:00.000Z'),
    })
  })

  it('concurrent reservations cannot overshoot the cap', async () => {
    const key = freshKey()
    const now = at('2026-11-17T12:00:00.000Z')
    const results = await Promise.all(
      Array.from({ length: 20 }, () => budget.reserveCall(now, key, 5)),
    )

    expect(results.filter(Boolean)).toHaveLength(5)
    expect((await row(key))?.used).toBe('5')
  })

  it('a lowered code cap refuses without an error; a raised one admits again', async () => {
    const key = freshKey()
    const now = at('2026-11-17T12:00:00.000Z')
    for (let i = 0; i < 3; i += 1) await budget.reserveCall(now, key, 3)

    await expect(budget.reserveCall(now, key, 2)).resolves.toBe(false)
    await expect(budget.reserveCall(now, key, 4)).resolves.toBe(true)
    expect(await row(key)).toMatchObject({ used: '4', limit_amount: '4' })
  })

  it('the production meter key passes the table CHECKs', async () => {
    await session.admin.query(`DELETE FROM job_account_meters WHERE account_key = $1`, [
      RESUME_AI_METER_ACCOUNT_KEY,
    ])
    await expect(budget.reserveCall(new Date())).resolves.toBe(true)
  })
})
