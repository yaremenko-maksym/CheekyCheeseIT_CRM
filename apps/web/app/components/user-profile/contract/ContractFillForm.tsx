import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, User, Building2, Zap, Sliders } from 'lucide-react'
import type { ContractVariableInfo, ContractVariablesResponse } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { MissingFieldsBanner } from './MissingFieldsBanner'
import {
  useContractVariables,
  useMarkContractReady,
  useSaveContractCustomValues,
} from './useEmployeeContract'

// ─── Source icons / labels ─────────────────────────────────────────────────────

const SOURCE_ICON: Record<ContractVariableInfo['source'], React.ReactNode> = {
  user: <User className="h-3 w-3 text-blue-500" />,
  company: <Building2 className="h-3 w-3 text-purple-500" />,
  auto: <Zap className="h-3 w-3 text-emerald-500" />,
  custom: <Sliders className="h-3 w-3 text-amber-500" />,
  unknown: <Sliders className="h-3 w-3 text-muted-foreground" />,
}

const SOURCE_LABEL: Record<ContractVariableInfo['source'], string> = {
  user: 'Карточка сотрудника',
  company: 'Константы компании',
  auto: 'Авто',
  custom: 'Кастомная',
  unknown: 'Неизвестно',
}

// ─── AutoFilledRow ─────────────────────────────────────────────────────────────

function AutoFilledRow({ variable }: { variable: ContractVariableInfo }) {
  return (
    <div
      className="rounded-md px-2.5 py-2 hover:bg-muted/30 transition-colors"
      data-testid={`auto-var-row-${variable.key}`}
    >
      {/* Top row: token key + source badge + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <code className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
            {`{{${variable.key}}}`}
          </code>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
            {SOURCE_ICON[variable.source]}
            {SOURCE_LABEL[variable.source]}
          </span>
        </div>

        {variable.isEmpty ? (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-500/50 text-amber-600 dark:text-amber-400 text-[10px] h-5 px-1.5"
            data-testid={`auto-var-empty-${variable.key}`}
          >
            Не заполнено
          </Badge>
        ) : (
          <div
            className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0"
            data-testid={`auto-var-filled-${variable.key}`}
          >
            <CheckCircle2 className="h-3 w-3" />
            Заполнено
          </div>
        )}
      </div>

      {/* Resolved value — main information the admin needs to see */}
      {variable.isEmpty ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid={`auto-var-label-${variable.key}`}>
          {variable.label}
        </p>
      ) : (
        <div className="mt-0.5 space-y-0.5">
          <p
            className="break-words text-sm text-foreground"
            data-testid={`auto-var-value-${variable.key}`}
          >
            {variable.value}
          </p>
          <p className="text-[11px] text-muted-foreground">{variable.label}</p>
        </div>
      )}
    </div>
  )
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface ContractFillFormProps {
  userId: string
  /** Current saved customValues from employee_contracts row */
  savedCustomValues: Record<string, string>
  /** Called when PATCH custom-values + POST ready both succeed */
  onReady: () => void
}

// ─── ContractFillForm ──────────────────────────────────────────────────────────

