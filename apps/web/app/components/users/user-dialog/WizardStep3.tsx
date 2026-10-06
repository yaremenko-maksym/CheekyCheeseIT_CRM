import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface WizardStep3Props {
  hasContract: boolean
  onSaveDraft: () => void
  onMarkReady: () => void
  isMarkingReady: boolean
  onBack: () => void
}

/**
 * Step 3 of the create wizard: confirmation summary + finalize buttons.
 * «Сохранить как черновик» → close (contract stays DRAFT, already saved).
 * «Сохранить и отметить готовым» → POST /ready → close.
 * Ready button disabled when no contract (no-template path).
 */
export function WizardStep3({
  hasContract,
  onSaveDraft,
  onMarkReady,
  isMarkingReady,
  onBack,
}: WizardStep3Props) {
  const { t } = useLingui()
  return (
    <div className="py-4 flex flex-col gap-6" data-testid="wizard-confirm-step">
      {/* Summary */}
      <div className="rounded-lg border border-border/60 bg-muted/30 p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
          <p className="text-sm font-medium">
            <Trans>Користувача створено</Trans>
          </p>
        </div>
        <p className="text-xs text-muted-foreground pl-7">
          {hasContract ? (
            <Trans>
              Контракт збережено як чернетку. Ви можете позначити його готовим до підписання.
            </Trans>
          ) : (
            <Trans>
              Контракт не створено (немає активного шаблону для ролі). Його можна додати пізніше
              через профіль користувача.
            </Trans>
          )}
        </p>
      </div>

      {/* Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" onClick={onBack} data-testid="wizard-step3-back-btn">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          <Trans>Назад</Trans>
        </Button>

        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="secondary" onClick={onSaveDraft} data-testid="wizard-save-draft-btn">
            <Trans>Зберегти чернетку</Trans>
          </Button>
          <Button
            onClick={onMarkReady}
            disabled={!hasContract || isMarkingReady}
            data-testid="wizard-mark-ready-btn"
            data-track="contract-sign-prep"
          >
            {isMarkingReady ? t`Позначаємо…` : t`Позначити готовим до підписання`}
          </Button>
        </div>
      </div>
    </div>
  )
}
