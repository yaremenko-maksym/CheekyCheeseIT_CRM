import { useCallback, useEffect, useState } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export type WizardStep = 1 | 2 | 3

type UseCreateWizardArgs = {
  isCreate: boolean
  open: boolean
  queryClient: QueryClient
  onClose: () => void
  /**
   * Success toast shown on "save as draft". Passed in (already translated by
   * the caller) so this hook stays free of catalog strings.
   */
  draftSavedMessage: string
}

/**
 * Create-wizard state (create mode only).
 *   currentStep: 1=Data, 2=Contract, 3=Confirm
 *   createdUserId: set after successful POST /api/users in step 1
 *   hasContract: set true when step 2 successfully loads a contract
 */
export function useCreateWizard({
  isCreate,
  open,
  queryClient,
  onClose,
  draftSavedMessage,
}: UseCreateWizardArgs) {
  const [currentStep, setCurrentStep] = useState<WizardStep>(1)
  const [createdUserId, setCreatedUserId] = useState<string | null>(null)
  const [hasContract, setHasContract] = useState<boolean>(false)
  const [wizardContractBody, setWizardContractBody] = useState<string>('')
  const [wizardContractDirty, setWizardContractDirty] = useState<boolean>(false)

  // Reset wizard state when dialog closes
  useEffect(() => {
    if (isCreate && !open) {
      setCurrentStep(1)
      setCreatedUserId(null)
      setHasContract(false)
      setWizardContractBody('')
      setWizardContractDirty(false)
    }
  }, [isCreate, open])

  // A3-3: wizard finalize — save as draft
  const handleWizardSaveDraft = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
    void queryClient.invalidateQueries({ queryKey: ['users'] })
    toast.success(draftSavedMessage, { duration: 4500 })
    setCurrentStep(1)
    setCreatedUserId(null)
    setHasContract(false)
    onClose()
  }, [queryClient, onClose, draftSavedMessage])

  return {
    currentStep,
    setCurrentStep,
    createdUserId,
    setCreatedUserId,
    hasContract,
    setHasContract,
    wizardContractBody,
    setWizardContractBody,
    wizardContractDirty,
    setWizardContractDirty,
    handleWizardSaveDraft,
  }
}
