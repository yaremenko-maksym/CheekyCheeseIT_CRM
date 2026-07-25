/**
 * LanguageSwitcher — plan §1/§2/§4 A6: every locale option is a real
 * `<a href>` (crawlable regardless of open/closed state), clicking writes
 * the `pref_locale` cookie.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { LanguageSwitcher } from '@/components/marketing/language-switcher'
import { getDictionary } from '@/i18n/dictionaries'

afterEach(() => {
  cleanup()
  document.cookie = 'pref_locale=; path=/; max-age=0'
})

describe('LanguageSwitcher', () => {
  it('renders all 5 locale options as real <a href> links, present in the DOM regardless of open state', () => {
    render(
      <LanguageSwitcher locale="en" path="/careers" t={getDictionary('en').languageSwitcher} />,
    )
    const links = screen.getAllByRole('menuitem', { hidden: true })
    expect(links).toHaveLength(5)
    const hrefs = links.map((l) => l.getAttribute('href')).sort()
    expect(hrefs).toEqual([
      '/careers/',
      '/es/careers/',
      '/pt/careers/',
      '/ru/careers/',
      '/uk/careers/',
    ])
  })

  it('marks the current locale option with aria-current', () => {
    render(<LanguageSwitcher locale="ru" path="/" t={getDictionary('ru').languageSwitcher} />)
    const current = screen
      .getAllByRole('menuitem', { hidden: true })
      .find((l) => l.textContent?.includes('RU'))
    expect(current?.getAttribute('aria-current')).toBe('true')
  })

  it('writes the pref_locale cookie when a locale option is clicked', async () => {
    const user = userEvent.setup()
    render(
      <LanguageSwitcher locale="en" path="/careers" t={getDictionary('en').languageSwitcher} />,
    )
    const button = screen.getByRole('button')
    await user.click(button)
    const ruOption = screen.getByRole('menuitem', { name: /Русский/ })
    await user.click(ruOption)
    expect(document.cookie).toContain('pref_locale=ru')
  })
})
