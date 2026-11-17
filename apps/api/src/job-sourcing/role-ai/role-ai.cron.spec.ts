import { afterEach, describe, expect, it, vi } from 'vitest'
import { productionLedgerCatalog } from '../runtime/production-catalog'
import { runRoleAiPass } from './role-ai-pass'
import { JobRoleAiCronService } from './role-ai.cron'

vi.mock('./role-ai-pass', async (orig) => ({
  ...(await orig<typeof import('./role-ai-pass')>()),
  runRoleAiPass: vi.fn(),
}))

const pass = vi.mocked(runRoleAiPass)
const RESULT = { classified: 1, unclear: 0, failed: 0, stoppedBy: null }

function setup(enabled?: boolean | string) {
  const database = {
    get db(): unknown {
      throw new Error('the cron itself never reads the database')
    },
  }
  const client = { classify: vi.fn() }
  const config = {
    get: vi.fn((key: string) => (key === 'JOB_ROLE_AI_DAILY_BUDGET' ? 23 : enabled)),
  }
  const svc = new JobRoleAiCronService(database as never, client as never, config as never)
  const error = vi
    .spyOn((svc as unknown as { logger: { error: () => void } }).logger, 'error')
    .mockImplementation(() => undefined)
  const warn = vi
    .spyOn((svc as unknown as { logger: { warn: () => void } }).logger, 'warn')
    .mockImplementation(() => undefined)
  return { svc, client, config, error, warn }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('JobRoleAiCronService', () => {
  it.each([undefined, false, 'true'])(
    'tick() makes no DB read and no client call when JOB_ROLE_AI_ENABLED is %s, not true',
    async (enabled) => {
      const { svc, client, config } = setup(enabled)
      await svc.tick()
      expect(config.get).toHaveBeenCalledWith('JOB_ROLE_AI_ENABLED', { infer: true })
      expect(pass).not.toHaveBeenCalled()
      expect(client.classify).not.toHaveBeenCalled()
    },
  )

  it('tick() is a no-op without a config service', async () => {
    const svc = new JobRoleAiCronService({} as never, { classify: vi.fn() } as never)
    await svc.tick()
    expect(pass).not.toHaveBeenCalled()
  })

  it('tick() runs one pass when the flag is true; an overlapping tick is skipped', async () => {
    const { svc, client, warn } = setup(true)
    let release: (v: typeof RESULT) => void = () => undefined
    pass.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    const first = svc.tick()
    await svc.tick()
    expect(pass).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith({ event: 'ROLE_AI_TICK_SKIPPED', reason: 'RUNNING' })
    const deps = pass.mock.calls[0]?.[0]
    expect(deps?.client).toBe(client)
    expect(deps?.onDemandTypes).toEqual(productionLedgerCatalog().onDemandTypes())
    expect(deps?.now()).toBeInstanceOf(Date)
    expect(deps?.dailyBudget).toBe(23)
    release(RESULT)
    await first
    // The guard is released: the next tick runs again.
    pass.mockResolvedValueOnce(RESULT)
    await svc.tick()
    expect(pass).toHaveBeenCalledTimes(2)
  })

  it('tick() never rejects when the pass throws, and logs no message', async () => {
    const { svc, error } = setup(true)
    pass.mockRejectedValueOnce(new Error('TITLE-MARKER-wizard'))
    await expect(svc.tick()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toEqual({ event: 'ROLE_AI_ERROR', error: 'Error', db: '' })
    expect(JSON.stringify(error.mock.calls)).not.toContain('TITLE-MARKER')
    // The guard is released after a failure too.
    pass.mockResolvedValueOnce(RESULT)
    await svc.tick()
    expect(pass).toHaveBeenCalledTimes(2)
  })
})
