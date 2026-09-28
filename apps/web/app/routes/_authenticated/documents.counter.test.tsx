/**
 * documents.counter.test.tsx — task-i18n-stage3e-pr1, AC3. Pins the
 * `DocumentsCounterText` component (the /documents count chip) on the ICU
 * plural rule boundaries `uk` needs — 1 (one), 2 (few), 5 (many), 11 (many,
 * NOT "few" despite ending in 1), 21 (one again) — replacing the old
 * hardcoded `pluralizeDocuments(n)` mod10/mod100 helper. Rendered through
 * the REAL compiled catalog (`I18nTestProvider`/`loadCatalog`), so a broken
 * `<Plural>` form (StringLiteral mutant, or `plural()` swapped for `select`)
 * fails a real assertion instead of passing by construction.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { i18n } from '@lingui/core'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { DocumentsCounterText, STATUS_TAB_LABEL_MESSAGES } from './documents'

const CASES: Array<[n: number, uk: string]> = [
  [1, '1 документ'],
  [2, '2 документи'],
  [5, '5 документів'],
  [11, '11 документів'],
  [21, '21 документ'],
]

describe('DocumentsCounterText — ICU plural forms (uk)', () => {
  it.each(CASES)('n=%i renders "%s"', async (n, expected) => {
    await loadCatalog('uk')
    const { unmount, container } = render(
      <DocumentsCounterText count={n} statusTab="ACTIVE" categoryFilter="ALL" />,
      { wrapper: I18nTestProvider },
    )
    expect(container.textContent).toBe(expected)
    unmount()
  })
})

describe('DocumentsCounterText — ICU plural forms (en)', () => {
  it('n=1 renders "1 document" (one)', async () => {
    await loadCatalog('en')
    const { unmount, container } = render(
      <DocumentsCounterText count={1} statusTab="ACTIVE" categoryFilter="ALL" />,
      { wrapper: I18nTestProvider },
    )
    expect(container.textContent).toBe('1 document')
    unmount()
  })

  it('n=5 renders "5 documents" (other)', async () => {
    await loadCatalog('en')
    const { unmount, container } = render(
      <DocumentsCounterText count={5} statusTab="ACTIVE" categoryFilter="ALL" />,
      { wrapper: I18nTestProvider },
    )
    expect(container.textContent).toBe('5 documents')
    unmount()
  })
})

describe('DocumentsCounterText — statusTab suffix', () => {
  it('ARCHIVED appends " · в архіві" (uk)', async () => {
    await loadCatalog('uk')
    render(<DocumentsCounterText count={3} statusTab="ARCHIVED" categoryFilter="ALL" />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByText(/· в архіві$/)).toBeInTheDocument()
  })

  it('ALL appends " · всі" (uk)', async () => {
    await loadCatalog('uk')
    render(<DocumentsCounterText count={3} statusTab="ALL" categoryFilter="ALL" />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByText(/· всі$/)).toBeInTheDocument()
  })

  it('ACTIVE appends no suffix', async () => {
    await loadCatalog('uk')
    const { container } = render(
      <DocumentsCounterText count={3} statusTab="ACTIVE" categoryFilter="ALL" />,
      { wrapper: I18nTestProvider },
    )
    expect(container.textContent).toBe('3 документи')
  })
})

describe('DocumentsCounterText — category suffix (not derived by .toLowerCase())', () => {
  it('CONTRACT filter appends " · договір" (uk, lower-case, from its own msg)', async () => {
    await loadCatalog('uk')
    render(<DocumentsCounterText count={4} statusTab="ACTIVE" categoryFilter="CONTRACT" />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByText(/· договір$/)).toBeInTheDocument()
  })

  it('INVOICE filter appends " · рахунок" (uk), never "· інвойс"', async () => {
    await loadCatalog('uk')
    const { container } = render(
      <DocumentsCounterText count={4} statusTab="ACTIVE" categoryFilter="INVOICE" />,
      { wrapper: I18nTestProvider },
    )
    expect(container.textContent).toBe('4 документи · рахунок')
    expect(container.textContent).not.toMatch(/інвойс/i)
  })

  it('ALL filter appends no category suffix', async () => {
    await loadCatalog('uk')
    const { container } = render(
      <DocumentsCounterText count={4} statusTab="ACTIVE" categoryFilter="ALL" />,
      { wrapper: I18nTestProvider },
    )
    expect(container.textContent).toBe('4 документи')
  })
})

describe('STATUS_TAB_LABEL_MESSAGES — the ADMIN-only status toggle labels', () => {
  it('resolves every key to its own uk text', async () => {
    await loadCatalog('uk')
    expect(i18n._(STATUS_TAB_LABEL_MESSAGES.ALL)).toBe('Всі')
    expect(i18n._(STATUS_TAB_LABEL_MESSAGES.ACTIVE)).toBe('Активні')
    expect(i18n._(STATUS_TAB_LABEL_MESSAGES.ARCHIVED)).toBe('Архів')
  })

  it('resolves every key to its own en text', async () => {
    await loadCatalog('en')
    expect(i18n._(STATUS_TAB_LABEL_MESSAGES.ALL)).toBe('All')
    expect(i18n._(STATUS_TAB_LABEL_MESSAGES.ACTIVE)).toBe('Active')
    // "Archived" (not "Archive") — dedup with the already-established
    // catalog entry for the same uk source text elsewhere in the app.
    expect(i18n._(STATUS_TAB_LABEL_MESSAGES.ARCHIVED)).toBe('Archived')
  })
})
