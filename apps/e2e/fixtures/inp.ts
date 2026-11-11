/**
 * Interaction speed probe for E2E (redesign v2 spec §5 thresholds:
 * INP < 100 ms / long task 50 ms = 10; INP < 200 ms / long task 200 ms = 9.5).
 *
 *   const r = await measureInp(page, async () => {
 *     await page.getByTestId('filter-open').click()
 *     await expect(page.getByRole('dialog')).toBeVisible()
 *   })
 *   expect(r.interactions).toBeGreaterThan(0) // the action really interacted
 *   expect(r.inp ?? 0).toBeLessThan(100)       // null = faster than 16 ms
 *
 * Everything is scoped to `action`: nothing that happened on the page before
 * it is counted.
 * - `interactions`: interactions the browser registered during `action`
 *   (`performance.interactionCount` delta).
 * - `inp`: the slowest of those interactions in ms (Event Timing duration,
 *   input to next paint; with fewer than 50 interactions that is what INP
 *   reports). `null` means NOT MEASURED: either `interactions === 0` (hover,
 *   assertions only — nothing to measure), or every interaction finished under
 *   Event Timing's 16 ms reporting floor. Tell the two apart by `interactions`.
 * - `longestTask`: the longest main-thread task during `action` (0 = none
 *   over 50 ms).
 *
 * CHROMIUM ONLY — it throws in any other browser. It needs CDP for CPU
 * throttling (`Emulation.setCPUThrottlingRate`, default 4x, a mid-range phone),
 * the `longtask` entry type and `performance.interactionCount`, none of which
 * WebKit exposes to Playwright. Specs that run in `webkit-iphone` skip their
 * INP case with `test.skip(browserName !== 'chromium', ...)`.
 */
import { errors, type Page } from '@playwright/test'

export interface InpResult {
  inp: number | null
  longestTask: number
  interactions: number
}

interface Probe {
  longest: number
  eventMax: number
  count0: number
}

declare global {
  interface Window {
    __crmInpProbe?: Probe
  }
  // Not in TypeScript's DOM lib yet (Chromium-only Event Timing fields).
  interface Performance {
    interactionCount?: number
  }
  interface PerformanceEventTiming {
    interactionId?: number
  }
}

export async function measureInp(
  page: Page,
  action: () => Promise<void>,
  opts?: { cpuThrottle?: number },
): Promise<InpResult> {
  const browser = page.context().browser()?.browserType().name()
  if (browser !== 'chromium') {
    throw new Error(`measureInp needs Chromium (CDP + Event Timing); got ${browser ?? 'unknown'}`)
  }

  await page.evaluate(() => {
    if (typeof performance.interactionCount !== 'number') {
      throw new Error('measureInp: performance.interactionCount is unavailable')
    }
    const probe: Probe = { longest: 0, eventMax: 0, count0: performance.interactionCount }
    window.__crmInpProbe = probe
    const t0 = performance.now()
    // Neither observer is `buffered`, and both filter on t0: entries from before `action` never count.
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.startTime >= t0) probe.longest = Math.max(probe.longest, e.duration)
    }).observe({ type: 'longtask' })
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[])
        if (e.interactionId && e.startTime >= t0)
          probe.eventMax = Math.max(probe.eventMax, e.duration)
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit)
  })

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts?.cpuThrottle ?? 4 })
  let interactions: number
  try {
    await action()
    interactions = await page.evaluate(
      () => performance.interactionCount! - window.__crmInpProbe!.count0,
    )
    if (interactions > 0) {
      // Event Timing entries are delivered after the next paint: let two frames and an idle pass.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestIdleCallback(() => resolve(), { timeout: 1000 })),
            ),
          ),
      )
      // None within 1 s more means every interaction stayed under the 16 ms reporting floor:
      // `inp` stays null (unmeasured). Any other failure propagates.
      await page
        .waitForFunction(() => window.__crmInpProbe!.eventMax > 0, undefined, { timeout: 1_000 })
        .catch((e: unknown) => {
          if (!(e instanceof errors.TimeoutError)) throw e
        })
    }
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await cdp.detach()
  }

  const { eventMax, longest } = await page.evaluate(() => window.__crmInpProbe!)
  return { inp: eventMax > 0 ? eventMax : null, longestTask: longest, interactions }
}
