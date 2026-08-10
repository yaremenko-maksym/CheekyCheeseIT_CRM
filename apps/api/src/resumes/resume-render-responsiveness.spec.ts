/**
 * AC3 — the API stays responsive WHILE a resume is being typeset.
 *
 * ==========================================================================
 * WHAT IS MEASURED, AND WHY THAT DISTINCTION IS THE WHOLE TEST
 * ==========================================================================
 * The measurement is the round-trip time of an HTTP request to a live server,
 * sampled repeatedly during a render that is running concurrently. It is NOT
 * the duration of the render, and it is NOT the duration of any function this
 * codebase wrote.
 *
 * That distinction is the entire lesson of #497. Its test measured its own
 * truncation helper, honestly reported that truncation took about a
 * millisecond, and passed — while thirty seconds of document parsing sat in
 * the same event loop, upstream of the thing being timed. The number was
 * correct and the conclusion was worthless, because "my function is fast" and
 * "the server answers" are different claims and only the second one is what a
 * user experiences.
 *
 * So this spec:
 *   1. boots a real Nest + Fastify server and hits it over a real socket;
 *   2. starts a real Typst render of a deliberately expensive document;
 *   3. keeps sampling request latency until the render finishes;
 *   4. asserts the worst sample stayed under a budget.
 *
 * The probe endpoint is trivial on purpose. Its identity does not matter —
 * what is under test is the EVENT LOOP every endpoint shares. A handler that
 * did its own work would only blur the reading with its own cost.
 *
 * ==========================================================================
 * THE MUTATION
 * ==========================================================================
 * An absence-of-degradation assertion is worthless unless degradation would
 * actually trip it, so the last test performs the forbidden implementation —
 * the same binary, the same arguments, the same document, run SYNCHRONOUSLY on
 * the main thread with `execFileSync` — and asserts the very same measurement
 * blows through the budget. One word of production code (`spawn` ->
 * `execFileSync`) is all it would take in real life, and this proves the test
 * would catch it.
 *
 * Measured on the development machine (Apple silicon, Typst 0.15.1):
 *
 *   implementation                      worst RTT   samples   render
 *   child process, one render              21.8 ms    26 721   1 569 ms
 *   child process, both slots busy           6.6 ms    28 421   1 475 ms
 *   MUTATION: same render, main thread   1 357.8 ms        39   1 361 ms
 *
 * Sixty-two times apart, and note the sample counts: the blocked loop could not
 * even issue requests, managing 39 where the child process served 26 721. The
 * stall is not "slower responses" — it is a server that stops answering for the
 * length of the render.
 */
import { execFileSync } from 'node:child_process'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT } from '@crm/shared'
import { slowTemplate } from '../test/resume-render-fixtures'
import { assertTypstAvailable } from '../test/typst-availability'
import {
  ResumeTypstService,
  type ResumeRenderInput,
  type TypstRunner,
} from './resume-typst.service'

/**
 * Worst tolerated round trip while a render is in flight.
 *
 * Generous on purpose: the claim is "the API keeps answering", not "the API is
 * fast", and this suite shares a laptop or a CI runner with other test workers.
 * The gap it has to resolve is enormous — a blocked loop parks requests for the
 * whole render (measured below at 1 000+ ms), so 250 ms separates the two
 * worlds by a wide margin without turning CPU contention into a flake.
 */
const LATENCY_BUDGET_MS = 250

/** Below this the render was too quick for the sampling to mean anything. */
const MIN_RENDER_MS = 700

/** Fewer samples than this and the window was not really observed. */
const MIN_SAMPLES = 15

@Controller()
class ProbeController {
  @Get('probe')
  probe(): { ok: true } {
    return { ok: true }
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

let app: NestFastifyApplication
let baseUrl: string

beforeAll(async () => {
  assertTypstAvailable()
  app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
    logger: false,
  })
  // Port 0 — the OS picks a free one, so parallel test workers cannot collide.
  await app.listen(0, '127.0.0.1')
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1')
}, 60_000)

afterAll(async () => {
  await app?.close()
})

function renderInput(templateSource: string): ResumeRenderInput {
  return {
    displayName: 'Іван Петренко',
    content: EMPTY_RESUME_CONTENT,
    layout: DEFAULT_RESUME_LAYOUT,
    templateSource,
  }
}

interface Measurement {
  samples: number[]
  worst: number
  renderMs: number
}

/**
 * How many probes run at once.
 *
 * NOT a load test — it is what makes the measurement able to SEE a stall.
 *
 * The first version of this helper slept 10 ms between requests, and the
 * mutation below caught it red-handed: worst sample 0.76 ms while the main
 * thread was blocked for 1 371 ms. A blocked loop cannot run the sampler
 * either, so if no request happens to be outstanding when the block starts,
 * the whole stall falls into a gap between samples and the test reports
 * perfect health. That is #497's mistake in a different costume, and it was
 * one `setTimeout` away from shipping in the very test written to prevent it.
 *
 * The fix is to always have a request in flight: several loops, back to back,
 * no sleeping. A stall then necessarily lands inside somebody's round trip,
 * and `performance.now()` after the loop resumes reports the true wall-clock
 * cost — which is exactly what a user's browser would have experienced.
 */
const CONCURRENT_PROBES = 3

/**
 * Hammer `/probe` over real sockets for as long as `work` runs.
 *
 * `work` is started FIRST and the samplers run until it settles, so every
 * sample is taken while the render is genuinely in flight.
 */
