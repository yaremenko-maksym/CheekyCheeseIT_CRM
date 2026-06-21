import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { z } from 'zod'
import { CheckCircle2, FileText, ScrollText } from 'lucide-react'
import type { OnboardingStatusDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { SignContractStep } from '@/components/onboarding/SignContractStep'
import { ContractWaitScreen } from '@/components/onboarding/ContractWaitScreen'
import { AcceptTosStep } from '@/components/onboarding/AcceptTosStep'

// Search params schema — ?step=contract|tos
const onboardingSearchSchema = z.object({
  step: z.enum(['contract', 'tos']).optional(),
})

export const Route = createFileRoute('/_authenticated/onboarding/')({
  validateSearch: onboardingSearchSchema,
  component: OnboardingPage,
})

type OnboardingStep = 'contract' | 'tos' | 'done'

function OnboardingPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ from: '/_authenticated/onboarding/' })

  const { data: status } = useQuery<OnboardingStatusDto>({
    queryKey: ['onboarding-status'],
    queryFn: async () => {
      const res = await api.get<OnboardingStatusDto>('/onboarding/status')
      return res.data
    },
    enabled: !!user,
    staleTime: 0,
    // A3-4: poll every 15s ONLY while waiting for ADMIN to mark the contract
    // ready (requiresContract=true AND contractReady=false → ContractWaitScreen).
    // No polling needed once the user can sign (contractReady=true) or after
    // onboarding completes (requiresContract=false) — avoids unnecessary traffic
    // during sign/done states (code-review MED-2).
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.requiresContract === true && data?.contractReady !== true ? 15_000 : false
    },
  })

  // Determine initial step from status or URL param
  const [step, setStep] = useState<OnboardingStep>(() => {
    if (search.step === 'tos') return 'tos'
    return 'contract'
  })

  // Sync step from server status on load
  useEffect(() => {
    if (!status) return
    if (search.step === 'tos') {
      setStep('tos')
      return
    }
    if (!status.requiresContract && status.requiresTos) {
      setStep('tos')
    } else if (status.requiresContract) {
      setStep('contract')
    }
  }, [status, search.step])

  // Navigate to dashboard (/) when done
  useEffect(() => {
    if (step === 'done') {
      void navigate({ to: '/' })
    }
  }, [step, navigate])

  const handleContractSuccess = () => {
    setStep('tos')
  }

  const handleTosSuccess = () => {
    setStep('done')
  }

  // Progress indicator data
  const steps: Array<{ id: OnboardingStep; label: string; icon: React.ReactNode }> = [
    { id: 'contract', label: 'Подписать контракт', icon: <FileText className="h-4 w-4" /> },
    { id: 'tos', label: 'Условия использования', icon: <ScrollText className="h-4 w-4" /> },
  ]

  const currentStepIndex = steps.findIndex((s) => s.id === step)

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="onboarding-title">
          Добро пожаловать в CRM
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Для начала работы необходимо выполнить несколько шагов
        </p>
      </div>

      {/* Progress steps */}
      <div className="flex items-center gap-2" data-testid="onboarding-progress">
        {steps.map((s, idx) => {
          const isDone = currentStepIndex > idx || step === 'done'
          const isCurrent = s.id === step
          return (
            <div key={s.id} className="flex flex-1 flex-col items-center gap-1.5">
              <div
                className={[
                  'flex h-9 w-9 items-center justify-center rounded-full border-2 transition-colors',
                  isDone
                    ? 'border-primary bg-primary text-primary-foreground'
                    : isCurrent
                      ? 'border-primary bg-background text-primary'
                      : 'border-muted-foreground/30 bg-background text-muted-foreground',
                ].join(' ')}
              >
                {isDone ? <CheckCircle2 className="h-4 w-4" /> : s.icon}
              </div>
              <span
                className={[
                  'text-xs',
                  isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground',
                ].join(' ')}
              >
                {s.label}
              </span>
              {/* Connector line */}
              {idx < steps.length - 1 && (
                <div
                  className={[
                    'absolute left-1/2 top-4 hidden h-0.5 w-full translate-x-1/2',
                    isDone ? 'bg-primary' : 'bg-muted-foreground/20',
                  ].join(' ')}
                />
              )}
            </div>
          )
        })}
      </div>

      <div className="text-xs text-muted-foreground" data-testid="onboarding-step-indicator">
        Шаг {Math.min(currentStepIndex + 1, steps.length)} из {steps.length}
      </div>

      {/* Divider */}
      <hr className="border-border" />

      {/* Step content with fade animation */}
      <AnimatePresence mode="wait">
        {step === 'contract' && (
          <motion.div
            key="contract"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            data-testid="onboarding-step-contract"
          >
            <h2 className="mb-4 text-lg font-semibold">Подписание контракта</h2>
            {/* A3-4 three-state: wait if DRAFT, sign if READY_TO_SIGN */}
            {status?.contractReady ? (
              <SignContractStep onSuccess={handleContractSuccess} />
            ) : (
              <ContractWaitScreen />
            )}
          </motion.div>
        )}

        {step === 'tos' && (
          <motion.div
            key="tos"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            data-testid="onboarding-step-tos"
          >
            <h2 className="mb-4 text-lg font-semibold">Условия использования</h2>
            <AcceptTosStep onSuccess={handleTosSuccess} />
          </motion.div>
        )}

        {step === 'done' && (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25 }}
            className="flex flex-col items-center gap-4 py-8"
            data-testid="onboarding-step-done"
          >
            <CheckCircle2 className="h-14 w-14 text-primary" />
            <p className="text-center text-lg font-medium">Онбординг завершён!</p>
            <p className="text-center text-sm text-muted-foreground">
              Перенаправление на дашборд...
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
