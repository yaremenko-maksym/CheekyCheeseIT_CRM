import { useLingui } from '@lingui/react/macro'
import { i18n } from '@lingui/core'
import type { FieldApi } from '@tanstack/react-form'
import type { ItDomain } from '@crm/shared'
import { createProjectSchema, IT_DOMAINS } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ImageUploadField } from '@/components/ui/image-upload-field'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PAYMENT_TYPE_MESSAGES } from '../constants'
import type { useCreateProjectForm } from '../use-create-project-form'

// TanStack Form field render props require all 23 FieldApi generics — use unknown to avoid any
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
/* eslint-enable @typescript-eslint/no-explicit-any */

type OptionUser = { id: string; displayName: string }

interface ProjectCreateDialogProps {
  showCreate: boolean
  setShowCreate: (open: boolean) => void
  createForm: ReturnType<typeof useCreateProjectForm>['createForm']
  createMutation: ReturnType<typeof useCreateProjectForm>['createMutation']
  canEditPaymentType: boolean
  seniorUsers: OptionUser[]
  dropUsers: OptionUser[]
}

export function ProjectCreateDialog({
  showCreate,
  setShowCreate,
  createForm,
  createMutation,
  canEditPaymentType,
  seniorUsers,
  dropUsers,
}: ProjectCreateDialogProps) {
  const { t } = useLingui()
  return (
    <Dialog
      open={showCreate}
      onOpenChange={(open) => {
        if (!open) {
          setShowCreate(false)
          createForm.reset()
        }
      }}
    >
      <CrmDialogContent maxWidth="max-w-md">
        <CrmDialogHeader>
          <DialogTitle>{t`Новий проєкт`}</DialogTitle>
          <DialogDescription className="sr-only">{t`Створення проєкту`}</DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t`Логотип компанії`}</Label>
              <ImageUploadField
                value={{
                  documentId: (createForm.state.values as { logoDocumentId: string | null })
                    .logoDocumentId,
                  externalUrl: (createForm.state.values as { logoExternalUrl: string | null })
                    .logoExternalUrl,
                }}
                onChange={(v) => {
                  createForm.setFieldValue('logoDocumentId', v.documentId)
                  createForm.setFieldValue('logoExternalUrl', v.externalUrl)
                }}
                category="LOGO"
                urlPlaceholder="https://example.com/logo.png"
                testId="create-project-logo"
              />
            </div>

            <createForm.Field
              name="name"
              validators={{
                onBlur: ({ value }: { value: string }) => {
                  const r = createProjectSchema.shape.name.safeParse(value.trim())
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
            </createForm.Field>

            <createForm.Field
              name="companyName"
              validators={{
                onBlur: ({ value }: { value: string }) => {
                  const r = createProjectSchema.shape.companyName.safeParse(value.trim())
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
            </createForm.Field>

            <createForm.Field name="domain">
              {(field: AnyField) => (
                <div className="space-y-1.5">
                  <Label>{t`Домен`}</Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                    value={field.state.value}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      field.handleChange(e.target.value as ItDomain)
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
            </createForm.Field>

            <createForm.Field
              name="seniorId"
              validators={{
                onBlur: ({ value }: { value: string }) => {
                  const r = createProjectSchema.shape.seniorId.safeParse(value)
                  return r.success ? undefined : t`Виберіть сеньйора`
                },
              }}
            >
              {(field: AnyField) => {
                const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                return (
                  <div className="space-y-1.5">
                    <Label className={cn(err && 'text-destructive')}>{t`Сеньйор`}</Label>
                    <select
                      className={cn(
                        'w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring',
                        err ? 'border-destructive' : 'border-input',
                      )}
                      value={field.state.value}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                        field.handleChange(e.target.value)
                      }
                      onBlur={field.handleBlur}
                    >
                      <option value="">{t`— виберіть сеньйора —`}</option>
                      {seniorUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName}
                        </option>
                      ))}
                    </select>
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                )
              }}
            </createForm.Field>

            {/* Drop role - phase 2. Optional Select shown only when at least
                one DROP user exists. Empty = «не выбран» — regular senior-
                project (legacy regression path). Otherwise — drop-project. */}
            {dropUsers.length > 0 && (
              <createForm.Field name="dropId">
                {(field: AnyField) => (
                  <div className="space-y-1.5">
                    <Label>{t`Дроп (опційно)`}</Label>
                    <select
                      data-testid="create-project-drop-select"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                      value={field.state.value}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                        field.handleChange(e.target.value)
                      }
                      onBlur={field.handleBlur}
                    >
                      <option value="">{t`— не обрано —`}</option>
                      {dropUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {t`Якщо обрано — надходження за проєктом підуть через дропа (частка 5% за замовчуванням).`}
                    </p>
                  </div>
                )}
              </createForm.Field>
            )}

            <createForm.Subscribe
              selector={(s: { values: { rate: number; currency: string } }) => ({
                rate: s.values.rate,
                currency: s.values.currency,
              })}
            >
              {({ rate, currency }: { rate: number; currency: string }) => (
                <AmountCurrencyInput
                  amount={String(rate ?? '')}
                  currency={currency as Currency}
                  onAmountChange={(v) =>
                    createForm.setFieldValue('rate', Number(v) as unknown as number)
                  }
                  onCurrencyChange={(v) =>
                    createForm.setFieldValue('currency', v as 'USDT' | 'USD' | 'EUR' | 'UAH')
                  }
                  label={t`Ставка`}
                  placeholder="5000"
                />
              )}
            </createForm.Subscribe>

            <createForm.Field name="startDate">
              {(field: AnyField) => (
                <div className="space-y-1.5">
                  <Label>{t`Дата початку`}</Label>
                  <Input
                    type="date"
                    value={field.state.value}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      field.handleChange(e.target.value)
                    }
                  />
                </div>
              )}
            </createForm.Field>

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
                const labels: Record<string, string> = {
                  techStack: t`Стек технологій`,
                  teamSize: t`Склад команди`,
                  benefits: t`Бенефіти`,
                  // Stryker disable next-line StringLiteral: dead entry - the paymentType branch below returns before labels[fieldName] is read
                  paymentType: t`Тип оплати`,
                  salaryReview: t`Перегляд ЗП`,
                  corpTech: t`Корп. техніка`,
                }
                // task-drop-share-override-and-receiver (Surface C).
                // paymentType moves from free-text Input to a 3-value
                // Select — same field-scoped RBAC pattern as the edit form.
                if (fieldName === 'paymentType') {
                  return (
                    <createForm.Field key="paymentType" name="paymentType">
                      {(field: AnyField) => (
                        <div className="space-y-1.5">
                          <Label>{t`Тип оплати`}</Label>
                          <Select
                            value={field.state.value as string}
                            onValueChange={(v) => field.handleChange(v)}
                            disabled={!canEditPaymentType}
                          >
                            <SelectTrigger
                              className="h-9 text-sm"
                              data-testid="project-payment-type-trigger"
                            >
                              <SelectValue placeholder={t`Виберіть тип оплати`} />
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
                          {!canEditPaymentType && (
                            <p className="text-xs text-muted-foreground italic">
                              {t`Змінювати може тільки адмін або бухгалтер.`}
                            </p>
                          )}
                        </div>
                      )}
                    </createForm.Field>
                  )
                }
                return (
                  <createForm.Field key={fieldName} name={fieldName}>
                    {(field: AnyField) => (
                      <div className="space-y-1.5">
                        <Label>{labels[fieldName]}</Label>
                        <Input
                          value={field.state.value as string}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            field.handleChange(e.target.value)
                          }
                          placeholder=""
                        />
                      </div>
                    )}
                  </createForm.Field>
                )
              })}
              <createForm.Field name="notesGeneral">
                {(field: AnyField) => (
                  <div className="space-y-1.5">
                    <Label>{t`Загальні примітки`}</Label>
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
              </createForm.Field>
            </div>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setShowCreate(false)
              createForm.reset()
            }}
          >
            {t`Скасувати`}
          </Button>
          <Button
            onClick={() => void createForm.handleSubmit()}
            disabled={createMutation.isPending}
            data-track="project-create"
          >
            {createMutation.isPending ? t`Створення…` : t`Створити`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
