import type { FieldApi, ReactFormExtendedApi } from '@tanstack/react-form'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ProjectDetailDto } from '@crm/shared'
import { createProjectSchema, IT_DOMAINS } from '@crm/shared'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import { cn } from '@/lib/utils'
import { useRoleLabel } from '@/components/ui/role-select'
import { PendingShareEditNotice } from '@/components/pending-share/cancel-pending-share'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ImageUploadField } from '@/components/ui/image-upload-field'
import { ShareSlider } from '@/components/ui/share-slider'
import { EDIT_FIELD_LABEL_MESSAGES, PAYMENT_TYPE_MESSAGES } from './constants'

// TanStack Form field/form render props require many generics — suppress with eslint
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyField = FieldApi<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

// Exported (in addition to the default route `Route`) so
// task-drop-share-override-and-receiver unit tests can mount this subcomponent
// directly (Surface A/C interaction tests) without rendering the entire
// 2000-line route page. Purely additive — no behavior change.
export function ProjectEditFields({
  form,
  mode,
  canEditOverride,
  defaultSharePercent,
  defaultDropSharePercent,
  dropId,
  viewerRole,
  projectId,
  pendingShare,
}: {
  form: AnyForm
  mode: 'info' | 'members'
  canEditOverride: boolean
  defaultSharePercent: number
  // task-drop-share-override-and-receiver (Surface A). Analog of
  // defaultSharePercent for the DROP share slider — the drop's global default
  // (`project.dropSharePercentDefault ?? 5`), shown as the "reset" hint.
  defaultDropSharePercent: number
  // Surface A visibility gate — the drop-share section only renders for
  // drop-projects (`project.dropId != null`).
  dropId: string | null
  // ut-fix-round2: HR теряет видимость секции с долей синьора целиком (не disabled).
  viewerRole: string | undefined
  projectId?: string | undefined
  /**
   * task-648-fix-round-2 (UX-H-3(r2)). The live proposal, so the edit form
   * can say it exists instead of letting the operator overwrite it blind.
   * `undefined`/`null` = nothing pending. Passed in rather than re-fetched:
   * the parent already has it on the same page.
   */
  pendingShare?: ProjectDetailDto['pendingSeniorShare'] | undefined
}) {
  const { t, i18n } = useLingui()
  // FIX-H-2 (spec SPEC-M-1 / copy COPY-H-1): a raw role enum in visible text
  // is a finding (urok #702 п.13) — ADMIN/ACCOUNTANT are not on the
  // exemption list. Resolved once here, reused by the three "who can edit
  // this" hints below (paymentType / senior share / drop share).
  const adminLabel = useRoleLabel('ADMIN')
  const accountantLabel = useRoleLabel('ACCOUNTANT')
  if (mode === 'info') {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>{t`Логотип компанії`}</Label>
          <ImageUploadField
            value={{
              documentId: (form.state.values as { logoDocumentId: string | null }).logoDocumentId,
              externalUrl: (form.state.values as { logoExternalUrl: string | null })
                .logoExternalUrl,
            }}
            onChange={(v) => {
              form.setFieldValue('logoDocumentId', v.documentId)
              form.setFieldValue('logoExternalUrl', v.externalUrl)
            }}
            category="LOGO"
            // Stryker disable next-line ConditionalExpression: `{ projectId: undefined }` and `{}` are indistinguishable downstream — `useUploadDocument` appends projectId only when truthy. The `=== undefined` and object-literal mutants ARE killed (see the "sends no projectId" test).
            {...(projectId !== undefined ? { projectId } : {})}
            urlPlaceholder="https://example.com/logo.png"
            testId="edit-project-logo"
          />
        </div>

        <form.Field
          name="name"
          validators={{
            onBlur: ({ value }: { value: string }) => {
              const r = createProjectSchema.shape.name.safeParse(value.trim())
              // Stryker disable next-line OptionalChaining: a failed safeParse always carries at least one issue, so `issues[0]` is never undefined — `?.` is a type-level guard only.
              return r.success ? undefined : r.error.issues[0]?.message
            },
          }}
        >
          {(field: AnyField) => {
            const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
            return (
              <div className="space-y-1.5">
                <Label className={cn(err && 'text-destructive')}>{t`Назва проєкту`}</Label>
                <Input
                  value={field.state.value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.handleChange(e.target.value)
                  }
                  onBlur={field.handleBlur}
                  placeholder="AI Platform v2"
                  className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                />
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            )
          }}
        </form.Field>

        <form.Field
          name="companyName"
          validators={{
            onBlur: ({ value }: { value: string }) => {
              const r = createProjectSchema.shape.companyName.safeParse(value.trim())
              // Stryker disable next-line OptionalChaining: a failed safeParse always carries at least one issue, so `issues[0]` is never undefined — `?.` is a type-level guard only.
              return r.success ? undefined : r.error.issues[0]?.message
            },
          }}
        >
          {(field: AnyField) => {
            const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
            return (
              <div className="space-y-1.5">
                <Label className={cn(err && 'text-destructive')}>{t`Компанія`}</Label>
                <Input
                  value={field.state.value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.handleChange(e.target.value)
                  }
                  onBlur={field.handleBlur}
                  placeholder="TechCorp AI"
                  className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                />
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            )
          }}
        </form.Field>

        <form.Field name="domain">
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label>{t`Домен`}</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                value={field.state.value}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  field.handleChange(e.target.value)
                }
              >
                {IT_DOMAINS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
        </form.Field>

        <div className="border-t border-border pt-3 space-y-3">
          {(
            [
              'techStack',
              'teamSize',
              'benefits',
              'paymentType',
              'salaryReview',
              'corpTech',
            ] as const
          ).map((fieldName) => {
            // task-drop-share-override-and-receiver (Surface C). paymentType
            // moves from free-text Input to a 3-value Select. Field-scoped RBAC
            // reuses `canEditOverride` (ADMIN/ACCOUNTANT edit; everyone else who
            // can reach this dialog — i.e. HR — sees it disabled/read).
            if (fieldName === 'paymentType') {
              // Stryker disable next-line StringLiteral: placeholder never renders in practice — `paymentType` always has a value (defaults to 'FOP'), so no test can observe this text. A JSX comment on the element itself does not suppress Stryker (urok #700) — the literal has to move to a plain JS assignment instead.
              const paymentTypePlaceholder = t`Виберіть тип оплати`
              return (
                <form.Field key="paymentType" name="paymentType">
                  {(field: AnyField) => (
                    <div className="space-y-1.5">
                      <Label>{i18n._(EDIT_FIELD_LABEL_MESSAGES.paymentType)}</Label>
                      <Select
                        value={field.state.value as string}
                        onValueChange={(v) => field.handleChange(v)}
                        disabled={!canEditOverride}
                      >
                        <SelectTrigger
                          className="h-9 text-sm"
                          data-testid="project-payment-type-trigger"
                        >
                          <SelectValue placeholder={paymentTypePlaceholder} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="FOP" className="text-sm">
                            {i18n._(PAYMENT_TYPE_MESSAGES.FOP)}
                          </SelectItem>
                          <SelectItem value="GIG_CONTRACT" className="text-sm">
                            {i18n._(PAYMENT_TYPE_MESSAGES.GIG_CONTRACT)}
                          </SelectItem>
                          <SelectItem value="USDT" className="text-sm">
                            {i18n._(PAYMENT_TYPE_MESSAGES.USDT)}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {!canEditOverride && (
                        <p className="text-xs text-muted-foreground italic">
                          <Trans>
                            Змінювати можуть лише {adminLabel} або {accountantLabel}.
                          </Trans>
                        </p>
                      )}
                    </div>
                  )}
                </form.Field>
              )
            }
            return (
              <form.Field key={fieldName} name={fieldName}>
                {(field: AnyField) => (
                  <div className="space-y-1.5">
                    <Label>{i18n._(EDIT_FIELD_LABEL_MESSAGES[fieldName])}</Label>
                    <Input
                      value={field.state.value as string}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        field.handleChange(e.target.value)
                      }
                      placeholder=""
                    />
                  </div>
                )}
              </form.Field>
            )
          })}
          <form.Field name="notesGeneral">
            {(field: AnyField) => (
              <div className="space-y-1.5">
                <Label>{t`Загальні нотатки`}</Label>
                <textarea
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring min-h-20 resize-y"
                  value={field.state.value as string}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    field.handleChange(e.target.value)
                  }
                  placeholder=""
                />
              </div>
            )}
          </form.Field>
        </div>

        <form.Subscribe
          selector={(s: { values: { rate: number; currency: string } }) => ({
            rate: s.values.rate,
            currency: s.values.currency,
          })}
        >
          {({ rate, currency }: { rate: number; currency: string }) => (
            <AmountCurrencyInput
              amount={String(rate ?? '')}
              currency={currency as Currency}
              onAmountChange={(v) => form.setFieldValue('rate', Number(v) as unknown as number)}
              onCurrencyChange={(v) =>
                form.setFieldValue('currency', v as 'USDT' | 'USD' | 'EUR' | 'UAH')
              }
              label={t`Ставка`}
              placeholder="5000"
            />
          )}
        </form.Subscribe>

        {/* Per-project SENIOR share — round-3 UI (PR #39 round 2):
            ShareSlider всегда виден; implicit reset (когда value === default —
            backend пишет null). Toggle/Сбросить упразднены.
            RBAC: HR и JUNIOR не видят секцию вообще (фильтрация через viewerRole);
            у не-ADMIN/ACCOUNTANT слайдер disabled. */}
        {viewerRole !== 'HR' && viewerRole !== 'JUNIOR' && (
          <form.Field
            name="seniorSharePercentOverride"
            validators={{
              onBlur: ({ value }: { value: number | null }) => {
                // Stryker disable next-line ConditionalExpression,StringLiteral: the `null` and `''` guards are redundant with the range check below — `Number(null)` and `Number('')` are both 0, which passes it — so disabling either is unobservable. The `undefined` guard (`Number(undefined)` is NaN) IS observable and is pinned by the "undefined override" test.
                if (value === null || value === undefined || (value as unknown as string) === '')
                  return undefined
                const num = Number(value)
                if (!Number.isInteger(num) || num < 0 || num > 100) {
                  return t`Введіть ціле число від 0 до 100`
                }
                return undefined
              },
            }}
          >
            {(field: AnyField) => {
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
              const raw = field.state.value as number | null
              const hasOverride = raw !== null && raw !== undefined
              // Initial / current slider value — effective % (override OR default).
              const sliderValue = hasOverride ? (raw as number) : defaultSharePercent
              return (
                <div className="space-y-2" data-testid="project-edit-senior-share-section">
                  <Label className={cn(err && 'text-destructive')}>{t`Частка сеньйора (%)`}</Label>
                  <ShareSlider
                    value={sliderValue}
                    min={0}
                    max={100}
                    disabled={!canEditOverride}
                    onChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                    error={!!err}
                    inputTestId="project-edit-senior-share-override"
                  />
                  {/* task-648-fix-round-2 (COPY-H-6): the form where the
                      change STARTS never said the change does not take
                      effect on save. It does now — one sentence, next to the
                      control it describes.

                      The round-1 wording promising that the same value also
                      CANCELS an open proposal is gone with the branch it
                      described (SR-H-2): withdrawing is the explicit button
                      below, and no text may promise a gesture that no longer
                      does anything. */}
                  {/* task-648-fix-round-3 (COPY-M-16): one tense and one
                      vocabulary. The old sentence promised in the PRESENT
                      that the same value «сбрасывает переопределение», then
                      said in the FUTURE that nothing happens until the senior
                      confirms — two contradictory claims about the same save,
                      the first of which is not true any more (nothing on this
                      form takes effect on save). And «переопределение» is not
                      a word the product uses: CONTEXT.md's «Доля синьора»
                      entry calls the personal level «(по умолчанию)», and
                      this screen's own approval banner already says
                      «индивидуальная доля». */}
                  {/* task-648-fix-round-4 (COPY-L-16): the caveat leads now.
                      Sentence two promised an action, and the "not until the
                      senior agrees" qualifier arrived only in sentence three
                      — so the reader had to hold two claims at once to answer
                      one question. Reordered rather than reworded: both
                      clauses stay in the FUTURE, which is what COPY-M-16
                      fixed one round ago and what «снимает» in the review's
                      suggested phrasing would have undone. */}
                  <p className="text-xs text-muted-foreground">
                    <Trans>
                      Будь-яка зміна почне діяти після підтвердження сеньйора. За замовчуванням —{' '}
                      {defaultSharePercent}%: те саме значення знімає індивідуальну частку по
                      проєкту.
                    </Trans>
                  </p>
                  {/* task-648-fix-round-2 (UX-H-3(r2)): an ADMIN who opens
                      this form to "fix" the percent saw a slider holding the
                      ACTIVE value and nothing about the proposal already
                      awaiting an answer — so the natural gesture silently
                      superseded it. */}
                  {canEditOverride && pendingShare && projectId && (
                    <PendingShareEditNotice
                      scope="project"
                      id={projectId}
                      pendingPercent={
                        pendingShare.percent === null
                          ? pendingShare.effectivePercentAfterApproval
                          : pendingShare.percent
                      }
                      approverName={pendingShare.approverName}
                    />
                  )}
                  {!canEditOverride && (
                    <p className="text-xs text-muted-foreground italic">
                      <Trans>
                        Змінювати можуть лише {adminLabel} або {accountantLabel}.
                      </Trans>
                    </p>
                  )}
                  {err && <p className="text-xs text-destructive">{err}</p>}
                </div>
              )
            }}
          </form.Field>
        )}

        {/* Per-project DROP share — task-drop-share-override-and-receiver
            (Surface A). Full analog of seniorSharePercentOverride above:
            differs only in field name / label / role / visibility gate
            (drop-projects only, `project.dropId != null`). Same RBAC —
            HR/JUNIOR never see the section; non-ADMIN/ACCOUNTANT see it
            disabled. */}
        {viewerRole !== 'HR' && viewerRole !== 'JUNIOR' && dropId != null && (
          <form.Field
            name="dropSharePercentOverride"
            validators={{
              onBlur: ({ value }: { value: number | null }) => {
                // Stryker disable next-line ConditionalExpression,StringLiteral: the `null` and `''` guards are redundant with the range check below — `Number(null)` and `Number('')` are both 0, which passes it — so disabling either is unobservable. The `undefined` guard (`Number(undefined)` is NaN) IS observable and is pinned by the "undefined override" test.
                if (value === null || value === undefined || (value as unknown as string) === '')
                  return undefined
                const num = Number(value)
                if (!Number.isInteger(num) || num < 0 || num > 100) {
                  return t`Введіть ціле число від 0 до 100`
                }
                return undefined
              },
            }}
          >
            {(field: AnyField) => {
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
              const raw = field.state.value as number | null
              const hasOverride = raw !== null && raw !== undefined
              // Initial / current slider value — effective % (override OR default).
              const sliderValue = hasOverride ? (raw as number) : defaultDropSharePercent
              return (
                <div className="space-y-2" data-testid="project-edit-drop-share-section">
                  <Label className={cn(err && 'text-destructive')}>{t`Частка дропа (%)`}</Label>
                  <ShareSlider
                    value={sliderValue}
                    min={0}
                    max={100}
                    disabled={!canEditOverride}
                    onChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                    error={!!err}
                    inputTestId="project-edit-drop-share-override"
                    role="DROP"
                  />
                  {/* task-648-fix-round-3 (COPY-M-16, follow-through): the
                      senior twin ~60 lines above stopped saying
                      «переопределение» in this round. Leaving this one alone
                      would put two words for one operation in ONE dialog —
                      the defect COPY-M-16 is about, merely moved. */}
                  <p className="text-xs text-muted-foreground">
                    <Trans>
                      За замовчуванням — {defaultDropSharePercent}%. Те саме значення знімає
                      індивідуальну частку дропа по проєкту.
                    </Trans>
                  </p>
                  {!canEditOverride && (
                    <p className="text-xs text-muted-foreground italic">
                      <Trans>
                        Змінювати можуть лише {adminLabel} або {accountantLabel}.
                      </Trans>
                    </p>
                  )}
                  {err && <p className="text-xs text-destructive">{err}</p>}
                </div>
              )
            }}
          </form.Field>
        )}
      </div>
    )
  }
  return null
}
