/**
 * Self-test of the measuring fixtures every redesign screen spec relies on:
 * `recordNetwork` / `expectNoDuplicates` (fixtures/network-log.ts) and
 * `measureInp` (fixtures/inp.ts). Static fixture pages served through
 * `page.route` — no web app, no API, no database.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type Page } from '@playwright/test'
import { recordNetwork, expectNoDuplicates, computeWaterfallDepth } from '../fixtures/network-log'
import { measureInp } from '../fixtures/inp'

const ORIGIN = 'http://infra.e2e.test'
const API_BODY = '{"ok":true}' // 11 bytes

/** Serves `html` at ORIGIN/ and API_BODY for every ORIGIN/api/** call. */
async function serve(page: Page, html: string): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: API_BODY })
    }
    if (url.pathname === '/static.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: html })
  })
}

/** A page that fires `urls` in parallel and writes the settled count into #done. */
function fetchPage(urls: string[]): string {
  return `<!doctype html><html><body><main><output id="done"></output></main>
<script src="/static.js"></script>
<script>
  Promise.all(${JSON.stringify(urls)}.map((u) => fetch(u))).then((r) => {
    document.getElementById('done').textContent = String(r.length)
  })
</script></body></html>`
}

/** A page with a "Slow" button (blocks 300 ms) and a "Fast" button (no work). */
const BUTTONS_PAGE = `<!doctype html><html><body><main>
<button type="button" id="slow">Slow</button><button type="button" id="fast">Fast</button>
<output id="clicked"></output>
</main><script>
  const out = document.getElementById('clicked')
  document.getElementById('slow').addEventListener('click', () => {
    const end = performance.now() + 300
    while (performance.now() < end) {}
    out.textContent = 'slow'
  })
  document.getElementById('fast').addEventListener('click', () => { out.textContent = 'fast' })
</script></body></html>`

test.describe('E2E infra — network log', () => {
  test('the same GET twice is one duplicate with count 2 (query order ignored)', async ({
    page,
  }) => {
    await serve(page, fetchPage(['/api/items?b=2&a=1', '/api/items?a=1&b=2']))
    const log = recordNetwork(page)
    await page.goto(`${ORIGIN}/`)
    await expect(page.locator('#done')).toHaveText('2')

    const summary = await log.stop()

    expect(summary.requests).toBe(2) // the document and /static.js are not API calls
    expect(summary.duplicates).toEqual([{ key: `GET ${ORIGIN}/api/items?a=1&b=2`, count: 2 }])
    expect(() => expectNoDuplicates(summary)).toThrow()
  })

  test('a single GET has no duplicates', async ({ page }) => {
    await serve(page, fetchPage(['/api/items']))
    const log = recordNetwork(page)
    await page.goto(`${ORIGIN}/`)
    await expect(page.locator('#done')).toHaveText('1')

    const summary = await log.stop()

    expect(summary).toEqual({
      requests: 1,
      duplicates: [],
      waterfallDepth: 1,
      bytes: API_BODY.length,
      untimed: 0,
    })
    expectNoDuplicates(summary)
  })

  test('two parallel calls are depth 1 and their bytes add up', async ({ page }) => {
    await serve(page, fetchPage(['/api/one', '/api/two']))
    const log = recordNetwork(page)
    await page.goto(`${ORIGIN}/`)
    await expect(page.locator('#done')).toHaveText('2')

    const summary = await log.stop()

    expect(summary.requests).toBe(2)
    expect(summary.waterfallDepth).toBe(1)
    expect(summary.bytes).toBe(2 * API_BODY.length)
    expect(summary.untimed).toBe(0)
  })

  test('a request started after another API response is waterfall depth 2', async ({ page }) => {
    await serve(
      page,
      `<!doctype html><html><body><main><output id="done"></output></main><script>
  fetch('/api/first').then(() => fetch('/api/second')).then(() => {
    document.getElementById('done').textContent = 'ok'
  })
</script></body></html>`,
    )
    const log = recordNetwork(page)
    await page.goto(`${ORIGIN}/`)
    await expect(page.locator('#done')).toHaveText('ok')

    const summary = await log.stop()

    expect(summary.requests).toBe(2)
    expect(summary.waterfallDepth).toBe(2)
  })

  test('computeWaterfallDepth: a 3-deep chain plus a parallel request is waterfall depth 3', () => {
    const waterfallDepth = computeWaterfallDepth([
      { start: 0, end: 10 },
      { start: 0, end: 50 },
      { start: 15, end: 25 },
      { start: 30, end: 40 },
    ])
    expect(waterfallDepth).toBe(3)
  })

  test('a redirected call does not break stop() and adds no bytes of its own', async ({ page }) => {
    // `route.fulfill` refuses 3xx statuses, so this case needs a real HTTP server.
    const server: Server = createServer((req, res) => {
      if (req.url === '/api/redirect') {
        res.writeHead(302, { location: '/api/target' }).end()
      } else if (req.url === '/api/target') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(API_BODY)
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }).end(fetchPage(['/api/redirect']))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const log = recordNetwork(page)
      await page.goto(`http://127.0.0.1:${port}/`)
      await expect(page.locator('#done')).toHaveText('1')

      const summary = await log.stop()

      expect(summary.requests).toBe(2) // the 302 and the followed /api/target
      expect(summary.bytes).toBe(API_BODY.length)
      expect(summary.duplicates).toEqual([])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test.describe('E2E infra — INP', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'measureInp needs Chromium: CDP CPU throttling and the Event Timing API (see fixtures/inp.ts)',
    )
    await serve(page, BUTTONS_PAGE)
    await page.goto(`${ORIGIN}/`)
  })

  test('a click handler that blocks 300 ms reports inp >= 300', async ({ page }) => {
    const result = await measureInp(page, async () => {
      await page.getByRole('button', { name: 'Slow' }).click()
      await expect(page.locator('#clicked')).toHaveText('slow')
    })

    expect(result.interactions).toBeGreaterThanOrEqual(1)
    expect(result.inp).toBeGreaterThanOrEqual(300)
    expect(result.longestTask).toBeGreaterThanOrEqual(300)
  })

  test('a slow interaction before the action does not leak into its result', async ({ page }) => {
    await page.getByRole('button', { name: 'Slow' }).click()
    await expect(page.locator('#clicked')).toHaveText('slow')

    const result = await measureInp(page, async () => {
      await page.getByRole('button', { name: 'Fast' }).click()
      await expect(page.locator('#clicked')).toHaveText('fast')
    })

    // null = faster than Event Timing's 16 ms floor; a number must be the fast click's own.
    expect(result.inp === null || result.inp < 300).toBe(true)
    expect(result.longestTask).toBeLessThan(300)
    expect(result.interactions).toBeGreaterThanOrEqual(1)
  })

  test('an action with no interaction is reported as unmeasured, not as 0', async ({ page }) => {
    const result = await measureInp(page, async () => {
      await expect(page.getByRole('button', { name: 'Fast' })).toBeVisible()
    })

    expect(result.inp).toBeNull()
    expect(result.interactions).toBe(0)
  })
})
