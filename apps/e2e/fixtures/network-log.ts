/**
 * Network discipline probe for E2E (redesign v2 spec §4.6): records the API
 * calls a page makes and reports duplicates, waterfall depth and bytes.
 *
 *   const log = recordNetwork(page)
 *   await page.goto('/projects')
 *   await expect(page.getByTestId('projects-root')).toBeVisible()
 *   expectNoDuplicates(await log.stop())
 *
 * Only API calls count: a request whose URL path starts with `/api/`.
 * Two calls are the same when METHOD + URL (query parameters sorted) match,
 * so `?b=2&a=1` and `?a=1&b=2` are one key. Works in every browser project.
 */
import { expect, type Page, type Request } from '@playwright/test'

export interface NetworkSummary {
  requests: number
  duplicates: { key: string; count: number }[]
  waterfallDepth: number
  bytes: number
  /** Calls whose response end time the browser did not report: they cannot start a chain, so `waterfallDepth` may undercount when this is > 0. */
  untimed: number
}

function keyOf(request: Request): string {
  const url = new URL(request.url())
  url.searchParams.sort()
  url.hash = ''
  return `${request.method()} ${url.toString()}`
}

/**
 * Computes the waterfall depth in O(n log n) using a sweep-line algorithm:
 * depth of a call = 1 + the deepest call whose response ended before (or at) it started.
 * Calls without a response end time (untimed) cannot start/continue a chain.
 */
export function computeWaterfallDepth(
  requests: { start: number; end?: number | undefined }[],
): number {
  if (requests.length === 0) return 0

  // Preserve original relative order as tie-breaker for identical start times
  const byStart = requests
    .map((r, origIndex) => ({
      start: r.start,
      end: r.end,
      origIndex,
      byStartIndex: 0,
      depth: 0,
    }))
    .sort((a, b) => a.start - b.start || a.origIndex - b.origIndex)

  byStart.forEach((r, i) => {
    r.byStartIndex = i
  })

  // Only calls with a defined response end time can be parents of subsequent calls
  const timed = byStart.filter((r): r is typeof r & { end: number } => r.end !== undefined)
  const byEnd = [...timed].sort((a, b) => a.end - b.end || a.byStartIndex - b.byStartIndex)

  let p = 0
  let maxCompletedDepth = 0
  let maxDepth = 0

  for (const r of byStart) {
    while (
      p < byEnd.length &&
      (byEnd[p]!.end < r.start ||
        (byEnd[p]!.end === r.start && byEnd[p]!.byStartIndex < r.byStartIndex))
    ) {
      if (byEnd[p]!.depth > maxCompletedDepth) {
        maxCompletedDepth = byEnd[p]!.depth
      }
      p++
    }

    const currentDepth = maxCompletedDepth + 1
    r.depth = currentDepth
    if (currentDepth > maxDepth) {
      maxDepth = currentDepth
    }
  }

  return maxDepth
}

/**
 * Starts recording API calls on `page`. Call `stop()` only once the UI has
 * settled (assert the final state first): it makes one page round-trip so
 * pending `request` events arrive, detaches the listener, waits for every
 * recorded call to finish (a call that never ends hangs the test until its
 * timeout — do not use around long-polling) and summarises.
 * `bytes` is the decoded response body size (a redirect counts 0; the call it
 * leads to is recorded on its own); `waterfallDepth` is the longest chain of
 * calls where each one started after the previous one's response ended,
 * measured on the browser's own clock.
 */
export function recordNetwork(page: Page): { stop(): Promise<NetworkSummary> } {
  const requests: Request[] = []
  const onRequest = (request: Request): void => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request)
  }
  page.on('request', onRequest)

  return {
    async stop(): Promise<NetworkSummary> {
      await page.evaluate(() => 0) // flush `request` events still on the wire
      page.off('request', onRequest)

      const done = await Promise.all(
        requests.map(async (request) => {
          const response = await request.response()
          const failed = response === null || (await response.finished()) !== null
          const t = request.timing()
          return {
            key: keyOf(request),
            start: t.startTime,
            end: t.responseEnd >= 0 ? t.startTime + t.responseEnd : undefined,
            // 3xx has no body: `body()` throws "unavailable for redirect responses".
            bytes:
              failed || (response.status() >= 300 && response.status() < 400)
                ? 0
                : (await response.body()).length, // any other body error fails loudly
          }
        }),
      )

      const counts = new Map<string, number>()
      for (const d of done) counts.set(d.key, (counts.get(d.key) ?? 0) + 1)
      const duplicates = [...counts]
        .filter(([, count]) => count > 1)
        .map(([key, count]) => ({ key, count }))

      return {
        requests: done.length,
        duplicates,
        waterfallDepth: computeWaterfallDepth(done),
        bytes: done.reduce((sum, d) => sum + d.bytes, 0),
        untimed: done.filter((d) => d.end === undefined).length,
      }
    },
  }
}

/** Fails the test when any API call was made more than once. */
export function expectNoDuplicates(s: NetworkSummary): void {
  expect(s.duplicates, 'duplicate API requests (METHOD + URL with sorted query)').toEqual([])
}
