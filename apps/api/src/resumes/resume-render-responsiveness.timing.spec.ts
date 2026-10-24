/**
 * AC3 (timing half) — the API stays responsive WHILE a resume is being typeset.
 *
 * MOVED 2026-10-23 to `*.timing.spec.ts`: this file compares wall-clock round-trip times between
 * the real implementation and the forbidden one, and a ratio of two measurements taken at
 * different moments does not survive machine contention (CI: 197.17 vs a 211.51 threshold on a PR
 * that touched no `apps/` file; backlog 278). It is excluded from the default `vitest run` and
 * runs in the dedicated `Timing specs` CI job, alone on its runner:
 *
 *   TIMING_SPECS=1 pnpm --filter @crm/api exec vitest run
 *
 * Thresholds are unchanged. The deterministic half of the same guarantee (event-loop turns during
 * a child process, no in-process mammoth call) is `resume-offload-structure.spec.ts` and gates
 * every push.
 *
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
import { inspectDocxZip } from './resume-source.util'
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

/**
 * Floor for the EXTRACTION case's windows, DERIVED rather than picked.
 *
 * What the floor must guarantee: the in-process stall is long enough that the
 * sandboxed bound (`inProcess.worst / 5`) still sits above the worst sample the
 * sandboxed run produces on a healthy API. Healthy sandboxed worst: 12.7-13.7 ms
 * in five runs on the author's machine (2026-10-22, @xmldom/xmldom 0.8.15,
 * mammoth as installed), 14.8 ms in an earlier run, and 15-45 ms quoted by an
 * earlier version of this file under load (quoted, not re-measured).
 * Taking 45 ms as the noise ceiling, the stall must be at least 5 x 45 = 225 ms;
 * the floor is 250 ms.
 *
 * Margin against the measuring machine: its in-process window is 1 104-1 214 ms
 * (stall 1 075-1 170 ms), so a runner ~4.5x faster still clears it.
 *
 * Why this is not 300 or 700: a runner whose old floor of 300 failed by 4 ms
 * ("expected 296 to be greater than 300", Mutation Gate dry run on #1085, which
 * carried the pre-fix fixture) showed that an absolute number chosen to suit one
 * machine is red or vacuous on another. Mutation Gate re-runs the whole suite
 * many times and is the one instrument here that tells a flake from a pass; a
 * timing failure at this line in that gate means the runner is faster than the
 * 4.5x margin, not that containment broke.
 */
const EXTRACTION_MIN_WINDOW_MS = 250

/**
 * Floor for the in-process stall itself: 5 x the 45 ms noise ceiling above, so
 * the sandboxed bound (`inProcess.worst / 5`) is never below that ceiling.
 * Measured stall on the author's machine: 1 075-1 170 ms (about 4.8x margin).
 */
const EXTRACTION_MIN_STALL_MS = 225

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
 * Max of `samples`, or the "unbounded breach" sentinel for a run that never
 * sampled anything.
 *
 * Written as a `reduce`, deliberately not `Math.max(...samples)`. A spread
 * into a call turns every element into a call argument, and a JS engine's
 * argument-list capacity is a fixed, engine- and stack-depth-dependent
 * ceiling — NOT a property of this test's logic. The file header measures
 * this exact array at 26 721 entries in ordinary operation (one healthy
 * render, on the development machine); a CI runner fast enough to schedule
 * more probes than that in the same window pushed it over the ceiling and
 * `Math.max(...samples)` threw `RangeError: Maximum call stack size
 * exceeded` — not a slow machine's problem, a fast one's. `reduce` walks the
 * array without ever materializing it as an argument list, so there is no
 * count at which this stops working.
 */
function worstOf(samples: readonly number[]): number {
  return samples.length > 0
    ? samples.reduce((max, sample) => (sample > max ? sample : max))
    : Number.MAX_SAFE_INTEGER
}

