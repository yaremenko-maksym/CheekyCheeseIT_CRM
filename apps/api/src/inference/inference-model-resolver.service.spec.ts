import type { ConfigService } from '@nestjs/config'
import type { OpenRouterModel } from '@crm/inference'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import { InferenceModelResolverService } from './inference-model-resolver.service'

const m = (id: string, price: number, ctx = 32000): OpenRouterModel => ({
  id,
  promptPriceUsdPerMTok: price,
  contextTokens: ctx,
})

function cfg(values: Record<string, string | undefined>): ConfigService<Env, true> {
  return { get: (k: string) => values[k] } as unknown as ConfigService<Env, true>
}
const ACTIVE = { OPENROUTER_API_KEY: 'k', INFERENCE_EXTRACTION_PROVIDER: 'openrouter' }

function make(
  fetchCatalog: ReturnType<typeof vi.fn>,
  values: Record<string, string | undefined> = ACTIVE,
) {
  const clock = { t: 1_000_000 }
  const svc = new InferenceModelResolverService(cfg(values), {
    fetchCatalog: fetchCatalog as never,
    now: () => clock.t,
    cooldownMs: 1000,
  })
  return { svc, clock }
}

describe('InferenceModelResolverService', () => {
  it('boot warm selects the cheapest qualifying model', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, models: [m('a/big', 0.9), m('b/cheap', 0.2)] })
    const { svc } = make(f)
    await svc.onModuleInit()
    expect(svc.getSelectedModelId()).toBe('b/cheap')
  })

  it('ignores models failing the guardrails when none qualifies', async () => {
    const f = vi
      .fn()
      .mockResolvedValue({ ok: true, models: [m('x/pricey', 5), m('y/tiny', 0.1, 4000)] })
    const { svc } = make(f)
    await svc.onModuleInit()
    expect(svc.getSelectedModelId()).toBeNull()
  })

  it('switches when the current model disappears and a cheaper qualifier exists', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, models: [m('a/one', 0.5)] })
      .mockResolvedValueOnce({ ok: true, models: [m('c/two', 0.3)] })
    const { svc, clock } = make(f)
    await svc.onModuleInit()
    clock.t += 5000
    const next = await svc.onModelUnavailable('a/one')
    expect(next).toBe('c/two')
    expect(svc.getSelectedModelId()).toBe('c/two')
  })

  it('keeps the last good id when the catalog fetch fails', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, models: [m('a/one', 0.5)] })
      .mockResolvedValueOnce({ ok: false, code: 'PROVIDER_ERROR' })
    const { svc, clock } = make(f)
    await svc.onModuleInit()
    clock.t += 5000
    expect(await svc.onModelUnavailable('a/one')).toBe('a/one')
    expect(svc.getSelectedModelId()).toBe('a/one')
  })

  it('never throws when the fetcher rejects', async () => {
    const f = vi.fn().mockRejectedValue(new Error('boom'))
    const { svc } = make(f)
    await expect(svc.onModuleInit()).resolves.toBeUndefined()
    expect(svc.getSelectedModelId()).toBeNull()
  })

  it('single-flight: concurrent onModelUnavailable calls do ONE catalog fetch', async () => {
    let release!: (v: unknown) => void
    const gate = new Promise((r) => {
      release = r
    })
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, models: [m('a/one', 0.5)] })
      .mockImplementationOnce(async () => {
        await gate
        return { ok: true, models: [m('c/two', 0.3)] }
      })
    const { svc, clock } = make(f)
    await svc.onModuleInit()
    clock.t += 5000
    const p1 = svc.onModelUnavailable('a/one')
    const p2 = svc.onModelUnavailable('a/one')
    release(undefined)
    expect(await Promise.all([p1, p2])).toEqual(['c/two', 'c/two'])
    expect(f).toHaveBeenCalledTimes(2) // 1 boot warm + 1 shared refresh
  })

  it('respects the cooldown after a refresh', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, models: [m('a/one', 0.5)] })
    const { svc } = make(f)
    await svc.onModuleInit()
    await svc.onModelUnavailable('a/one') // within cooldown of boot warm
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when the dead id is not the current one', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, models: [m('a/one', 0.5)] })
    const { svc, clock } = make(f)
    await svc.onModuleInit()
    clock.t += 5000
    expect(await svc.onModelUnavailable('zzz/other')).toBe('a/one')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('is a no-op returning null when not configured for openrouter', async () => {
    const f = vi.fn()
    const inactive = [
      {},
      { OPENROUTER_API_KEY: 'k' },
      { INFERENCE_EXTRACTION_PROVIDER: 'openrouter' },
      { ...ACTIVE, INFERENCE_EXTRACTION_PROVIDER: 'local' },
    ]
    for (const values of inactive) {
      const { svc } = make(f, values)
      await svc.onModuleInit()
      expect(svc.getSelectedModelId()).toBeNull()
      expect(await svc.onModelUnavailable('a/one')).toBeNull()
    }
    expect(f).not.toHaveBeenCalled()
  })
})
