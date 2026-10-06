import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { Trans, useLingui } from '@lingui/react/macro'
import { Coins, Landmark } from 'lucide-react'
import type { PaymentMethod } from '@crm/shared'
import { Input } from '@/components/ui/input'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { translateZodCode } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { type Role } from '../constants'
import { Field, Section } from '../section'
import { ibanPattern, rnokppPattern, usdtWalletPattern } from './validation'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface PaymentRequisitesSectionProps {
  form: Pick<AnyForm, 'Field' | 'Subscribe'>
}

/**
 * Payment requisites section of UserDialog (ut-14): USDT ERC-20 wallet vs Bank
 * UAH (FOP) method toggle and its fields. SECURITY-SENSITIVE (PII / finance).
 * Pure move out of UserDialog — method gating and validators unchanged. Payload
 * building stays in the parent `onSubmit`.
 */
export function PaymentRequisitesSection({ form }: PaymentRequisitesSectionProps) {
  const { t, i18n } = useLingui()
  return (
    <form.Subscribe selector={(s) => s.values.role}>
      {(role) => {
        const usdtOnly = role === 'SENIOR' || role === 'ADMIN'
        const roleLabel = i18n._(ROLE_LABEL_MESSAGES[role as Role])
        return (
          <Section title={t`Реквізити для виплат`}>
            {usdtOnly ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Для ролі «{roleLabel}» доступні лише виплати в USDT ERC-20.</Trans>
              </p>
            ) : (
              <form.Field name="paymentMethod">
                {(field) => (
                  <Field label={t`Спосіб виплати`} required>
                    {/* ut-15 + ut-24: iOS-style segmented control with a
                      sliding gold pill. Implemented via the shared
                      <SegmentedToggle> primitive (apps/web/app/components/ui/segmented-toggle.tsx)
                      so this design is consistent across the project. */}
                    <SegmentedToggle<PaymentMethod>
                      value={field.state.value}
                      onChange={(v) => field.handleChange(v)}
                      options={[
                        { value: 'USDT_ERC20', label: t`USDT ERC-20`, icon: Coins },
                        {
                          value: 'BANK_UAH_FOP',
                          label: t`ФОП (UAH)`,
                          icon: Landmark,
                        },
                      ]}
                      ariaLabel={t`Спосіб виплати`}
                      layoutId="payment-method-active-pill"
                      testId="user-dialog-payment-method"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {field.state.value === 'USDT_ERC20' ? (
                        <Trans>Використовуватиметься адреса гаманця в мережі Ethereum.</Trans>
                      ) : (
                        <Trans>Використовуватиметься український банківський рахунок ФОП.</Trans>
                      )}
                    </p>
                  </Field>
                )}
              </form.Field>
            )}

            <form.Subscribe selector={(s) => (usdtOnly ? 'USDT_ERC20' : s.values.paymentMethod)}>
              {(method) =>
                method === 'USDT_ERC20' ? (
                  <>
                    <form.Field
                      name="walletUsdtErc20"
                      validators={{
                        onBlur: ({ value, fieldApi }) => {
                          // Stryker disable next-line ConditionalExpression: equivalent — showError (isTouched && isDirty) hides any error produced for a pristine field, so skipping this early return is not observable
                          if (!fieldApi.state.meta.isDirty) return undefined
                          if (!value.trim()) return translateZodCode('USDT_WALLET_REQUIRED')
                          return usdtWalletPattern.test(value.trim())
                            ? undefined
                            : translateZodCode('USDT_ADDRESS_FORMAT')
                        },
                      }}
                    >
                      {(field) => {
                        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — the onBlur validator returns undefined unless the field is dirty and only runs on blur (touched), so `errors[0]` is already empty whenever either flag is false; the gate cannot be observed
                        const showError = field.state.meta.isTouched && field.state.meta.isDirty
                        const err = showError ? field.state.meta.errors[0] : undefined
                        return (
                          <Field label={t`Гаманець USDT (ERC-20)`} error={err} required>
                            <Input
                              placeholder="0x..."
                              value={field.state.value}
                              onChange={(e) => field.handleChange(e.target.value)}
                              onBlur={field.handleBlur}
                              autoComplete="off"
                              autoCapitalize="off"
                              autoCorrect="off"
                              spellCheck={false}
                              className={cn(
                                err && 'border-destructive focus-visible:ring-destructive/30',
                              )}
                              data-testid="user-dialog-wallet"
                            />
                          </Field>
                        )
                      }}
                    </form.Field>
                    <form.Field name="walletUsdtLabel">
                      {(field) => (
                        <Field label={t`Мітка гаманця (необов’язково)`}>
                          <Input
                            placeholder={t`наприклад: основний`}
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            onBlur={field.handleBlur}
                          />
                        </Field>
                      )}
                    </form.Field>
                  </>
                ) : (
                  <>
                    <form.Field
                      name="bankUahRecipient"
                      validators={{
                        onBlur: ({ value, fieldApi }) => {
                          if (!fieldApi.state.meta.isDirty) return undefined
                          return value.trim().length >= 3
                            ? undefined
                            : translateZodCode('RECIPIENT_NAME_MIN')
                        },
                      }}
                    >
                      {(field) => {
                        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — the onBlur validator returns undefined unless the field is dirty and only runs on blur (touched), so `errors[0]` is already empty whenever either flag is false; the gate cannot be observed
                        const showError = field.state.meta.isTouched && field.state.meta.isDirty
                        const err = showError ? field.state.meta.errors[0] : undefined
                        return (
                          <Field label={t`ПІБ отримувача (ФОП)`} error={err} required>
                            <Input
                              placeholder={t`Іваненко Іван Іванович`}
                              value={field.state.value}
                              onChange={(e) => field.handleChange(e.target.value)}
                              onBlur={field.handleBlur}
                              autoCapitalize="words"
                              autoComplete="off"
                              data-testid="user-dialog-bank-recipient"
                              className={cn(
                                err && 'border-destructive focus-visible:ring-destructive/30',
                              )}
                            />
                          </Field>
                        )
                      }}
                    </form.Field>
                    <form.Field
                      name="bankUahIban"
                      validators={{
                        onBlur: ({ value, fieldApi }) => {
                          if (!fieldApi.state.meta.isDirty) return undefined
                          return ibanPattern.test(value.trim())
                            ? undefined
                            : translateZodCode('IBAN_FORMAT')
                        },
                      }}
                    >
                      {(field) => {
                        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — the onBlur validator returns undefined unless the field is dirty and only runs on blur (touched), so `errors[0]` is already empty whenever either flag is false; the gate cannot be observed
                        const showError = field.state.meta.isTouched && field.state.meta.isDirty
                        const err = showError ? field.state.meta.errors[0] : undefined
                        return (
                          <Field label="IBAN" error={err} required>
                            <Input
                              placeholder="UA000000000000000000000000000"
                              value={field.state.value}
                              onChange={(e) => field.handleChange(e.target.value)}
                              onBlur={field.handleBlur}
                              autoCapitalize="characters"
                              autoCorrect="off"
                              spellCheck={false}
                              data-testid="user-dialog-bank-iban"
                              className={cn(
                                err && 'border-destructive focus-visible:ring-destructive/30',
                              )}
                            />
                          </Field>
                        )
                      }}
                    </form.Field>
                    <form.Field
                      name="bankUahRnokpp"
                      validators={{
                        onBlur: ({ value, fieldApi }) => {
                          if (!fieldApi.state.meta.isDirty) return undefined
                          return rnokppPattern.test(value.trim())
                            ? undefined
                            : translateZodCode('RNOKPP_FORMAT')
                        },
                      }}
                    >
                      {(field) => {
                        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — the onBlur validator returns undefined unless the field is dirty and only runs on blur (touched), so `errors[0]` is already empty whenever either flag is false; the gate cannot be observed
                        const showError = field.state.meta.isTouched && field.state.meta.isDirty
                        const err = showError ? field.state.meta.errors[0] : undefined
                        return (
                          <Field label={t`РНОКПП`} error={err} required>
                            <Input
                              placeholder="1234567890"
                              value={field.state.value}
                              onChange={(e) => field.handleChange(e.target.value)}
                              onBlur={field.handleBlur}
                              inputMode="numeric"
                              pattern="[0-9]*"
                              data-testid="user-dialog-bank-rnokpp"
                              className={cn(
                                err && 'border-destructive focus-visible:ring-destructive/30',
                              )}
                            />
                          </Field>
                        )
                      }}
                    </form.Field>
                    <form.Field name="bankUahBankName">
                      {(field) => (
                        <Field label={t`Банк (необов’язково)`}>
                          <Input
                            placeholder={t`ПриватБанк`}
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            onBlur={field.handleBlur}
                          />
                        </Field>
                      )}
                    </form.Field>
                  </>
                )
              }
            </form.Subscribe>
          </Section>
        )
      }}
    </form.Subscribe>
  )
}