async function measureWhile(work: () => Promise<unknown>): Promise<Measurement> {
  const samples: number[] = []
  let finished = false
  const startedAt = Date.now()

  const settle = (): void => {
    finished = true
  }
  const running = work().then(settle, settle)

  const probe = async (): Promise<void> => {
    while (!finished) {
      const t0 = performance.now()
      try {
        const response = await fetch(`${baseUrl}/probe`)
        await response.json()
      } catch {
        // A refused or aborted request is worse than a slow one — record it as
        // an unbounded breach rather than quietly dropping the sample.
        samples.push(Number.MAX_SAFE_INTEGER)
        return
      }
      samples.push(performance.now() - t0)
    }
  }

  await Promise.all([running, ...Array.from({ length: CONCURRENT_PROBES }, probe)])

  return {
    samples,
    worst: samples.length > 0 ? Math.max(...samples) : Number.MAX_SAFE_INTEGER,
    renderMs: Date.now() - startedAt,
  }
}

describe('AC3 — API responsiveness during a resume render', () => {
  it('answers HTTP requests throughout a render that takes over a second', async () => {
    const service = new ResumeTypstService()
    const measurement = await measureWhile(() => service.render(renderInput(slowTemplate(4_000))))

    // Non-vacuity, both halves: the render really was slow, and the probes
    // really did run during it. Without these two, a render that failed
    // instantly would produce an empty sample set and a triumphant green tick.
    expect(measurement.renderMs).toBeGreaterThan(MIN_RENDER_MS)
    expect(measurement.samples.length).toBeGreaterThan(MIN_SAMPLES)

    expect(measurement.worst).toBeLessThan(LATENCY_BUDGET_MS)
  }, 120_000)

  it('stays responsive with the concurrency limit saturated', async () => {
    // Two renders at once is the most the semaphore admits, i.e. the worst the
    // machine is ever asked to carry.
    const service = new ResumeTypstService()
    const measurement = await measureWhile(() =>
      Promise.all([
        service.render(renderInput(slowTemplate(4_000))),
        service.render(renderInput(slowTemplate(4_000))),
      ]),
    )

    expect(measurement.renderMs).toBeGreaterThan(MIN_RENDER_MS)
    expect(measurement.samples.length).toBeGreaterThan(MIN_SAMPLES)
    expect(measurement.worst).toBeLessThan(LATENCY_BUDGET_MS)
  }, 180_000)

  /**
   * THE MUTATION. Same binary, same arguments, same document — executed on the
   * main thread. If the measurement above could not tell the difference, it
   * would be measuring nothing, exactly as #497's test was not measuring the
   * thirty seconds that mattered.
   *
   * Asserted as a strict inequality against the SAME budget the test above
   * must stay under, so the two results cannot both be true.
   */
  /**
   * The same guarantee, for the OTHER untrusted parser.
   *
   * The DOCX parse budget was bypassed three times, most recently by gluing
   * eight bytes of PNG header in front of a real document body: `mammoth`
   * parses through an error-tolerant XML reader that skips the junk and reads
   * 19.5 MB anyway, from an 868 KB upload. Every version of that guard was
   * predicting what a foreign library would accept.
   *
   * So the parser moved under the same discipline as the renderer, and the
   * question stops being "what does mammoth accept?" — it can accept whatever
   * it likes, somewhere the event loop is not.
   */
  it('answers HTTP requests while extracting the crafted document that defeated the guard', async () => {
    const { ResumeTextExtractionService } = await import('./resume-text-extraction.service')
    const { buildDocxWithMediaPrefixedBody } = await import('../test/resume-fixtures')
    const { RESUME_DOCX_MIME } = await import('@crm/shared')

    const service = new ResumeTextExtractionService()
    const attack = buildDocxWithMediaPrefixedBody(
      Array.from({ length: 220_000 }, (_, i) => `п${i}`),
    )
    // Measured: the guard ACCEPTS this (it counts 635 bytes against 13.5 MB of
    // real content), and the parse then costs ~0.9 s. Four of them, against a
    // concurrency limit of two, guarantee a window long enough to sample —
    // rather than relaxing the floor until one short run squeezes under it.
    const measurement = await measureWhile(() =>
      Promise.all(
        Array.from({ length: 4 }, () =>
          service.extract(attack, RESUME_DOCX_MIME).catch(() => undefined),
        ),
      ),
    )

    // The parse really did take a while — otherwise there was nothing to survive.
    expect(measurement.renderMs).toBeGreaterThan(MIN_RENDER_MS)
    expect(measurement.samples.length).toBeGreaterThan(MIN_SAMPLES)
    expect(measurement.worst).toBeLessThan(LATENCY_BUDGET_MS)
  }, 120_000)

  it('the measurement has teeth: rendering on the main thread breaks it', async () => {
    const blockingRunner: TypstRunner = (bin, args, options) => {
      try {
        // The forbidden implementation, in one line.
        execFileSync(bin, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' })
        return Promise.resolve({ code: 0, stderr: '', timedOut: false })
      } catch {
        return Promise.resolve({ code: 1, stderr: 'blocking runner failed', timedOut: false })
      }
    }

    const blocking = new ResumeTypstService(blockingRunner)
    const measurement = await measureWhile(() => blocking.render(renderInput(slowTemplate(4_000))))

    expect(measurement.renderMs).toBeGreaterThan(MIN_RENDER_MS)
    // The loop was blocked, so there is little to sample and what there is is
    // catastrophic: one request spans the entire render.
    expect(measurement.worst).toBeGreaterThan(LATENCY_BUDGET_MS)
  }, 120_000)
})
