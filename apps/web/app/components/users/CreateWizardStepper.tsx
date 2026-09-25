import { Check } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'

export interface CreateWizardStepperProps {
  current: 1 | 2 | 3
}

type StepState = 'done' | 'active' | 'upcoming'

const STEPS: { label: MessageDescriptor }[] = [
  { label: msg`Дані` },
  { label: msg`Контракт` },
  { label: msg`Підтвердження` },
]

function getStepState(stepIndex: number, current: number): StepState {
  if (stepIndex + 1 < current) return 'done'
  if (stepIndex + 1 === current) return 'active'
  return 'upcoming'
}

export function CreateWizardStepper({ current }: CreateWizardStepperProps) {
  const { t, i18n } = useLingui()
  return (
    <nav
      aria-label={t`Кроки створення користувача`}
      className="flex items-center gap-0 w-full mb-4"
    >
      {STEPS.map((step, index) => {
        const state = getStepState(index, current)
        const stepNumber = index + 1
        const isLast = index === STEPS.length - 1

        return (
          <div key={stepNumber} className="flex items-center flex-1 min-w-0">
            {/* Step indicator */}
            <div
              data-testid={`wizard-step-${stepNumber}`}
              data-state={state}
              className="flex items-center gap-2 min-w-0"
            >
              {/* Circle — shrink-0 so it stays a circle once the parent gives
                  up its own shrink-0 (UX-LOW-1: at 320px the uk label
                  "Підтвердження" no longer fits nowrap without clipping past
                  the dialog edge — the fix is letting the LABEL wrap, not
                  letting this icon deform). */}
              <div
                data-testid={`wizard-step-${stepNumber}-circle`}
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors',
                  state === 'done' && 'border-primary bg-primary text-primary-foreground',
                  state === 'active' &&
                    'border-primary bg-background text-primary ring-2 ring-primary/20',
                  state === 'upcoming' && 'border-border bg-muted text-muted-foreground',
                )}
              >
                {state === 'done' ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                ) : (
                  <span>{stepNumber}</span>
                )}
              </div>

              {/* Label — wraps at the narrowest widths instead of
                  overflowing past the dialog edge (nowrap from `sm` up,
                  where every locale's label fits on one line). `break-words`
                  matters here specifically for uk: "Підтвердження" is ONE
                  word with no space to wrap on, so whitespace-normal alone
                  cannot break it — only overflow-wrap can. */}
              <span
                className={cn(
                  'min-w-0 text-xs font-medium whitespace-normal break-words sm:whitespace-nowrap',
                  state === 'active' && 'text-primary',
                  state === 'done' && 'text-foreground',
                  state === 'upcoming' && 'text-muted-foreground',
                )}
              >
                {i18n._(step.label)}
              </span>
            </div>

            {/* Connector line between steps */}
            {!isLast && (
              <div
                className={cn(
                  'mx-2 h-[2px] flex-1 rounded transition-colors',
                  state === 'done' ? 'bg-primary' : 'bg-border',
                )}
                aria-hidden="true"
              />
            )}
          </div>
        )
      })}
    </nav>
  )
}
