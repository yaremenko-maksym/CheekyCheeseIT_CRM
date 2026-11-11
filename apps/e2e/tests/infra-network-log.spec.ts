/**
 * Self-test of the measuring fixtures every redesign screen spec relies on:
 * `recordNetwork` / `expectNoDuplicates` (fixtures/network-log.ts) and
 * `measureInp` (fixtures/inp.ts). Static fixture pages served through
 * `page.route` — no web app, no API, no database.
 */
import { test, expect, type Page } from '@playwright/test'
import { recordNetwork, expectNoDuplicates } from '../fixtures/network-log'
import { measureInp } from '../fixtures/inp'

const ORIGIN = 'http://infra.e2e.test'

/** Serves `html` at ORIGIN/ and a small JSON body for every ORIGIN/api/** call. */
async function serve(page: Page, html: string): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
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

    expect(summary.requests).toBe(1)
    expect(summary.duplicates).toEqual([])
    expect(summary.waterfallDepth).toBe(1)
    expect(summary.bytes).toBeGreaterThan(0)
    expectNoDuplicates(summary)
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
})

test.describe('E2E infra — INP', () => {
  test('a click handler that blocks 300 ms reports inp >= 300', async ({ page, browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'measureInp needs Chromium: CDP CPU throttling and the Event Timing API (see fixtures/inp.ts)',
    )
    await serve(
      page,
      `<!doctype html><html><body><main>
<button type="button" id="slow">Slow</button><output id="clicked"></output>
</main><script>
  document.getElementById('slow').addEventListener('click', () => {
    const end = performance.now() + 300
    while (performance.now() < end) {}
    document.getElementById('clicked').textContent = 'done'
  })
</script></body></html>`,
    )
    await page.goto(`${ORIGIN}/`)

    const result = await measureInp(page, async () => {
      await page.getByRole('button', { name: 'Slow' }).click()
      await expect(page.locator('#clicked')).toHaveText('done')
    })

    expect(result.inp).toBeGreaterThanOrEqual(300)
    expect(result.longestTask).toBeGreaterThanOrEqual(300)
  })
})
