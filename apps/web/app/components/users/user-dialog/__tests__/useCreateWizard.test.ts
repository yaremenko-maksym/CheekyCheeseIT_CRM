import { act, renderHook } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))

import { useCreateWizard } from '../useCreateWizard'

function setup(initial: { isCreate: boolean; open: boolean }) {
  const invalidateQueries = vi.fn()
  const onClose = vi.fn()
  const queryClient = { invalidateQueries } as unknown as QueryClient
  const hook = renderHook(
    (p: { isCreate: boolean; open: boolean }) =>
      useCreateWizard({ ...p, queryClient, onClose, draftSavedMessage: 'draft saved' }),
    { initialProps: initial },
  )
  return { ...hook, invalidateQueries, onClose }
}

function fillWizard(result: ReturnType<typeof setup>['result']) {
  act(() => {
    result.current.setCurrentStep(3)
    result.current.setCreatedUserId('u-1')
    result.current.setHasContract(true)
    result.current.setWizardContractBody('body')
    result.current.setWizardContractDirty(true)
  })
}

describe('useCreateWizard', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
  })

  it('starts at step 1 with empty state', () => {
    const { result } = setup({ isCreate: true, open: true })
    expect(result.current.currentStep).toBe(1)
    expect(result.current.createdUserId).toBeNull()
    expect(result.current.hasContract).toBe(false)
    expect(result.current.wizardContractBody).toBe('')
    expect(result.current.wizardContractDirty).toBe(false)
  })

  it('advances and goes back between steps', () => {
    const { result } = setup({ isCreate: true, open: true })
    act(() => result.current.setCurrentStep(2))
    expect(result.current.currentStep).toBe(2)
    act(() => result.current.setCurrentStep(3))
    expect(result.current.currentStep).toBe(3)
    act(() => result.current.setCurrentStep(1))
    expect(result.current.currentStep).toBe(1)
  })

  it('stores createdUserId, hasContract, contract body and dirty flag', () => {
    const { result } = setup({ isCreate: true, open: true })
    fillWizard(result)
    expect(result.current.createdUserId).toBe('u-1')
    expect(result.current.hasContract).toBe(true)
    expect(result.current.wizardContractBody).toBe('body')
    expect(result.current.wizardContractDirty).toBe(true)
  })

  it('resets all wizard state when a create dialog closes', () => {
    const { result, rerender } = setup({ isCreate: true, open: true })
    fillWizard(result)
    rerender({ isCreate: true, open: false })
    expect(result.current.currentStep).toBe(1)
    expect(result.current.createdUserId).toBeNull()
    expect(result.current.hasContract).toBe(false)
    expect(result.current.wizardContractBody).toBe('')
    expect(result.current.wizardContractDirty).toBe(false)
  })

  it('does not reset while a create dialog stays open', () => {
    const { result, rerender } = setup({ isCreate: true, open: true })
    fillWizard(result)
    rerender({ isCreate: true, open: true })
    expect(result.current.currentStep).toBe(3)
    expect(result.current.createdUserId).toBe('u-1')
  })

  it('does not reset in edit mode even when closed', () => {
    const { result, rerender } = setup({ isCreate: false, open: true })
    fillWizard(result)
    rerender({ isCreate: false, open: false })
    expect(result.current.currentStep).toBe(3)
    expect(result.current.createdUserId).toBe('u-1')
    expect(result.current.hasContract).toBe(true)
    expect(result.current.wizardContractBody).toBe('body')
    expect(result.current.wizardContractDirty).toBe(true)
  })

  it('save-draft invalidates users queries, toasts, resets step/user/contract and closes', () => {
    const { result, invalidateQueries, onClose } = setup({ isCreate: true, open: true })
    fillWizard(result)
    act(() => result.current.handleWizardSaveDraft())
    expect(invalidateQueries).toHaveBeenCalledTimes(2)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['users-admin'] })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['users'] })
    expect(toastSuccess).toHaveBeenCalledWith('draft saved', { duration: 4500 })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(result.current.currentStep).toBe(1)
    expect(result.current.createdUserId).toBeNull()
    expect(result.current.hasContract).toBe(false)
    // body/dirty are intentionally untouched by save-draft (original behavior)
    expect(result.current.wizardContractBody).toBe('body')
    expect(result.current.wizardContractDirty).toBe(true)
  })
})