/**
 * Hammer `/probe` over real sockets for as long as `work` runs.
 *
 * `work` is started FIRST and the samplers run until it settles, so every
 * sample is taken while the render is genuinely in flight.
 *
 * LIMIT, silently vacuous if ignored: the probes start only after `work()`
 * returns its promise. A `work` whose FIRST SYNCHRONOUS segment is the stall
 * blocks the loop before any probe exists, so no request is outstanding and
 * the reported worst is tiny. The in-process extraction case is measurable
 * only because it begins with `await import('mammoth')`, which yields before
 * the synchronous parse; a function that parses on its first line would need
 * an explicit `await Promise.resolve()` ahead of the stall.
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
    worst: worstOf(samples),
    renderMs: Date.now() - startedAt,
  }
}

describe('worstOf — regression for the CI spread-overflow (PR #600 flake)', () => {
  it('does not overflow the call stack on a sample count past the spread-argument ceiling', () => {
    // The failure this guards against was a `RangeError` from
    // `Math.max(...samples)`, thrown only on a runner fast enough to collect
    // this many probes — see the doc comment on `worstOf`. 200 000 is
    // comfortably past both the measured real-world count (26 721) and every
    // engine's spread-argument ceiling, without depending on exactly where
    // that ceiling sits.
    const huge = Array.from({ length: 200_000 }, (_, i) => i)
    expect(() => worstOf(huge)).not.toThrow()
    expect(worstOf(huge)).toBe(199_999)
  })

  it('keeps the empty-run sentinel', () => {
    expect(worstOf([])).toBe(Number.MAX_SAFE_INTEGER)
  })
})

// Opt-in perf characterisations below still need RESUME_PERF=1; the rest always run when this
// file is selected (TIMING_SPECS=1), locally or in CI.
describe('AC3 — API responsiveness during a resume render', () => {
  /**
   * THE AC3 GATE, expressed as a COMPARISON so it cannot flake with the
   * machine.
   *
   * Both implementations run in the same test, on the same hardware, moments
   * apart: the real child-process renderer and the forbidden main-thread one.
   * The assertion is the RATIO between them, which is a property of the code;
   * an absolute millisecond ceiling is a property of the runner, and this file
   * spent three rounds proving it — 21.8 ms on an idle machine, 274 ms on a
   * loaded one, against a 250 ms budget, for identical code.
   *
   * The separation being asserted is enormous (measured 21.8 ms vs 1 357.8 ms,
   * 62x), so a factor of 5 is far below the signal and far above any plausible
   * scheduling noise. The mutation and the guarantee are now one test, which
   * also means the mutation cannot rot separately from the thing it protects.
   */
  it('keeps the API answering during a render — and would not if the render moved to the main thread', async () => {
    const asyncService = new ResumeTypstService()
    const asyncRun = await measureWhile(() => asyncService.render(renderInput(slowTemplate(4_000))))

    const blockingRunner: TypstRunner = (bin, args, options) => {
      try {
        // The forbidden implementation, in one line.
        execFileSync(bin, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' })
        return Promise.resolve({ code: 0, stderr: '', timedOut: false })
      } catch {
        return Promise.resolve({ code: 1, stderr: 'blocking runner failed', timedOut: false })
      }
    }
    const blockingRun = await measureWhile(() =>
      new ResumeTypstService(blockingRunner).render(renderInput(slowTemplate(4_000))),
    )

    // Non-vacuity: both renders really ran, and the child-process one really
    // was sampled throughout.
    expect(asyncRun.renderMs).toBeGreaterThan(MIN_RENDER_MS)
    expect(blockingRun.renderMs).toBeGreaterThan(MIN_RENDER_MS)
    expect(asyncRun.samples.length).toBeGreaterThan(MIN_SAMPLES)

    // The guarantee: blocking the loop is dramatically worse than not blocking
    // it, on whatever hardware this happens to be.
    expect(blockingRun.worst).toBeGreaterThan(asyncRun.worst * 5)
    // No sample-COUNT assertion here, on purpose. The count comes from the same
    // samples as the latency ratio above, so it adds no independent evidence,
    // and as a ratio it is not scale-free: it failed a 10x bound twice in 15
    // runs under load. Recorded as documentation (2026-10-22, 8 cores; blocked
    // vs async sample counts): idle 39 vs 26 721 (685x); under 8 busy loops
    // 357 vs 2 857 and 357 vs 3 398 (8.0x and 9.5x). Contention lowered the
    // async count by roughly an order of magnitude while the blocked count
    // rose from 39 to 357, so the ratio collapses for reasons unrelated to
    // whether the loop is blocked.
  }, 180_000)

  it.skipIf(process.env['RESUME_PERF'] !== '1')(
    'characterises absolute latency during a render on a quiet machine',
    async () => {
      const service = new ResumeTypstService()
      const measurement = await measureWhile(() => service.render(renderInput(slowTemplate(4_000))))

      // Non-vacuity, both halves: the render really was slow, and the probes
      // really did run during it. Without these two, a render that failed
      // instantly would produce an empty sample set and a triumphant green tick.
      expect(measurement.renderMs).toBeGreaterThan(MIN_RENDER_MS)
      expect(measurement.samples.length).toBeGreaterThan(MIN_SAMPLES)

      expect(measurement.worst).toBeLessThan(LATENCY_BUDGET_MS)
    },
    120_000,
  )

  /**
   * Opt-in for the same reason as the extraction characterisation below: with
   * both render slots busy AND the extraction workers of neighbouring tests on
   * the same machine, this measured 253 ms against a 250 ms budget — a margin
   * of 1.2%, which is a coin toss, not a gate. The AC3 guarantee itself stays
   * always-on above (21.8 ms) and below (the mutation, 1 357.8 ms): four orders
   * of magnitude, exactly where this file's policy says a clock is allowed.
   */
  it.skipIf(process.env['RESUME_PERF'] !== '1')(
    'stays responsive with the concurrency limit saturated',
    async () => {
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
    },
    180_000,
  )

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
  /**
   * KNOWN GAP, measured — the screening is still on the request thread.
   *
   * Opt-in (`RESUME_PERF=1`) rather than deleted, and NOT because the number is
   * inconvenient: it is real. Measured here, four concurrent extractions of a
   * 40 000-paragraph document, worst HTTP round trip **646 ms**.
   *
   * Isolating the PARSE removed the unbounded half, and this is what is left:
   * `inspectDocxZip`'s accounting, and `normalizeExtractedText` +
   * `breakOverlongRuns` over the text the worker returns, all in the parent.
   * Each is bounded — the text is capped at 200 000 characters — so it is a
   * constant, not a class. But it is a constant on the thread that serves HTTP,
   * which contradicts this module's own rule, and no amount of choosing between
   * a regex and a byte scan changes that.
   *
   * The fix is the one that already worked once: move the screening into the
   * sandbox with the parser. That is a contained change with one real obstacle
   * — the worker is a plain `.cjs` asset so it resolves identically from `src`
   * under Vitest and from `dist` in the image, while the guards are TypeScript,
   * so sharing them needs one dual-consumable module rather than a second copy.
   * Flagged for the next round rather than half-done here.
   */
  /**
   * THE EXTRACTION GATE, restored — and this time as a ratio.
   *
   * The commit that closed the unbounded-work class also switched this
   * assertion to opt-in, which removed the only always-on check that would
   * notice the class coming back. That is the worst possible thing to do in the
   * same change: the guarantee shipped and its guard left with it.
   *
   * Both implementations run here, on the same hardware, moments apart — the
   * real child-process extractor, and the forbidden in-process parse the worker
   * replaced. Comparing them is machine-independent, which is what lets this be
   * always-on where an absolute ceiling could not be (load average reached 183
   * on this machine today).
   */
  it('keeps the API answering during extraction — and would not if the parse moved back in-process', async () => {
    const { ResumeTextExtractionService } = await import('./resume-text-extraction.service')
    const { buildDocxRawBody } = await import('../test/resume-fixtures')
    const { RESUME_DOCX_MIME } = await import('@crm/shared')

    // A document that passes every acceptance budget and is still expensive to
    // parse: 690 000 empty paragraphs, 4.1 MB, one tag per 6 bytes. Isolation is
    // the ONLY thing standing between it and the event loop, so this is the
    // shape the sandbox exists for.
    //
    // It replaces a 60 000-attribute element, and the swap is not cosmetic. That
    // fixture was chosen when `@xmldom/xmldom` rescanned an element's attributes
    // as each one was added (quadratic: 1.33 MB / 120 000 attributes = 18 310 ms
    // by the service header's account). With the installed 0.8.15 the same shape
    // is linear: 60 000 attributes parse in ~60-100 ms, and the largest count the
    // budgets still admit (200 000) in ~240 ms on the machine that measured it.
    // So the in-process stall was ~100-220 ms against a sandboxed worst of 15-45 ms,
    // a ratio that straddled the factor of 5 asserted below, and CI failed it
    // as 218.199 > 218.214 (run 39665997715). The node-count shape is linear too,
    // but its budget-admitted maximum is 1.2 s of parse, not 0.1 s.
    const attack = buildDocxRawBody('<w:p/>'.repeat(690_000))

    // The sandboxed run below swallows errors, so a budget refusing this
    // document would surface only as a short window failing a floor, with no
    // pointer to the cause. Admission is the precondition; assert it by name.
    // (`inspectDocxZip` is the gate `extract` runs before starting a worker;
    // it throws when a size budget refuses the document.)
    await inspectDocxZip(attack)

    const service = new ResumeTextExtractionService()
    const sandboxed = await measureWhile(() =>
      service.extract(attack, RESUME_DOCX_MIME).catch(() => undefined),
    )

    // The forbidden implementation: mammoth on this thread, as it was before
    // the worker existed.
    const inProcess = await measureWhile(async () => {
      const mammoth = await import('mammoth')
      await mammoth.extractRawText({ buffer: attack }).catch(() => undefined)
    })

    // Non-vacuity: both really parsed, and the sandboxed run really was sampled
    // throughout a window long enough for a stall to have shown.
    expect(sandboxed.renderMs).toBeGreaterThan(EXTRACTION_MIN_WINDOW_MS)
    expect(inProcess.renderMs).toBeGreaterThan(EXTRACTION_MIN_WINDOW_MS)
    expect(sandboxed.samples.length).toBeGreaterThan(MIN_SAMPLES)

    // The guarantee, stated as what a stall IS rather than as two durations
    // ordered against each other: with the parse on the main thread, ONE request
    // is outstanding for most of the parse (measured 1 230 ms of a 1 261 ms
    // window; the fraction is 0.97). The bound is a fraction of the run's own
    // length, so it does not depend on how fast the machine is.
    expect(inProcess.worst).toBeGreaterThan(inProcess.renderMs * 0.5)
    // The stall asserted DIRECTLY: the window floor above only guarantees half
    // a window (125 ms at 250 ms), which would imply a sandboxed bound of 25 ms,
    // below the noise ceiling. With the stall itself above 225 ms the bound is
    // above 45 ms.
    expect(inProcess.worst).toBeGreaterThan(EXTRACTION_MIN_STALL_MS)
    // Off-thread, no request is held up for more than a fifth of what the same
    // parse costs on the main thread (measured 14.8 ms against 1 230 ms, 83x).
    // The bound is deliberately NOT a fraction of the sandboxed window: that
    // window includes worker spawn and a niced parse, so a slow worker would
    // loosen it (25% of 1 725 ms is already ~430 ms). Tied to the in-process
    // stall it moves with the machine in the right direction and stays near
    // 215 ms here (1 075-1 170 ms / 5). The 646 ms known gap documented below was
    // measured on a different document (40 000 paragraphs, four concurrent
    // extractions), so this bound is NOT evidence that the gap is detectable here.
    expect(sandboxed.worst).toBeLessThan(inProcess.worst / 5)
    expect(sandboxed.samples.length).toBeGreaterThan(inProcess.samples.length * 5)
  }, 180_000)

  it.skipIf(process.env['RESUME_PERF'] !== '1')(
    'characterises the residual main-thread cost of extraction screening',
    async () => {
      const { ResumeTextExtractionService } = await import('./resume-text-extraction.service')
      const { buildDocxWithMediaPrefixedBody } = await import('../test/resume-fixtures')
      const { RESUME_DOCX_MIME } = await import('@crm/shared')

      const service = new ResumeTextExtractionService()
      const attack = buildDocxWithMediaPrefixedBody(
        Array.from({ length: 40_000 }, (_, i) => `п${i}`),
      )
      const measurement = await measureWhile(() =>
        Promise.all(
          Array.from({ length: 4 }, () =>
            service.extract(attack, RESUME_DOCX_MIME).catch(() => undefined),
          ),
        ),
      )

      // Recorded, not gated: 646 ms measured. Tighten this only when the
      // screening moves into the sandbox.
      expect(measurement.samples.length).toBeGreaterThan(MIN_SAMPLES)
    },
    180_000,
  )

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
