/**
 * VariablesPanel.i18n.test.tsx — task-i18n-stage4-task5.
 *
 * `CONTRACT_VARIABLE_DESCRIPTIONS` became `Record<string, MessageDescriptor>`
 * in this task — `systemEntries` resolves each descriptor through
 * `useLingui()`'s `i18n._()` instead of reading a plain string. Same pattern
 * as `role-select.locale.test.tsx`: `loadCatalog(locale)` activates the real
 * compiled catalog on the shared `i18n` singleton before render.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { VariablesPanel } from '../VariablesPanel'

function renderPanel() {
  return render(
    <VariablesPanel
      body=""
      customVariables={[]}
      onCustomVariablesChange={vi.fn()}
      onInsertToken={vi.fn()}
    />,
    { wrapper: I18nTestProvider },
  )
}

describe('VariablesPanel — system variable descriptions (i18n)', () => {
  it('renders the uk description for a system variable', async () => {
    await loadCatalog('uk')
    const { unmount } = renderPanel()
    fireEvent.click(screen.getByTestId('system-vars-toggle'))
    // fix-round 1 (COPY-M-7): text updated with the description text.
    expect(screen.getByText('ПІБ співробітника для контракту (юридичне ім’я)')).toBeInTheDocument()
    unmount()
  })

  it('renders the en description for the SAME system variable, per active locale', async () => {
    await loadCatalog('en')
    const { unmount } = renderPanel()
    fireEvent.click(screen.getByTestId('system-vars-toggle'))
    // fix-round 1 (COPY-M-7): text updated with the description text.
    expect(screen.getByText("Employee's full legal name for the contract")).toBeInTheDocument()
    unmount()
  })
})
