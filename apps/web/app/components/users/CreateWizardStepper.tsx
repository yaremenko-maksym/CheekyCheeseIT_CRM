import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CreateWizardStepperProps {
  current: 1 | 2 | 3
}

type StepState = 'done' | 'active' | 'upcoming'

const STEPS: { label: string }[] = [
  { label: 'Данные' },
  { label: 'Контракт' },
  { label: 'Подтверждение' },
]

function getStepState(stepIndex: number, current: number): StepState {
  if (stepIndex + 1 < current) return 'done'
  if (stepIndex + 1 === current) return 'active'
  return 'upcoming'
}

export function CreateWizardStepper({ current }: CreateWizardStepperProps) {
  return (
    <nav aria-label="Шаги создания пользователя" className="flex items-center gap-0 w-full mb-4">
      {STEPS.map((step, index) => {
        const state = getStepState(index, current)
        const stepNumber = index + 1
        const isLast = index === STEPS.length - 1

        return (
          <div key={step.label} className="flex items-center flex-1 min-w-0">
            {/* Step indicator */}
            <div
              data-testid={`wizard-step-${stepNumber}`}
              data-state={state}
              className="flex items-center gap-2 shrink-0"
            >
              {/* Circle */}
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors',
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

              {/* Label */}
              <span
                className={cn(
                  'text-xs font-medium whitespace-nowrap',
                  state === 'active' && 'text-primary',
                  state === 'done' && 'text-foreground',
                  state === 'upcoming' && 'text-muted-foreground',
                )}
              >
                {step.label}
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
