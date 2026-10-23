/**
 * AC3, deterministic half — the heavy work stays OFF the request thread. No stopwatch anywhere.
 *
 * `resume-render-responsiveness.timing.spec.ts` proves the guarantee the way a user experiences it
 * (HTTP round-trip time during a render) and compares it against the forbidden implementation. That
 * is a ratio of wall-clock measurements, so it runs in a dedicated CI job (`TIMING_SPECS=1`, see
 * `apps/api/vitest.config.mts`).
 *
 * This file keeps the same guarantee observable on every push. Both cases drive the REAL services
 * with NO injected runner, so the production default is what is under test: swapping the service's
 * default runner, or moving the parse in-process by any route, goes red here.
 *
 *   1. TYPST. A real `ResumeTypstService().render()` must (a) start its child with async `spawn`,
 *      (b) never call a synchronous child-process API, and (c) let the event loop turn between the
 *      child's start and its exit. (c) is counted in `setImmediate` turns, not milliseconds: a
 *      synchronous runner has no turns between spawn and exit. (a) and (b) are what make (c)
 *      non-vacuous for a runner that skips `spawn` altogether.
 *   2. DOCX. A real `ResumeTextExtractionService().extract()` must go through `runSandboxed`, and
 *      must not touch `mammoth` at all in this process (ANY property access on the module, not one
 *      named export), nor call a synchronous child-process API.
 *
 * Known limit: a parse that reaches a parser by a route that bypasses both module mocks (for
 * example `createRequire` on a different library) is not seen by (2). The positive requirement,
 * that `runSandboxed` really ran, is what keeps that from being a silent pass for the common
 * regressions; the timing spec is the backstop for the rest.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, RESUME_DOCX_MIME } from '@crm/shared'
import { buildDocxRawBody } from '../test/resume-fixtures'
import { slowTemplate } from '../test/resume-render-fixtures'
import { assertTypstAvailable } from '../test/typst-availability'
import { ResumeTextExtractionService } from './resume-text-extraction.service'
import { ResumeTypstService, type TypstRunner } from './resume-typst.service'

/** Shared, hoisted state: the mocks below are factories that run before module evaluation. */
const probe = vi.hoisted(() => ({
  /** Event-loop turns counted by `loopTurnsDuring`. */
  turns: 0,
  spawns: [] as { turnsAtSpawn: number; turnsAtClose: number | null }[],
  syncChildProcessCalls: 0,
  mammothAccesses: 0,
  runSandboxedCalls: 0,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const countSync =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      probe.syncChildProcessCalls += 1
      return fn(...args)
    }
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args)
    const entry = { turnsAtSpawn: probe.turns, turnsAtClose: null as number | null }
    probe.spawns.push(entry)
    child.once('close', () => {
      entry.turnsAtClose = probe.turns
    })
    return child
  }) as typeof actual.spawn
  const patched = {
    ...actual,
    spawn,
    spawnSync: countSync(actual.spawnSync),
    execSync: countSync(actual.execSync),
    execFileSync: countSync(actual.execFileSync),
  }
  return { ...patched, default: patched }
})

/**
 * `mammoth` replaced by a Proxy that counts ANY property read on the module (named or default),
 * so a parse through `convertToHtml`, `extractRawText` or anything else is the same signal.
 */
vi.mock('mammoth', async (importOriginal) => {
  const actual = await importOriginal<Record<string | symbol, unknown>>()
  const counting = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        if (typeof key === 'string' && key !== 'then' && key !== '__esModule') {
          probe.mammothAccesses += 1
        }
        return Reflect.get(obj, key, receiver)
      },
    })
  return counting({ ...actual, default: counting({ ...(actual['default'] as object) }) })
})

vi.mock('./sandboxed-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandboxed-process')>()
  return {
    ...actual,
    runSandboxed: (...args: Parameters<typeof actual.runSandboxed>) => {
      probe.runSandboxedCalls += 1
      return actual.runSandboxed(...args)
    },
  }
})

/**
 * Number of event-loop turns (`setImmediate` callbacks) that ran while `work` was in flight.
 *
 * The counter is armed BEFORE `work` is invoked, so a `work` that blocks synchronously cannot turn
 * the loop and reads 0 (its promise resolves in a microtask, which drains before any immediate).
 */
async function loopTurnsDuring(work: () => Promise<unknown>): Promise<number> {
  probe.turns = 0
  let running = true
  const tick = (): void => {
    if (!running) return
    probe.turns += 1
    setImmediate(tick)
  }
  setImmediate(tick)
  try {
    await work()
  } finally {
    running = false
  }
  return probe.turns
}

function resetProbe(): void {
  probe.turns = 0
  probe.spawns.length = 0
  probe.syncChildProcessCalls = 0
  probe.mammothAccesses = 0
  probe.runSandboxedCalls = 0
}

describe('AC3 (deterministic) — the Typst render does not block the event loop', () => {
  it('the DEFAULT runner spawns asynchronously and the loop turns while the child runs', async () => {
    assertTypstAvailable()
    resetProbe()
    const service = new ResumeTypstService() // no injected runner: the production default
    let pdf: Buffer | undefined
    await loopTurnsDuring(async () => {
      pdf = await service.render({
        displayName: 'Іван Петренко',
        content: EMPTY_RESUME_CONTENT,
        layout: DEFAULT_RESUME_LAYOUT,
        templateSource: slowTemplate(200),
      })
    })

    // Non-vacuity: a real PDF came back.
    expect(pdf?.subarray(0, 4).toString('latin1')).toBe('%PDF')
    expect(probe.syncChildProcessCalls).toBe(0)
    expect(probe.spawns.length).toBeGreaterThanOrEqual(1)
    for (const entry of probe.spawns) {
      expect(entry.turnsAtClose, 'child exit observed').not.toBeNull()
      expect((entry.turnsAtClose ?? 0) - entry.turnsAtSpawn).toBeGreaterThan(0)
    }
  })

  it('TEETH: a synchronous runner spawns nothing asynchronously and trips the sync counter', async () => {
    resetProbe()
    const blockingRunner: TypstRunner = (bin, args, options) => {
      execFileSync(bin, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' })
      return Promise.resolve({ code: 0, stderr: '', timedOut: false })
    }
    const turns = await loopTurnsDuring(() =>
      blockingRunner('sleep', ['0.2'], { cwd: process.cwd(), env: {} }),
    )

    expect(turns).toBe(0)
    expect(probe.syncChildProcessCalls).toBe(1)
    expect(probe.spawns).toHaveLength(0)
  })
})

describe('AC3 (deterministic) — DOCX parsing stays out of the API process', () => {
  const docx = (): Buffer => buildDocxRawBody('<w:p><w:r><w:t>offload marker</w:t></w:r></w:p>')

  it('extract() goes through the sandbox and never touches mammoth in this process', async () => {
    resetProbe()
    const text = await new ResumeTextExtractionService().extract(docx(), RESUME_DOCX_MIME)

    // Non-vacuity: the text really came back, via the sandbox.
    expect(text).toContain('offload marker')
    expect(probe.runSandboxedCalls).toBeGreaterThanOrEqual(1)
    expect(probe.mammothAccesses).toBe(0)
    expect(probe.syncChildProcessCalls).toBe(0)
  })

  it('TEETH: any in-process use of the module, not just one export, moves the counter', async () => {
    resetProbe()
    const mammoth = await import('mammoth')
    await mammoth.convertToHtml({ buffer: docx() })

    expect(probe.mammothAccesses).toBeGreaterThan(0)
  })
})
