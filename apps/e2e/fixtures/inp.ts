/**
 * Interaction speed probe for E2E (redesign v2 spec §5 thresholds:
 * INP < 100 ms / long task 50 ms = 10; INP < 200 ms / long task 200 ms = 9.5).
 *
 *   const { inp, longestTask } = await measureInp(page, async () => {
 *     await page.getByTestId('filter-open').click()
 *     await expect(page.getByRole('dialog')).toBeVisible()
 *   })
 *   expect(inp).toBeLessThan(100)
 *
 * CHROMIUM ONLY — it throws in any other browser. It needs CDP for CPU
 * throttling (`Emulation.setCPUThrottlingRate`, default 4x, a mid-range phone)
 * and the `longtask` entry type, neither of which WebKit exposes to
 * Playwright. Specs that run in `webkit-iphone` skip their INP case with
 * `test.skip(browserName !== 'chromium', ...)`.
 *
 * `inp` is web-vitals' INP for the page so far (the slowest interaction, as
 * the real metric reports it), so measure on a fresh navigation for a number
 * that belongs to `action` alone. `longestTask` covers only `action`.
 */
import type { Page } from '@playwright/test'

interface Probe {
  inp: number
  longest: number
  eventMax: number
}

declare global {
  interface Window {
    __crmInpProbe?: Probe
    webVitals?: typeof import('web-vitals')
  }
}

export async function measureInp(
  page: Page,
  action: () => Promise<void>,
  opts?: { cpuThrottle?: number },
): Promise<{ inp: number; longestTask: number }> {
  const browser = page.context().browser()?.browserType().name()
  if (browser !== 'chromium') {
    throw new Error(`measureInp needs Chromium (CDP + Event Timing); got ${browser ?? 'unknown'}`)
  }

  // The package's `require` entry is a UMD build: in the page it sets `window.webVitals`.
  await page.addScriptTag({ path: require.resolve('web-vitals') })
  await page.evaluate(() => {
    const probe: Probe = { inp: 0, longest: 0, eventMax: 0 }
    window.__crmInpProbe = probe
    const t0 = performance.now()
    window.webVitals!.onINP((m) => (probe.inp = m.value), {
      reportAllChanges: true,
      durationThreshold: 0,
    })
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.startTime >= t0) probe.longest = Math.max(probe.longest, e.duration)
    }).observe({ type: 'longtask' })
    // Raw Event Timing for `action` only: tells us web-vitals has something to report.
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[])
        if (e.interactionId && e.startTime >= t0)
          probe.eventMax = Math.max(probe.eventMax, e.duration)
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit)
  })

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts?.cpuThrottle ?? 4 })
  try {
    await action()
    // Event Timing entries arrive after the next paint; let two frames and an idle period pass.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestIdleCallback(() => resolve(), { timeout: 1000 })),
          ),
        ),
    )
    // web-vitals reports from an idle callback (capped at 1 s); wait until it caught up.
    // shortcut: an interaction under Event Timing's 16 ms floor yields no entry, so eventMax
    // stays 0 and `inp` is whatever the page had before — fine for "< 100 ms" assertions.
    await page.waitForFunction(
      () => {
        const p = window.__crmInpProbe!
        return p.eventMax === 0 || p.inp >= p.eventMax
      },
      undefined,
      { timeout: 5_000 },
    )
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await cdp.detach()
  }

  return page.evaluate(() => {
    const p = window.__crmInpProbe!
    return { inp: p.inp, longestTask: p.longest }
  })
}
