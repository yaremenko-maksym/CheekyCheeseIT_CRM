/**
 * VacancySalaryFields — task-vacancy-salary-range (owner decision 2026-07-31:
 * Google Search Console flagged every vacancy's structured data as missing
 * `baseSalary` and was substituting its own market estimate — a public
 * salary range is now MANDATORY on every vacancy). Unlike `VacancySeoFields`
 * (optional Google-for-Jobs enrichment), these 4 fields are REQUIRED by
 * `createVacancySchema` and by `VacanciesService` before a vacancy can be
 * published — a legacy vacancy without a range (3 already PUBLISHED on prod
 * before this change) simply shows this section blank until the owner fills
 * it in here.
 *
 * Deliberately NOT built on top of `AmountCurrencyInput`
 * (`@/components/ui/amount-currency-input`) — that component fetches a live
 * NBU exchange rate for a FINANCE amount (an unrelated side effect for a
 * public job-posting salary range) and only handles ONE amount+currency
 * pair, not a min/max range sharing one currency/period. `CURRENCIES`
 * there happens to list the same 4 codes, but this form is driven by the
 * vacancies domain's OWN `VacancySalaryCurrency` enum (`@crm/shared`) —
 * the actual source of truth for what `createVacancySchema` accepts.
 *
 * Shared by `VacancySheet` (create/edit) and `$vacancyId.tsx` (inline edit) —
 * same pattern as `VacancySeoFields`.
 */
import { VACANCY_SALARY_CURRENCIES, VACANCY_SALARY_PERIODS } from '@crm/shared'
import { cn, normalizeDecimalInput } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SALARY_PERIOD_LABELS } from '../constants'
import type { AnyField, AnyForm } from './VacancyFormFields'

export interface VacancySalaryFieldsProps {
  form: AnyForm
}

/**
 * Deliberately does NOT flag an empty value as an error here — unlike title/
 * slug/descriptionMd (which structurally can never have been empty on an
 * EXISTING vacancy, since they were already required before this task), a
 * legacy vacancy's salary can be genuinely `null` on edit (AC3), and TanStack
 * Form evaluates every field's validator at submit-time regardless of
 * whether that specific field was touched — an unconditional "required" rule
 * here would block saving an UNRELATED field edit on a legacy vacancy that
 * hasn't had its salary filled in yet (empirically confirmed: this was a
 * real bug, caught by VacancySheet.test.tsx's edit-mode PATCH tests before
 * this comment was added). The CREATE-mode "must be filled in" requirement
 * is enforced by `createVacancySchema` itself (`validators.onSubmit` below +
 * the fallback toast in `onSubmitInvalid`) — this validator only catches an
 * invalid (non-positive) value once something has actually been typed.
 */
function validateAmount(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0) return 'Введите положительное число'
  return undefined
}

export function VacancySalaryFields({ form }: VacancySalaryFieldsProps) {
  return (
    <div className="space-y-3">
      <Label>Вилка зарплаты</Label>
      <p className="text-xs text-muted-foreground">
        Обязательна для всех вакансий — используется в разметке для Google.
      </p>

      <div className="grid grid-cols-2 gap-[14px]">
        <form.Field
          name="salaryMin"
          validators={{ onBlur: ({ value }: { value: string }) => validateAmount(value) }}
        >
          {(field: AnyField) => {
            const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
            return (
              <div className="space-y-1.5">
                <Label className={cn('text-xs', err && 'text-destructive')}>Минимум</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={field.state.value ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.handleChange(normalizeDecimalInput(e.target.value))
                  }
                  onBlur={field.handleBlur}
                  placeholder="3000"
                  data-testid="vacancy-form-salary-min"
                  className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                />
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            )
          }}
        </form.Field>

        <form.Field
          name="salaryMax"
          validators={{
            onBlur: ({ value }: { value: string }) => {
              const baseErr = validateAmount(value)
              if (baseErr) return baseErr
              if (value.trim() === '') return undefined
              // Cross-field check via the outer `form` closure (same pattern
              // as VacancyFormFields' title -> slug auto-link) — no schema-
              // level refine here, see createVacancySalaryFieldsSchema's doc
              // in packages/shared for why (breaks .partial()).
              const minRaw = String(form.state.values.salaryMin ?? '').trim()
              const min = minRaw === '' ? null : Number(minRaw)
              const max = Number(value)
              if (min !== null && Number.isFinite(min) && max < min) {
                return 'Максимум не может быть меньше минимума'
              }
              return undefined
            },
          }}
        >
          {(field: AnyField) => {
            const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
            return (
              <div className="space-y-1.5">
                <Label className={cn('text-xs', err && 'text-destructive')}>Максимум</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={field.state.value ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.handleChange(normalizeDecimalInput(e.target.value))
                  }
                  onBlur={field.handleBlur}
                  placeholder="5000"
                  data-testid="vacancy-form-salary-max"
                  className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                />
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            )
          }}
        </form.Field>
      </div>

      <div className="grid grid-cols-2 gap-[14px]">
        <form.Field name="salaryCurrency">
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label className="text-xs">Валюта</Label>
              <Select value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
                <SelectTrigger data-testid="vacancy-form-salary-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VACANCY_SALARY_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </form.Field>

        <form.Field name="salaryPeriod">
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label className="text-xs">Период</Label>
              <Select value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
                <SelectTrigger data-testid="vacancy-form-salary-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VACANCY_SALARY_PERIODS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {SALARY_PERIOD_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </form.Field>
      </div>
    </div>
  )
}