export function ContractFillForm({ userId, savedCustomValues, onReady }: ContractFillFormProps) {
  const variablesQuery = useContractVariables(userId)
  const saveCustomMutation = useSaveContractCustomValues(userId)
  const markReadyMutation = useMarkContractReady(userId)

  // Local state for custom variable inputs — pre-populated from saved values.
  const [customInputs, setCustomInputs] = useState<Record<string, string>>(savedCustomValues)

  // Sync from server when query refreshes (after save/revert).
  useEffect(() => {
    setCustomInputs(savedCustomValues)
  }, [savedCustomValues])

  const data: ContractVariablesResponse | undefined = variablesQuery.data

  // Separate auto-filled vs custom/unknown variables.
  const autoVariables = useMemo(
    () => (data?.variables ?? []).filter((v) => v.source !== 'custom' && v.source !== 'unknown'),
    [data],
  )

  const customVariables = useMemo(
    () => (data?.variables ?? []).filter((v) => v.source === 'custom' || v.source === 'unknown'),
    [data],
  )

  // Resolve effective value for a custom variable: local input > saved > defaultValue > ''.
  const resolveCustomValue = useCallback(
    (key: string): string => {
      const local = customInputs[key]
      if (local !== undefined) return local
      const def = data?.customVariables.find((cv) => cv.key === key)
      return def?.defaultValue ?? ''
    },
    [customInputs, data],
  )

  // Determine which variables are still empty (block gate).
  const missingVariables: ContractVariableInfo[] = useMemo(() => {
    if (!data) return []
    return data.variables.filter((v) => {
      if (v.source === 'custom' || v.source === 'unknown') {
        const val = resolveCustomValue(v.key).trim()
        return !val
      }
      return v.isEmpty
    })
  }, [data, resolveCustomValue])

  const isBlocked = missingVariables.length > 0
  const isBusy = saveCustomMutation.isPending || markReadyMutation.isPending

  const handleSubmit = useCallback(async () => {
    if (isBlocked || isBusy) return

    // Build final custom values map.
    // Include ALL variable keys the user filled in:
    //   1. Known custom variables (registered in template customVariables).
    //   2. Unknown variables (tokens found in body but not registered) — the
    //      user may have typed values for them; discard them silently would
    //      lose data (bug #3 / review finding MED).
    const finalValues: Record<string, string> = {}

    // Pass 1: registered custom variables (with defaultValue support).
    for (const cv of data?.customVariables ?? []) {
      finalValues[cv.key] = resolveCustomValue(cv.key)
    }

    // Pass 2: unknown variables that the user explicitly filled in.
    for (const v of data?.variables ?? []) {
      if (v.source === 'unknown') {
        const val = resolveCustomValue(v.key).trim()
        if (val) finalValues[v.key] = val
      }
    }

    await saveCustomMutation.mutateAsync(finalValues)
    await markReadyMutation.mutateAsync(undefined)
    onReady()
  }, [isBlocked, isBusy, data, resolveCustomValue, saveCustomMutation, markReadyMutation, onReady])

  // ── Loading ──────────────────────────────────────────────────────────────────

  if (variablesQuery.isLoading) {
    return (
      <div className="space-y-2" data-testid="contract-fill-form-loading">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-9 w-36" />
      </div>
    )
  }

  if (variablesQuery.error || !data) {
    return (
      <p className="text-sm text-destructive" data-testid="contract-fill-form-error">
        Не удалось загрузить переменные контракта.
      </p>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4" data-testid="contract-fill-form">
      {/* Missing fields banner — client-side gate summary */}
      <MissingFieldsBanner missingVariables={missingVariables} userId={userId} />

      {/* Section: automatically filled variables */}
      {autoVariables.length > 0 && (
        <div>
          <p className="mb-1.5 px-1 text-xs font-semibold text-foreground">
            Автоматически заполнено
          </p>
          <div className="space-y-0.5 rounded-md border border-border/50 bg-muted/20 p-1">
            {autoVariables.map((v) => (
              <AutoFilledRow key={v.key} variable={v} />
            ))}
          </div>
        </div>
      )}

      {/* Section: custom variables that require manual input */}
      {customVariables.length > 0 && (
        <div>
          <p className="mb-1.5 px-1 text-xs font-semibold text-foreground">Требует заполнения</p>
          <div className="space-y-3 rounded-md border border-border/50 bg-muted/20 p-3">
            {customVariables.map((v) => {
              const val = resolveCustomValue(v.key)
              const isEmpty = !val.trim()
              return (
                <div key={v.key} className="space-y-1" data-testid={`custom-input-row-${v.key}`}>
                  <Label htmlFor={`cv-input-${v.key}`} className="flex items-center gap-2 text-xs">
                    <code className="rounded bg-amber-500/15 px-1 font-mono text-[11px] text-amber-700 dark:text-amber-300">
                      {`{{${v.key}}}`}
                    </code>
                    {v.label}
                    {isEmpty && (
                      <span className="text-[10px] font-normal text-amber-600 dark:text-amber-400">
                        обязательно
                      </span>
                    )}
                  </Label>
                  <Input
                    id={`cv-input-${v.key}`}
                    value={val}
                    onChange={(e) =>
                      setCustomInputs((prev) => ({ ...prev, [v.key]: e.target.value }))
                    }
                    placeholder={
                      data.customVariables.find((cv) => cv.key === v.key)?.defaultValue ??
                      `Введите ${v.label.toLowerCase()}`
                    }
                    className={
                      isEmpty
                        ? 'border-amber-500/60 focus-visible:ring-amber-500/30'
                        : 'border-emerald-500/40 focus-visible:ring-emerald-500/30'
                    }
                    data-testid={`cv-input-${v.key}`}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Submit button with gate */}
      <div className="flex items-center gap-3 pt-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrapper span needed so Tooltip works on disabled button */}
              <span
                className={isBlocked ? 'cursor-not-allowed' : undefined}
                data-testid="mark-ready-wrapper"
              >
                <Button
                  size="sm"
                  disabled={isBlocked || isBusy}
                  onClick={() => void handleSubmit()}
                  data-testid="contract-fill-submit-btn"
                >
                  {isBusy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Готов к подписанию
                </Button>
              </span>
            </TooltipTrigger>
            {isBlocked && (
              <TooltipContent side="top" className="max-w-xs text-xs">
                Заполните все обязательные поля
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>

        {!isBlocked && (
          <span
            className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
            data-testid="all-fields-ready-indicator"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Все поля заполнены
          </span>
        )}
      </div>
    </div>
  )
}
