import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { useLingui } from '@lingui/react/macro'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { translateZodCode, translateZodMessage } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { Field, Section } from '../section'
import { phoneFieldSchema, telegramFieldSchema } from './validation'

// TanStack Form render props require many generics — same suppression as
// ProjectEditFields (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface ContactsSectionProps {
  form: Pick<AnyForm, 'Field'>
}

/**
 * Contacts section of UserDialog: telegram + phone form fields.
 * Pure move out of UserDialog — behavior and validators unchanged.
 */
export function ContactsSection({ form }: ContactsSectionProps) {
  const { t } = useLingui()
  return (
    <Section title={t`Контакти`}>
      <form.Field
        name="telegram"
        validators={{
          onBlur: ({ value, fieldApi }) => {
            if (!fieldApi.state.meta.isDirty) return undefined
            if (!value.trim()) return undefined
            const r = telegramFieldSchema.safeParse(value.trim())
            // Stryker disable next-line OptionalChaining: a failed safeParse always carries at least one issue, so `issues[0]` is never undefined here; the `?` is a type-level guard for noUncheckedIndexedAccess
            return r.success ? undefined : translateZodMessage(r.error.issues[0]?.message)
          },
        }}
      >
        {(field) => {
          // Stryker disable next-line ConditionalExpression,LogicalOperator: unobservable — the only validators are onBlur, so `errors[0]` can exist only after a blur (isTouched) and the validator itself bails on !isDirty; the gate cannot change what is rendered
          const showError = field.state.meta.isTouched && field.state.meta.isDirty
          const err = showError ? field.state.meta.errors[0] : undefined
          return (
            <Field label="Telegram" error={err}>
              <Input
                placeholder="@username"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                autoCapitalize="off"
                autoCorrect="off"
                className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
              />
            </Field>
          )
        }}
      </form.Field>

      <form.Field
        name="phone"
        validators={{
          onBlur: ({ value, fieldApi }) => {
            if (!fieldApi.state.meta.isDirty) return undefined
            const v = value as string
            if (!v || v.replace(/\D/g, '').length < 5) return undefined
            const r = phoneFieldSchema.safeParse(v)
            // Stryker disable next-line ConditionalExpression,OptionalChaining: the schema branch (`z.string().max(30)`) is unreachable through the UI — PhoneInput caps the typed length, so safeParse never fails for a value the component can produce
            if (!r.success) return translateZodMessage(r.error.issues[0]?.message)
            if (!isValidPhoneNumber(v)) return translateZodCode('PHONE_INVALID')
            return undefined
          },
        }}
      >
        {(field) => {
          // Stryker disable next-line ConditionalExpression,LogicalOperator: unobservable — the only validators are onBlur, so `errors[0]` can exist only after a blur (isTouched) and the validator itself bails on !isDirty; the gate cannot change what is rendered
          const showError = field.state.meta.isTouched && field.state.meta.isDirty
          const err = showError ? field.state.meta.errors[0] : undefined
          return (
            <Field label={t`Телефон`} error={err}>
              <PhoneInput
                value={field.state.value as PhoneValue | undefined}
                onChange={(v) => field.handleChange((v ?? '') as PhoneValue | '')}
                onBlur={field.handleBlur}
                // Stryker disable next-line ConditionalExpression,StringLiteral,LogicalOperator: cosmetic error-border class on the phone wrapper; the error text and validity are asserted, the Tailwind class string is not observable in jsdom
                className={cn(err && '[&_input]:border-destructive')}
              />
            </Field>
          )
        }}
      </form.Field>
    </Section>
  )
}
