/**
 * Characterization tests for `EmailChangeWarningDialog` after it moved out of
 * `UserDialog.tsx` verbatim. The revert-on-cancel behavior lives in the PARENT's
 * `onCancel` handler (the form never enters the component), so it is pinned via a
 * harness that mirrors the parent wiring.
 */
import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import { useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { I18nTestProvider } from '@/test/i18n'
import { EmailChangeWarningDialog } from '../EmailChangeWarningDialog'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

describe('EmailChangeWarningDialog (props)', () => {
  const base = {
    editingUser: { displayName: 'Ірина Коваль' },
    originalEmail: 'old@example.com',
  }

  it('is hidden when pendingEmailChange is null', () => {
    render(
      <EmailChangeWarningDialog
        {...base}
        pendingEmailChange={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('email-change-warning')).toBeNull()
  })

  it('is hidden when pendingEmailChange is an empty string', () => {
    render(
      <EmailChangeWarningDialog
        {...base}
        pendingEmailChange=""
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('email-change-warning')).toBeNull()
  })

  it('renders warning with display name, old and new email when pending is set', () => {
    render(
      <EmailChangeWarningDialog
        {...base}
        pendingEmailChange="new@example.com"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const dialog = screen.getByTestId('email-change-warning')
    expect(dialog.textContent).toContain('Ірина Коваль')
    expect(dialog.textContent).toContain('old@example.com')
    expect(dialog.textContent).toContain('new@example.com')
    expect(screen.getByText('old@example.com').tagName).toBe('CODE')
    expect(screen.getByText('new@example.com').tagName).toBe('CODE')
  })

  it('renders without crashing when editingUser is null', () => {
    render(
      <EmailChangeWarningDialog
        {...base}
        editingUser={null}
        pendingEmailChange="new@example.com"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByTestId('email-change-warning')).toBeTruthy()
  })

  it('confirm button fires onConfirm (not onCancel); Radix also closes via onDismiss', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const onDismiss = vi.fn()
    render(
      <EmailChangeWarningDialog
        {...base}
        pendingEmailChange="new@example.com"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByTestId('email-change-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    // Radix closes the AlertDialog on action click -> onOpenChange(false); the
    // parent's dismiss is idempotent with its confirm (both clear pending).
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('cancel button fires onCancel (and not onConfirm)', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <EmailChangeWarningDialog
        {...base}
        pendingEmailChange="new@example.com"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Escape dismisses via onDismiss only', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const onDismiss = vi.fn()
    render(
      <EmailChangeWarningDialog
        {...base}
        pendingEmailChange="new@example.com"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.keyDown(screen.getByTestId('email-change-warning'), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

/** Mirrors the UserDialog parent wiring: form + pending state stay in the parent. */
function ParentHarness() {
  const originalEmail = 'old@example.com'
  const form = useForm({ defaultValues: { email: 'new@example.com' } })
  const [pending, setPending] = useState<string | null>('new@example.com')
  return (
    <>
      <form.Subscribe selector={(s) => s.values.email}>
        {(email) => <output data-testid="email-value">{email}</output>}
      </form.Subscribe>
      <output data-testid="pending">{pending ?? 'none'}</output>
      <EmailChangeWarningDialog
        pendingEmailChange={pending}
        editingUser={{ displayName: 'Ірина' }}
        originalEmail={originalEmail}
        onCancel={() => {
          form.setFieldValue('email', originalEmail)
          setPending(null)
        }}
        onConfirm={() => setPending(null)}
        onDismiss={() => setPending(null)}
      />
    </>
  )
}

describe('EmailChangeWarningDialog (parent wiring)', () => {
  it('cancel reverts the email field to the original and closes', () => {
    render(<ParentHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(screen.getByTestId('email-value').textContent).toBe('old@example.com')
    expect(screen.getByTestId('pending').textContent).toBe('none')
    expect(screen.queryByTestId('email-change-warning')).toBeNull()
  })

  it('confirm keeps the new email and closes', () => {
    render(<ParentHarness />)
    fireEvent.click(screen.getByTestId('email-change-confirm'))
    expect(screen.getByTestId('email-value').textContent).toBe('new@example.com')
    expect(screen.getByTestId('pending').textContent).toBe('none')
    expect(screen.queryByTestId('email-change-warning')).toBeNull()
  })
})
