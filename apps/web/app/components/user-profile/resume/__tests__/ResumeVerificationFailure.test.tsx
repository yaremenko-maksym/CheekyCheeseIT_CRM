/**
 * ResumeVerificationFailure — QA-L-1: on FAILED with unsaved facts the Retry is disabled, and a line
 * next to it says why (save the changes first), so the disabled button is not a dead end.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeVerificationFailure } from '../ResumeVerificationFailure'

const REASON = 'Спершу збережіть зміни у фактах — повторна перевірка використовує збережені факти.'

function renderFailure(retryDisabled: boolean, disabled = false) {
  return render(
    <ResumeVerificationFailure
      code="WRITER_UNAVAILABLE"
      report={null}
      variant="failed"
      onFocusField={() => true}
      onRetry={() => {}}
      onChooseTemplate={() => {}}
      disabled={disabled}
      retryDisabled={retryDisabled}
    />,
    { wrapper: I18nTestProvider },
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('ResumeVerificationFailure — a Retry blocked by unsaved facts (QA-L-1)', () => {
  it('a dirty form disables Retry and says why, next to it', () => {
    renderFailure(true)
    const retry = screen.getByTestId('resume-verification-retry')
    expect(retry).toBeDisabled()
    expect(retry).toHaveAccessibleDescription(REASON)
    expect(screen.getByTestId('resume-verification-retry-reason')).toHaveTextContent(REASON)
  })

  it('no reason while the form is clean, or while the viewer cannot act at all', () => {
    const { unmount } = renderFailure(false)
    expect(screen.getByTestId('resume-verification-retry')).toBeEnabled()
    expect(screen.queryByTestId('resume-verification-retry-reason')).toBeNull()
    unmount()
    renderFailure(true, true)
    expect(screen.queryByTestId('resume-verification-retry-reason')).toBeNull()
  })
})
