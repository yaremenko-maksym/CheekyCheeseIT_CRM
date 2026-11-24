import { afterEach, describe, expect, it, vi } from 'vitest'

import { fromBase64Url } from '../../lib/base64url'

// entry.ts runs on import, like the bookmarklet on a page: import it fresh per case
const run = async (): Promise<void> => {
  vi.resetModules()
  await import('../entry')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('bookmarklet entry', () => {
  it('opens the CRM queue in a new tab with the page and the selection, keeping no opener', async () => {
    document.title = 'Senior Dev'
    document.body.innerHTML = '<p>picked</p>'
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'x'.repeat(250),
    } as Selection)

    await run()

    expect(open).toHaveBeenCalledTimes(1)
    const [url, target, features] = open.mock.calls[0] ?? []
    expect(target).toBe('_blank')
    expect(features).toBe('noopener,noreferrer')
    const [base, hash] = String(url).split('#external=')
    expect(base).toBe('__CRM_ORIGIN__/job-queue')
    expect(JSON.parse(fromBase64Url(String(hash)))).toMatchObject({ description: 'x'.repeat(250) })
  })

  it('reads the page without a selection when the browser gives none', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    vi.spyOn(window, 'getSelection').mockReturnValue(null)

    await run()

    const hash = String(open.mock.calls[0]?.[0]).split('#external=')[1]
    expect(JSON.parse(fromBase64Url(String(hash))).description).toBeUndefined()
  })

  it('says in both languages what broke when the page cannot be read', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('blocked')
    })
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)

    await run()

    expect(alert).toHaveBeenCalledWith(
      'To CRM: could not read this page (Error: blocked). ' +
        'Copy the vacancy text and paste it into the CRM. / ' +
        'Не вдалося прочитати сторінку. Скопіюйте текст вакансії та вставте його в CRM.',
    )
  })
})
