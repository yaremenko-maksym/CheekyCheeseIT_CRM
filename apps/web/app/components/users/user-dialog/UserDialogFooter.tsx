import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type { Role } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CrmDialogFooter } from '@/components/ui/crm-dialog'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { ROLE_VARIANT } from '../constants'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface UserDialogFooterProps {
  form: Pick<AnyForm, 'Subscribe' | 'handleSubmit'>
  isCreate: boolean
  currentStep: 1 | 2 | 3
  setCurrentStep: Dispatch<SetStateAction<1 | 2 | 3>>
  isPending: boolean
  submitLabel: string
  createPending: boolean
  onClose: () => void
}

/**
 * Footer of UserDialog: role badge + Cancel + wizard Next/Back/submit buttons.
 * Pure move out of UserDialog — behavior unchanged.
 */
export function UserDialogFooter({
  form,
  isCreate,
  currentStep,
  setCurrentStep,
  isPending,
  submitLabel,
  createPending,
  onClose,
}: UserDialogFooterProps) {
  const { t, i18n } = useLingui()
  return (
    <CrmDialogFooter className="items-center justify-between">
      <form.Subscribe selector={(s): Role => s.values.role}>
        {(role) => (
          <Badge variant={ROLE_VARIANT[role]} className="text-[11px]">
            {i18n._(ROLE_LABEL_MESSAGES[role])}
          </Badge>
        )}
      </form.Subscribe>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onClose}>
          <Trans>Скасувати</Trans>
        </Button>
        {/* Wizard step 1: «Далі» instead of «Створити» in create mode */}
        {isCreate && currentStep === 1 ? (
          <Button
            onClick={() => void form.handleSubmit()}
            disabled={isPending}
            data-testid="wizard-next-btn"
            data-track="user-create"
          >
            {createPending ? (
              t`Створюємо…`
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Trans>Далі</Trans>
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            )}
          </Button>
        ) : isCreate && currentStep === 2 ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setCurrentStep(1)}
              data-testid="wizard-back-btn"
            >
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              <Trans>Назад</Trans>
            </Button>
            <Button onClick={() => setCurrentStep(3)} data-testid="wizard-step2-next-btn">
              <span className="inline-flex items-center gap-1.5">
                <Trans>Далі</Trans>
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </Button>
          </div>
        ) : !isCreate ? (
          <Button
            onClick={() => void form.handleSubmit()}
            disabled={isPending}
            data-testid="user-dialog-submit"
          >
            {submitLabel}
          </Button>
        ) : null}
      </div>
    </CrmDialogFooter>
  )
}
