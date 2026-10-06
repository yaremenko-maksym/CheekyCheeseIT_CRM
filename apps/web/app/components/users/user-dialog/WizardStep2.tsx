import { Trans, useLingui } from '@lingui/react/macro'
import { FileText } from 'lucide-react'
import { useEffect } from 'react'
import { getApiErrorCode } from '@/lib/axios-utils'
import {
  useEmployeeContract,
  useSaveContractBody,
} from '@/components/user-profile/contract/useEmployeeContract'
import { ContractEditor } from '@/components/user-profile/contract/ContractEditor'
import { ContractActionBar } from '@/components/user-profile/contract/ContractActionBar'

interface WizardStep2Props {
  userId: string
  onHasContract: (has: boolean) => void
  body: string
  onBodyChange: (v: string) => void
  isDirty: boolean
}

/**
 * Step 2 of the create wizard: contract editor on the freshly-created user.
 * Lazy-loads the A3-2 ContractEditor + uses useEmployeeContract for DRAFT lazy-create.
 * Renders a skippable empty-state when no active template (404).
 */
// task-i18n-stage2-task5: exported (was module-private) so
// `UserDialog.test.tsx` can render it directly with a mocked
// `useEmployeeContract` — same pattern `ContractTab.test.tsx` already uses
// for its sibling `isNoTemplate` migration, without needing a full
// multi-provider `UserDialog` render.
export function WizardStep2({
  userId,
  onHasContract,
  body,
  onBodyChange,
  isDirty,
}: WizardStep2Props) {
  const { t } = useLingui()
  const { data: contract, isLoading, error } = useEmployeeContract(userId)
  const saveBody = useSaveContractBody(userId)

  // Sync contract body into local state on first load.
  // deps intentionally limited to contract?.id — we only want to seed the
  // local body once per contract identity (not on every render where body
  // or the stable callbacks change). Adding body/onBodyChange/onHasContract
  // would re-seed on every keystroke and clobber in-progress edits.
  // (react-hooks/exhaustive-deps is not configured in this project's eslint)
  useEffect(() => {
    if (contract && body === '') {
      onBodyChange(contract.bodyMarkdown ?? '')
      onHasContract(true)
    }
  }, [contract?.id])

  // Notify parent whether we have a contract
  useEffect(() => {
    if (contract) onHasContract(true)
    else if (error) onHasContract(false)
  }, [contract, error])

  const handleSave = () => {
    saveBody.mutate(body)
  }

  // No active template → 404 empty state (step is skippable).
  // task-i18n-stage2-task5: stable `code` from the envelope instead of
  // status-404-OR-substring-match — the substring half broke the moment the
  // prose it matched against became translatable (see ContractTab.tsx's
  // identical migration for the same reasoning).
  const isNoTemplate = getApiErrorCode(error) === 'CONTRACT_TEMPLATE_MISSING'

  return (
    <div className="py-2 flex flex-col gap-4" data-testid="wizard-contract-step">
      {isLoading && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Trans>Завантажуємо контракт…</Trans>
        </div>
      )}

      {isNoTemplate && !isLoading && (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-6 text-center">
          <FileText className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium text-muted-foreground">
            <Trans>Немає активного шаблону контракту для цієї ролі</Trans>
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            <Trans>Контракт можна додати пізніше з профілю користувача.</Trans>
            <br />
            <Trans>Натисніть «Далі», щоб продовжити без контракту.</Trans>
          </p>
        </div>
      )}

      {contract && !isLoading && (
        <>
          <ContractEditor
            value={body || contract.bodyMarkdown}
            onChange={onBodyChange}
            readOnly={contract.status !== 'DRAFT'}
            {...(contract.status === 'READY_TO_SIGN'
              ? {
                  frozenBanner: t`Контракт надіслано на підпис — редагування заблоковано, щоб внести правки, поверніть у чернетку`,
                }
              : {})}
          />
          <ContractActionBar
            status={contract.status}
            isDirty={isDirty}
            isSaving={saveBody.isPending}
            onSave={handleSave}
            onMarkReady={() => {
              /* handled in step 3 */
            }}
            onReset={() => {
              /* handled via profile tab */
            }}
            onRevert={() => {
              /* handled via profile tab */
            }}
          />
        </>
      )}
    </div>
  )
}
