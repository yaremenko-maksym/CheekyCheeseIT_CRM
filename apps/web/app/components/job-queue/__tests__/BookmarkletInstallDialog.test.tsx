import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { BookmarkletInstallDialog, bookmarkletFor, browserOf } from '../BookmarkletInstallDialog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const FIREFOX_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0'

const renderDialog = () =>
  render(
    <I18nTestProvider>
      <BookmarkletInstallDialog open onOpenChange={() => {}} />
    </I18nTestProvider>,
  )

beforeEach(async () => {
  await loadCatalog('uk')
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('browserOf', () => {
  it('tells the browser families apart, Edge and Chrome sharing one set of steps', () => {
    expect(browserOf(CHROME_MAC)).toBe('chromium')
    expect(browserOf(EDGE_WIN)).toBe('chromium')
    expect(browserOf(FIREFOX_WIN)).toBe('firefox')
    expect(browserOf(SAFARI_MAC)).toBe('safari')
  })
})

describe('bookmarkletFor', () => {
  it('bakes the CRM origin into the script', () => {
    const url = bookmarkletFor('https://app.example.com')
    expect(url.startsWith('javascript:')).toBe(true)
    expect(decodeURIComponent(url)).toContain("'https://app.example.com/job-queue'")
    expect(url).not.toContain('__CRM_ORIGIN__')
  })
})

describe('BookmarkletInstallDialog', () => {
  it('copies the script with the CRM origin and confirms it', async () => {
    const user = userEvent.setup({ delay: null })
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    renderDialog()
    await user.click(screen.getByTestId('bookmarklet-copy'))
    expect(writeText).toHaveBeenCalledWith(bookmarkletFor(window.location.origin))
    expect(toast.success).toHaveBeenCalledWith('Скрипт скопійовано')
  })

  it('says so when the clipboard refuses, so HR can drag the link instead', async () => {
    const user = userEvent.setup({ delay: null })
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    renderDialog()
    await user.click(screen.getByTestId('bookmarklet-copy'))
    expect(toast.error).toHaveBeenCalledWith(
      'Не вдалося скопіювати скрипт. Перетягніть посилання «До CRM» на панель закладок.',
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('offers the same script as a draggable link that does nothing when clicked here', async () => {
    renderDialog()
    const link = screen.getByTestId('bookmarklet-drag-link')
    expect(link.getAttribute('href')).toBe(bookmarkletFor(window.location.origin))
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
  })

  // one marker per browser's own step: each list must carry its marker and none of the others
  const MARKERS = {
    chromium: 'менеджер закладок',
    firefox: 'бібліотека закладок',
    safari: 'Редагувати закладки',
  } as const
  it.each([
    ['chromium', CHROME_MAC, 'Cmd+Shift+O'],
    ['chromium', EDGE_WIN, 'Ctrl+Shift+O'],
    ['firefox', FIREFOX_WIN, 'Ctrl+Shift+O'],
    ['safari', SAFARI_MAC, 'Cmd+D'],
  ] as const)(
    'shows only the %s steps for its user agent, with its own keys',
    (browser, ua, keys) => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: ua })
      renderDialog()
      const steps = screen.getByTestId('bookmarklet-steps')
      expect(steps.dataset.browser).toBe(browser)
      expect(steps).toHaveTextContent(keys)
      const present = Object.entries(MARKERS)
        .filter(([, marker]) => steps.textContent?.includes(marker))
        .map(([name]) => name)
      expect(present).toEqual([browser])
    },
  )

  it('explains how to use the script and what "not recognized" means', () => {
    renderDialog()
    const how = within(screen.getByTestId('bookmarklet-how-it-works'))
    expect(how.getAllByRole('listitem').length).toBeGreaterThanOrEqual(4)
    expect(screen.getByTestId('bookmarklet-not-recognized')).toBeTruthy()
  })
})
