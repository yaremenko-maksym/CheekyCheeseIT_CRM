import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { AiLimitsNotice } from '../AiLimitsNotice'

const renderNotice = (notice: 'AI_LIMITS_EXHAUSTED' | null | undefined) =>
  render(
    <I18nTestProvider>
      <AiLimitsNotice notice={notice} testId="ai-limits" />
    </I18nTestProvider>,
  )

/** ADR 2026-11-03 §H.8: one notice for the queue and the admin sources page. */
describe('AiLimitsNotice', () => {
  beforeAll(async () => {
    await loadCatalog('uk')
  })

  it('shows the owner text inside a live region when the limits are exhausted', () => {
    renderNotice('AI_LIMITS_EXHAUSTED')
    const notice = screen.getByTestId('ai-limits')
    expect(notice).toHaveTextContent(
      'Пошук вакансій тимчасово недоступний: ліміти AI-моделей на зараз вичерпано. Спробуйте пізніше.',
    )
    expect(screen.getByRole('status')).toContainElement(notice)
  })

  it.each([null, undefined])('renders no text for %s, but keeps the live region mounted', (v) => {
    renderNotice(v)
    expect(screen.queryByTestId('ai-limits')).toBeNull()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})
