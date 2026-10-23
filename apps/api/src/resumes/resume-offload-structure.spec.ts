/**
 * AC3, deterministic half — the heavy work stays OFF the request thread. No stopwatch anywhere.
 *
 * `resume-render-responsiveness.timing.spec.ts` proves the guarantee the way a user experiences it
 * (HTTP round-trip time during a render) and compares it against the forbidden implementation. That
 * is a ratio of wall-clock measurements, so it runs in a dedicated CI job where nothing else shares
 * the runner (`TIMING_SPECS=1`, see `apps/api/vitest.config.mts`).
 *
 * This file keeps the same guarantee observable on every push, by asserting the two facts that the
 * timing result is a consequence of:
 *
 *   1. EVENT-LOOP TURNS. While the production Typst runner executes a child process, the event loop
 *      keeps turning. Counted in `setImmediate` turns, not milliseconds. A synchronous
 *      `execFileSync` runner cannot turn the loop at all, so the count is exactly 0 for it and
 *      at least 1 for a real async child: a boundary that does not move with machine load.
 *   2. NO IN-PROCESS PARSE. `ResumeTextExtractionService.extract` returns the document text without
 *      ever calling `mammoth.extractRawText` in the API process; the parse happens in the sandbox.
 *
 * Each assertion has a paired "teeth" case that performs the forbidden implementation and asserts
 * the same measurement goes red.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { RESUME_DOCX_MIME } from '@crm/shared'
import { buildDocxRawBody } from '../test/resume-fixtures'
import { createSpawnRunner, type TypstRunner } from './resume-typst.service'
import { ResumeTextExtractionService } from './resume-text-extraction.service'

/**
 * `mammoth` with `extractRawText` replaced by a call-recording pass-through. A module mock rather
 * than `vi.spyOn(namespace, ...)`: an ESM namespace cannot be redefined, and a mock covers every
 * route into the module (named import, default import) the production code might take.
 */
const mammothCalls = vi.hoisted(() => ({ extractRawText: 0 }))
vi.mock('mammoth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mammoth')>()
  const wrapped = (...args: Parameters<typeof actual.extractRawText>) => {
    mammothCalls.extractRawText += 1
    return actual.extractRawText(...args)
  }
  return { ...actual, extractRawText: wrapped, default: { ...actual, extractRawText: wrapped } }
})

/**
 * Number of event-loop turns (`setImmediate` callbacks) that ran while `work` was in flight.
 *
 * The counter is armed BEFORE `work` is invoked, so a `work` that blocks synchronously cannot turn
 * the loop and reads 0 (its promise resolves in a microtask, which drains before any immediate).
 */
async function loopTurnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0
  let running = true
  const tick = (): void => {
    if (!running) return
    turns += 1
    setImmediate(tick)
  }
  setImmediate(tick)
  try {
    await work()
  } finally {
    running = false
  }
  return turns
}

/** Any process that stays alive long enough for the loop to be observed; it does no CPU work. */
const SLEEP_BIN = 'sleep'
const SLEEP_ARGS = ['0.2']
const RUN_OPTIONS = { cwd: process.cwd(), env: { PATH: process.env['PATH'] ?? '' } }

describe('AC3 (deterministic) — the Typst runner does not block the event loop', () => {
  it('the production runner lets the loop turn while the child runs', async () => {
    const runner = createSpawnRunner(10_000)
    let result: Awaited<ReturnType<TypstRunner>> | undefined
    const turns = await loopTurnsDuring(async () => {
      result = await runner(SLEEP_BIN, SLEEP_ARGS, RUN_OPTIONS)
    })

    // Non-vacuity: the child really ran and exited cleanly, so "turns" were counted across a real run.
    expect(result?.code).toBe(0)
    expect(turns).toBeGreaterThan(0)
  })

  it('TEETH: a synchronous runner (execFileSync) cannot turn the loop — the count is exactly 0', async () => {
    const blockingRunner: TypstRunner = (bin, args, options) => {
      execFileSync(bin, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' })
      return Promise.resolve({ code: 0, stderr: '', timedOut: false })
    }
    const turns = await loopTurnsDuring(() => blockingRunner(SLEEP_BIN, SLEEP_ARGS, RUN_OPTIONS))

    expect(turns).toBe(0)
  })
})

describe('AC3 (deterministic) — DOCX parsing stays out of the API process', () => {
  const docx = (): Buffer => buildDocxRawBody('<w:p><w:r><w:t>offload marker</w:t></w:r></w:p>')

  it('extract() returns the text without calling mammoth in this process', async () => {
    mammothCalls.extractRawText = 0
    const text = await new ResumeTextExtractionService().extract(docx(), RESUME_DOCX_MIME)

    // Non-vacuity: the text really came back, so the parse really happened somewhere.
    expect(text).toContain('offload marker')
    expect(mammothCalls.extractRawText).toBe(0)
  })

  it('TEETH: the forbidden in-process parse is recorded by the very same counter', async () => {
    mammothCalls.extractRawText = 0
    const mammoth = await import('mammoth')
    await mammoth.extractRawText({ buffer: docx() })

    expect(mammothCalls.extractRawText).toBe(1)
  })
})
