/**
 * CR-865-L-12: the duration label was `<Trans>{expr} хв</Trans>`, which compiles to the
 * positional msgid `{0} хв` — a translator sees `{0}` with no idea what it stands for,
 * and the `en` catalog had no translation at all, so English showed "хв". The label
 * now has a named placeholder and an English translation.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { RecordingDuration } from '../RecordingDuration'

describe('RecordingDuration', () => {
  it.each([
    ['uk', 2_520_000, '42 хв'],
    ['en', 2_520_000, '42 min'],
    ['en', 89_999, '1 min'],
    ['en', 90_000, '2 min'],
    ['en', 1_000, '1 min'],
  ] as const)('%s: %i ms reads %s', async (locale, durationMs, label) => {
    await loadCatalog(locale)
    render(<RecordingDuration durationMs={durationMs} />, { wrapper: I18nTestProvider })
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
