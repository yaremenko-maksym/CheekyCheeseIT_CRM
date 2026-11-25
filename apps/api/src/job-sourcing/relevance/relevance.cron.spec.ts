import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRelevancePass } from './relevance-pass'
import { JobRelevanceCronService } from './relevance.cron'

vi.mock('./relevance-pass', async (orig) => ({
  ...(await orig<typeof import('./relevance-pass')>()),
  runRelevancePass: vi.fn(),
}))

const pass = vi.mocked(runRelevancePass)
const RESULT = { graded: 1, failed: 0, stoppedBy: null }

function setup(enabled?: boolean | string) {
  const database = {
    get db(): unknown {
      throw new Error('the cron itself never reads the database')
    },
  }
  const jev = { grade: vi.fn() }
  const config = { get: vi.fn(() => enabled) }
  const svc = new JobRelevanceCronService(database as never, jev as never, config as never)
  const error = vi
    .spyOn((svc as unknown as { logger: { error: () => void } }).logger, 'error')
    .mockImplementation(() => undefined)
  const warn = vi
    .spyOn((svc as unknown as { logger: { warn: () => void } }).logger, 'warn')
    .mockImplementation(() => undefined)
  return { svc, jev, config, error, warn }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('JobRelevanceCronService', () => {
  it.each([undefined, false, 'true'])(
    'tick() makes no DB read and no grader call when JOB_RELEVANCE_AI_ENABLED is %s, not true',
    async (enabled) => {
      const { svc, jev, config } = setup(enabled)
      await svc.tick()
      expect(config.get).toHaveBeenCalledWith('JOB_RELEVANCE_AI_ENABLED', { infer: true })
      expect(pass).not.toHaveBeenCalled()
      expect(jev.grade).not.toHaveBeenCalled()
    },
  )

  it('tick() is a no-op without a config service', async () => {
    const svc = new JobRelevanceCronService({} as never, { grade: vi.fn() } as never)
    await svc.tick()
    expect(pass).not.toHaveBeenCalled()
  })

  it('tick() runs one pass when the flag is true; an overlapping tick is skipped', async () => {
    const { svc, jev, warn } = setup(true)
    let release: (v: typeof RESULT) => void = () => undefined
    pass.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    const first = svc.tick()
    await svc.tick()
    expect(pass).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith({ event: 'RELEVANCE_TICK_SKIPPED', reason: 'RUNNING' })
    const deps = pass.mock.calls[0]?.[0]
    expect(deps?.jev).toBe(jev)
    expect(deps?.now()).toBeInstanceOf(Date)
    expect(deps?.limit).toBeUndefined()
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
    expect(error.mock.calls[0]?.[0]).toEqual({ event: 'RELEVANCE_ERROR', error: 'Error', db: '' })
    expect(JSON.stringify(error.mock.calls)).not.toContain('TITLE-MARKER')
    // The guard is released after a failure too.
    pass.mockResolvedValueOnce(RESULT)
    await svc.tick()
    expect(pass).toHaveBeenCalledTimes(2)
  })
})
