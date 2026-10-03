/**
 * i18n server-text PR4 (S4). The legends API used to answer
 * `authorName: 'Неизвестный'` when the author's user row was gone; it now
 * answers `null` and the client names the author in the viewer's locale.
 * Expected strings are independent literals, not the helper's own output.
 */
import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '@/test/i18n'
import { resolveLegendAuthor } from '../legend-author'

describe('resolveLegendAuthor', () => {
  it('uk: a null author renders «Невідомо», never the old Russian placeholder', async () => {
    await loadCatalog('uk')
    const label = resolveLegendAuthor(i18n, null)
    expect(label).toBe('Невідомо')
    expect(label).not.toBe('Неизвестный')
  })

  it('en: a null author renders «Unknown»', async () => {
    await loadCatalog('en')
    expect(resolveLegendAuthor(i18n, null)).toBe('Unknown')
  })

  it('a known author is shown verbatim — including a name that is literally "null"', async () => {
    await loadCatalog('uk')
    expect(resolveLegendAuthor(i18n, 'Іван Петренко')).toBe('Іван Петренко')
    expect(resolveLegendAuthor(i18n, 'null')).toBe('null')
  })
})
