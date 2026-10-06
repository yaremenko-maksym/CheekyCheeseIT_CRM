import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { useLingui } from '@lingui/react/macro'
import { z } from 'zod'
import { Input } from '@/components/ui/input'
import { translateZodCode, translateZodMessage } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { Field, Section } from '../section'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface ContractDataSectionProps {
  form: Pick<AnyForm, 'Field' | 'Subscribe'>
  isCreate: boolean
}

/**
 * Contract data section of UserDialog (non-ADMIN only): legalFullName +
 * registrationAddress form fields. Pure move out of UserDialog — behavior and
 * validators unchanged.
 */
export function ContractDataSection({ form, isCreate }: ContractDataSectionProps) {
  const { t } = useLingui()
  return (
    <form.Subscribe selector={(s) => s.values.role}>
      {(role) =>
        role !== 'ADMIN' ? (
          <Section title={t`Дані для контракту`}>
            <form.Field
              name="legalFullName"
              validators={{
                onBlur: ({ value, fieldApi }) => {
                  if (!fieldApi.state.meta.isDirty) return undefined
                  if (!value.trim()) return undefined
                  const r = z
                    .string()
                    .min(5, 'zod.LEGAL_FULL_NAME_MIN')
                    .max(200)
                    .safeParse(value.trim())
                  if (r.success) return undefined
                  // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
                  return translateZodMessage(r.error.issues[0]?.message)
                },
                // A3-3 AC6 / bug #2: surface superRefine error on submit attempt
                // for contract-eligible roles (SENIOR/HR/JUNIOR/ACCOUNTANT/DROP).
                // This fires when form.handleSubmit() is called and makes the
                // red border + error text visible without requiring blur first.
                onSubmit: ({ value }) => {
                  const CONTRACT_ROLES = new Set(['SENIOR', 'HR', 'JUNIOR', 'ACCOUNTANT', 'DROP'])
                  if (isCreate && CONTRACT_ROLES.has(role) && !value.trim()) {
                    return translateZodCode('LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT')
                  }
                  return undefined
                },
              }}
            >
              {(field) => {
                // Show inline error in two cases:
                // 1. onBlur validator fired (field was touched + dirty)
                // 2. onSubmit validator fired (user clicked «Далее» without
                //    filling legalFullName for a contract-eligible role).
                //    TanStack Form populates errorMap.onSubmit after handleSubmit.
                const blurErr =
                  // Stryker disable next-line ConditionalExpression,LogicalOperator: unobservable — the only onBlur validator bails on !isDirty and runs only on blur (isTouched), so `errorMap.onBlur` can exist only when the field is both touched and dirty; the gate cannot change what is rendered
                  field.state.meta.isTouched && field.state.meta.isDirty
                    ? (field.state.meta.errorMap.onBlur as string | undefined)
                    : undefined
                const submitErr = field.state.meta.errorMap.onSubmit as string | undefined
                const err = submitErr ?? blurErr
                const showError = !!err
                return (
                  <Field
                    label={t`Юридичне ПІБ`}
                    error={showError ? err : undefined}
                    hint={t`Використовується в MSA-контракті замість імені та прізвища. Формат: Прізвище Ім’я По батькові.`}
                  >
                    <Input
                      placeholder={t`Іваненко Іван Іванович`}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      aria-invalid={showError ? true : undefined}
                      autoCapitalize="words"
                      autoComplete="off"
                      className={cn(
                        showError && 'border-destructive focus-visible:ring-destructive/30',
                      )}
                      data-testid="user-dialog-legal-full-name"
                    />
                  </Field>
                )
              }}
            </form.Field>

            {/* ── Адреса реєстрації (ФОП) ──────────────────────── */}
            <form.Field name="registrationAddress">
              {(field) => (
                <Field
                  label={t`Адреса реєстрації (ФОП)`}
                  hint={t`Ця адреса підставляється в текст контракту`}
                >
                  <Input
                    placeholder={t`м. Київ, вул. Хрещатик, 1`}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    data-testid="user-dialog-registration-address"
                  />
                </Field>
              )}
            </form.Field>
          </Section>
        ) : null
      }
    </form.Subscribe>
  )
}
