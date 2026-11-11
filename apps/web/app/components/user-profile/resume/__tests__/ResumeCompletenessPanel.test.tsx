/**
 * ResumeCompletenessPanel — the live list of what blocks Submit (design §5.1).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeCompletenessPanel } from '../ResumeCompletenessPanel'

const noop = () => undefined

function renderPanel(props: Partial<Parameters<typeof ResumeCompletenessPanel>[0]> = {}) {
  const onSubmit = vi.fn()
  const onFocusPath = vi.fn()
  render(
    <ResumeCompletenessPanel
      issues={[]}
      onFocusPath={onFocusPath}
      onSubmit={onSubmit}
      onSaveDraft={noop}
      canSave={false}
      disabled={false}
      pending={null}
      {...props}
    />,
    { wrapper: I18nTestProvider },
  )
  return { onSubmit, onFocusPath }
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('ResumeCompletenessPanel', () => {
  it('Submit disabled while completeness lists issues', () => {
    const { onSubmit } = renderPanel({
      issues: [
        { path: 'headline', code: 'HEADLINE_MISSING' },
        { path: 'languages', code: 'ENGLISH_MISSING' },
      ],
    })
    const submit = screen.getByRole('button', { name: 'Надіслати на перевірку' })
    expect(submit).toBeDisabled()
    // The reason is text, tied to the button, not only the grey look.
    expect(submit).toHaveAccessibleDescription('Спершу заповніть поля зі списку')
    // The polite live region carries the count; it stays mounted (L-3).
    expect(screen.getByTestId('resume-completeness-live')).toHaveTextContent('2 поля')
    fireEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('enables Submit and shows the clean title once nothing is missing', () => {
    const { onSubmit } = renderPanel()
    expect(
      screen.getByRole('heading', { name: 'Усе заповнено — можна надсилати' }),
    ).toBeInTheDocument()
    // The clean state is announced by the same live region, not only shown.
    const live = screen.getByTestId('resume-completeness-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('Усе заповнено — можна надсилати')
    const submit = screen.getByRole('button', { name: 'Надіслати на перевірку' })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('keeps Submit disabled while the form is disabled (a check is running)', () => {
    renderPanel({ disabled: true })
    expect(screen.getByRole('button', { name: 'Надіслати на перевірку' })).toBeDisabled()
  })

  it('labels each row by its field and its code text', () => {
    const { onFocusPath } = renderPanel({
      issues: [{ path: 'experience.1.notes', code: 'NO_NOTES' }],
    })
    const row = screen.getByRole('button', { name: /Місце роботи 2 · Нотатки/ })
    expect(row).toHaveTextContent('Додайте хоча б одну нотатку про досягнення')
    fireEvent.click(row)
    expect(onFocusPath).toHaveBeenCalledWith('experience.1.notes')
  })

  it('renders the profile-name issue as a plain row, not a button', () => {
    renderPanel({ issues: [{ path: 'displayName', code: 'NAME_NON_LATIN' }] })
    expect(screen.getByText('Ім’я в профілі')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ім’я в профілі/ })).toBeNull()
  })
})
