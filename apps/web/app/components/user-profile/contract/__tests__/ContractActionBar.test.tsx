import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ContractActionBar } from '../ContractActionBar'
import type { ContractActionBarProps } from '../ContractActionBar'

function renderBar(props: Partial<ContractActionBarProps> = {}) {
  const defaults: ContractActionBarProps = {
    status: 'DRAFT',
    isDirty: false,
    isSaving: false,
    onSave: vi.fn(),
    onMarkReady: vi.fn(),
    onReset: vi.fn(),
    onRevert: vi.fn(),
    ...props,
  }
  return render(<ContractActionBar {...defaults} />)
}

describe('ContractActionBar', () => {
  it('DRAFT: shows Save, MarkReady, Reset — no Revert', () => {
    renderBar({ status: 'DRAFT' })
    expect(screen.getByTestId('contract-save-btn')).toBeInTheDocument()
    expect(screen.getByTestId('contract-mark-ready-btn')).toBeInTheDocument()
    expect(screen.getByTestId('contract-reset-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('contract-revert-btn')).not.toBeInTheDocument()
  })

  it('READY_TO_SIGN: shows only Revert — no Save/MarkReady/Reset', () => {
    renderBar({ status: 'READY_TO_SIGN' })
    expect(screen.queryByTestId('contract-save-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('contract-mark-ready-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('contract-reset-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('contract-revert-btn')).toBeInTheDocument()
  })

  it('SIGNED: shows only Revert (destructive)', () => {
    renderBar({ status: 'SIGNED' })
    expect(screen.queryByTestId('contract-save-btn')).not.toBeInTheDocument()
    const revertBtn = screen.getByTestId('contract-revert-btn')
    expect(revertBtn).toBeInTheDocument()
  })

  it('READY_TO_SIGN revert: shows soft confirm dialog before calling onRevert', () => {
    const onRevert = vi.fn()
    renderBar({ status: 'READY_TO_SIGN', onRevert })
    fireEvent.click(screen.getByTestId('contract-revert-btn'))
    // Confirm dialog must appear (soft variant)
    const dialog = screen.getByTestId('contract-revert-confirm-dialog')
    expect(dialog).toBeInTheDocument()
    // Soft text: no mention of "подпись"
    expect(dialog.textContent).toContain('Вернуть контракт в черновик?')
    expect(dialog.textContent).not.toContain('подписанный')
    // onRevert NOT called yet
    expect(onRevert).not.toHaveBeenCalled()
    // Confirm the action
    fireEvent.click(screen.getByTestId('contract-revert-confirm-ok'))
    expect(onRevert).toHaveBeenCalledOnce()
  })

  it('SIGNED revert: shows destructive confirm dialog before calling onRevert', () => {
    const onRevert = vi.fn()
    renderBar({ status: 'SIGNED', onRevert })
    fireEvent.click(screen.getByTestId('contract-revert-btn'))
    // Confirm dialog must appear (destructive variant)
    const dialog = screen.getByTestId('contract-revert-confirm-dialog')
    expect(dialog).toBeInTheDocument()
    // Destructive text
    expect(dialog.textContent).toContain('Вернуть подписанный контракт в черновик?')
    expect(dialog.textContent).toContain('необратимо')
    // onRevert NOT called yet
    expect(onRevert).not.toHaveBeenCalled()
    // Confirm the action
    fireEvent.click(screen.getByTestId('contract-revert-confirm-ok'))
    expect(onRevert).toHaveBeenCalledOnce()
  })

  it('DRAFT reset: shows confirm dialog before calling onReset', () => {
    const onReset = vi.fn()
    renderBar({ status: 'DRAFT', onReset })
    fireEvent.click(screen.getByTestId('contract-reset-btn'))
    // Reset confirm dialog must appear
    const dialog = screen.getByTestId('contract-reset-confirm-dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog.textContent).toContain('Сбросить контракт к шаблону?')
    // onReset NOT called yet
    expect(onReset).not.toHaveBeenCalled()
    // Confirm
    fireEvent.click(screen.getByTestId('contract-reset-confirm-ok'))
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('Save button disabled while dirty=false (no unsaved changes)', () => {
    renderBar({ status: 'DRAFT', isDirty: false })
    expect(screen.getByTestId('contract-save-btn')).toBeDisabled()
  })

  it('Save button enabled when dirty=true', () => {
    renderBar({ status: 'DRAFT', isDirty: true })
    expect(screen.getByTestId('contract-save-btn')).not.toBeDisabled()
  })
})
