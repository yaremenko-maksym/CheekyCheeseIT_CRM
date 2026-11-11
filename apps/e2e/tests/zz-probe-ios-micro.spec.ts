// [DEBUG-ios7] throwaway micro-benchmark — deleted before the final commit.
import { test, devices } from '@playwright/test'

const { defaultBrowserType: _d, ...iphone } = devices['iPhone 15']
test.use({ ...iphone, browserName: 'webkit' })

test('[DEBUG-ios7] decode costs', async ({ page }) => {
  await page.setContent('<p>x</p>')
  const r = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 4000
    c.height = 3000
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(4000, 3000)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 90) | 0
      img.data[i] = 80 + v
      img.data[i + 1] = 60
      img.data[i + 2] = 120 + v
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    const file: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.85))
    c.width = 0
    const out: Record<string, number> = {}
    let last = performance.now()
    let max = 0
    const id = setInterval(() => {
      const n = performance.now()
      max = Math.max(max, n - last)
      last = n
    }, 5)
    const lap = async (k: string, f: () => unknown) => {
      max = 0
      last = performance.now()
      const t = performance.now()
      await f()
      await new Promise((r) => setTimeout(r, 50))
      out[k + '_total'] = Math.round(performance.now() - t)
      out[k + '_maxBlock'] = Math.round(max)
    }
    let bm!: ImageBitmap
    await lap('createImageBitmap', async () => {
      bm = await createImageBitmap(file)
    })
    const cv = document.createElement('canvas')
    cv.width = 1024
    cv.height = 768
    await lap('drawImage', () => cv.getContext('2d')!.drawImage(bm, 0, 0, 1024, 768))
    await lap('toBlob', () => new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9)))
    bm.close()
    await lap('resizeBitmap', async () => {
      const b = await createImageBitmap(file, { resizeWidth: 1024, resizeHeight: 768 })
      out['resized_w'] = b.width
      b.close()
    })
    const i = new Image()
    await lap('imgDecode', async () => {
      i.src = URL.createObjectURL(file)
      await i.decode()
      out['img_w'] = i.naturalWidth
    })
    await lap('imgDraw', () => cv.getContext('2d')!.drawImage(i, 0, 0, 1024, 768))
    const src = `onmessage = async (e) => {
      const bm = await createImageBitmap(e.data)
      const oc = new OffscreenCanvas(1024, 768)
      oc.getContext('2d').drawImage(bm, 0, 0, 1024, 768)
      bm.close()
      postMessage(await oc.convertToBlob({ type: 'image/jpeg', quality: 0.9 }))
    }`
    const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    await lap('worker', async () => {
      const b: Blob = await new Promise((res) => {
        wk.onmessage = (e) => res(e.data as Blob)
        wk.postMessage(file)
      })
      out['worker_bytes'] = b.size
    })
    clearInterval(id)
    return { bytes: file.size, ...out }
  })
  console.log('[DEBUG-ios7] micro', JSON.stringify(r))
})
