// [DEBUG-ios7] throwaway diagnosis probe — deleted before the final commit.
import { test, devices, type Page } from '@playwright/test'
import { loginViaApi, SEED_ADMIN_EMAIL } from './fixtures'

const { defaultBrowserType: _d, ...iphone } = devices['iPhone 15']
const BR = (process.env['PROBE_BR'] ?? 'webkit') as 'webkit' | 'chromium'
test.use({ ...iphone, browserName: BR })

async function setup(page: Page) {
  if (BR === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  }
  await page.route(/\/api\/documents$/, async (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    await new Promise((res) => setTimeout(res, 8000))
    await r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'p.jpg',
        originalName: 'p.jpg',
        mimeType: 'image/jpeg',
      }),
    })
  })
  await loginViaApi(page, SEED_ADMIN_EMAIL)
}

async function makeFile(page: Page, w: number, h: number, q: number) {
  return page.evaluate(
    async ([w, h, q]) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')!
      const img = ctx.createImageData(w, h)
      for (let i = 0; i < img.data.length; i += 4) {
        const v = (Math.random() * 90) | 0
        img.data[i] = 80 + v
        img.data[i + 1] = 60 + ((i / 16000) % 120)
        img.data[i + 2] = 120 + v
        img.data[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', q))
      ;(window as unknown as { __f: File }).__f = new File([blob], 'IMG_0001.jpg', {
        type: 'image/jpeg',
      })
      return blob.size
    },
    [w, h, q] as const,
  )
}

async function measure(page: Page, inputSel: string, label: string) {
  const r = await page.evaluate(async (inputSel) => {
    const w = window as unknown as { __f: File }
    let last = performance.now()
    let max = 0
    const gaps: number[] = []
    let lastF = performance.now()
    let maxF = 0
    let raf = true
    const loop = () => {
      const n = performance.now()
      maxF = Math.max(maxF, n - lastF)
      lastF = n
      if (raf) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    const id = setInterval(() => {
      const n = performance.now()
      if (n - last > 50) gaps.push(Math.round(n - last))
      max = Math.max(max, n - last)
      last = n
    }, 10)
    const input = document.querySelector<HTMLInputElement>(inputSel)!
    const dt = new DataTransfer()
    dt.items.add(w.__f)
    input.files = dt.files
    const t0 = performance.now()
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const syncMs = performance.now() - t0
    await new Promise((res) => setTimeout(res, 5000))
    clearInterval(id)
    raf = false
    return {
      maxFrame: Math.round(maxF),
      syncMs: Math.round(syncMs),
      maxGap: Math.round(max),
      gaps,
      bodyPE: document.body.style.pointerEvents,
      imgs: [...document.querySelectorAll('[role="dialog"] img')].map(
        (i) => `${(i as HTMLImageElement).naturalWidth}x${(i as HTMLImageElement).naturalHeight}`,
      ),
    }
  }, inputSel)
  console.log(`[DEBUG-ios7] ${BR} ${label}`, JSON.stringify(r))
}

const W = Number(process.env['PROBE_W'] ?? 4000)
const H = Number(process.env['PROBE_H'] ?? 3000)

test('[DEBUG-ios7] receipt', async ({ page }) => {
  test.setTimeout(120_000)
  await setup(page)
  await page.goto('/finance')
  await page.getByTestId('finance-create-transaction-button').click()
  await page
    .locator('[data-testid="create-transaction-dialog"] input[type="file"]')
    .waitFor({ state: 'attached' })
  console.log('[DEBUG-ios7] bytes', await makeFile(page, W, H, 0.85))
  await measure(page, '[data-testid="create-transaction-dialog"] input[type="file"]', 'receipt')
})

test('[DEBUG-ios7] avatar', async ({ page }) => {
  test.setTimeout(120_000)
  await setup(page)
  await page.goto('/profile')
  await page.locator('button:has(svg.lucide-camera)').first().click()
  await page.getByTestId('avatar-file-input').waitFor({ state: 'attached' })
  console.log('[DEBUG-ios7] bytes', await makeFile(page, W, H, 0.5))
  await measure(page, '[data-testid="avatar-file-input"]', 'avatar')
})
