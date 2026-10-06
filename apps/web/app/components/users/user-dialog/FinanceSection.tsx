import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { Trans, useLingui } from '@lingui/react/macro'
import { Percent } from 'lucide-react'
import type { UserProfileDto } from '@crm/shared'
import { PendingShareEditNotice } from '@/components/pending-share/cancel-pending-share'
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'
import { ShareSlider } from '@/components/ui/share-slider'
import { translateZodCode } from '@/lib/axios-utils'
import { Field, Section } from '../section'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface FinanceSectionProps {
  form: Pick<AnyForm, 'Field' | 'Subscribe'>
  isCreate: boolean
  editingUser: Pick<UserProfileDto, 'id' | 'pendingSeniorShare'> | null
}

/**
 * Finance section of UserDialog: SENIOR share slider (+ pending-share notice),
 * DROP share slider, or non-SENIOR/non-DROP monthly salary + currency. Pure move
 * out of UserDialog — role gating, defaults and validators unchanged. Payload
 * building stays in the parent `onSubmit`.
 */
export function FinanceSection({ form, isCreate, editingUser }: FinanceSectionProps) {
  const { t } = useLingui()
  return (
    <form.Subscribe selector={(s) => s.values.role}>
      {(role) => (
        <Section title={t`Фінанси`}>
          {role === 'SENIOR' ? (
            <form.Field
              name="seniorSharePercent"
              validators={{
                onBlur: ({ value }) => {
                  if (value < 1 || value > 100) return translateZodCode('SHARE_PERCENT_RANGE_1_100')
                  return undefined
                },
              }}
            >
              {(field) => {
                const val = field.state.value ?? 26
                const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                return (
                  <Field label={t`Частка сеньйора (%)`} error={err} required={isCreate}>
                    <ShareSlider
                      value={val}
                      onChange={(v) => field.handleChange(v)}
                      onBlur={field.handleBlur}
                      error={!!err}
                    />
                    {/* task-648-fix-round-2 (COPY-H-6): the form
                        where the change starts says the change does
                        not take effect on save. */}
                    {/* task-648-fix-round-3 (COPY-L-11): rendered
                        HERE, as a plain paragraph, instead of
                        through `Field`'s `hint` prop. `Field` puts
                        its hint AFTER children, so this dialog read
                        slider → notice → hint while the project
                        dialog read slider → hint → notice: the same
                        two blocks in opposite orders, two dialogs
                        apart, for one feature. */}
                    <p className="text-xs text-muted-foreground">
                      <Trans>
                        Те, що сеньйор залишає собі. Нове значення набуде чинності після
                        підтвердження сеньйора.
                      </Trans>
                    </p>
                    {/* task-648-fix-round-2 (UX-H-3(r2)): an ADMIN
                        who opens this dialog to "fix" the percent
                        saw a slider holding the ACTIVE value and
                        nothing about a proposal already awaiting an
                        answer — so the natural gesture silently
                        superseded it. */}
                    {/* `editingUser` is null in create mode
                        (see its own `useMemo`), so an extra
                        `!isCreate` guard here would be unreachable
                        by construction. */}
                    {editingUser?.pendingSeniorShare && (
                      <PendingShareEditNotice
                        scope="user"
                        id={editingUser.id}
                        /* task-648-fix-round-3 (COPY-L-13): the
                           `?? 0` that COPY-H-2 removed in round 1
                           had crept back here. It is the exact bug
                           that finding was about: a `null` percent
                           is "clear the override", NOT "zero", and
                           rendering «Предложено 0%» tells the
                           admin a number the server never said.
                           The resolved field is what both halves
                           read now. */
                        pendingPercent={
                          editingUser.pendingSeniorShare.percent === null
                            ? editingUser.pendingSeniorShare.effectivePercentAfterApproval
                            : editingUser.pendingSeniorShare.percent
                        }
                        approverName={editingUser.pendingSeniorShare.approverName}
                      />
                    )}
                  </Field>
                )
              }}
            </form.Field>
          ) : role === 'DROP' ? (
            <form.Field
              name="dropSharePercent"
              validators={{
                onBlur: ({ value }) => {
                  if (value < 0 || value > 100) return translateZodCode('SHARE_PERCENT_RANGE_0_100')
                  return undefined
                },
              }}
            >
              {(field) => {
                const val = field.state.value ?? 5
                const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                return (
                  <Field
                    label={t`Частка дропа (%)`}
                    hint={t`Скільки дроп залишає собі з кожної виплати`}
                    error={err}
                    required={isCreate}
                  >
                    <ShareSlider
                      value={val}
                      onChange={(v) => field.handleChange(v)}
                      onBlur={field.handleBlur}
                      error={!!err}
                      min={0}
                      role="DROP"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
                      <Percent className="h-3 w-3" />
                      <Trans>За замовчуванням 5%</Trans>
                    </p>
                  </Field>
                )
              }}
            </form.Field>
          ) : (
            <form.Field name="monthlySalary">
              {(field) => (
                <form.Field name="salaryCurrency">
                  {(curField) => (
                    <Field label={t`Місячна зарплата`}>
                      <AmountCurrencyInput
                        amount={String(field.state.value ?? '')}
                        currency={curField.state.value}
                        onAmountChange={field.handleChange}
                        onCurrencyChange={curField.handleChange}
                        label={t`Сума`}
                        currencyLabel={t`Валюта`}
                        placeholder="0"
                      />
                    </Field>
                  )}
                </form.Field>
              )}
            </form.Field>
          )}
        </Section>
      )}
    </form.Subscribe>
  )
}
