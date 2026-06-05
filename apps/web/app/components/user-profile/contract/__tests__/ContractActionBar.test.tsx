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

  it('SIGNED revert: shows confirm dialog before calling onRevert', () => {
    const onRevert = vi.fn()
    renderBar({ status: 'SIGNED', onRevert })
    fireEvent.click(screen.getByTestId('contract-revert-btn'))
    // Confirm dialog should appear
    expect(screen.getByTestId('contract-revert-confirm-dialog')).toBeInTheDocument()
    // Confirm the action
    fireEvent.click(screen.getByTestId('contract-revert-confirm-ok'))
    expect(onRevert).toHaveBeenCalledOnce()
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
