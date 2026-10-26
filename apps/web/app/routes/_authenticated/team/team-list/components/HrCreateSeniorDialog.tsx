import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, UserPlus } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { z } from 'zod'
import type { HrCreateSeniorDto, UserProfileDto } from '@crm/shared'
import { hrCreateSeniorSchema, updateProfileSchema } from '@crm/shared'
import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { api } from '@/lib/axios'
import { getApiErrorMessage, translateZodCode, translateZodMessage } from '@/lib/axios-utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ShareSlider } from '@/components/ui/share-slider'
import { toast } from 'sonner'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { Field } from '@/components/users/section'
import { seniorTechStackError } from '@/components/users/user-dialog/validation'
import { normalizeTelegram } from '../normalize-telegram'

type UserOption = {
  id: string
  displayName: string
  email: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
}

async function fetchAllUsers(): Promise<UserOption[]> {
  const res = await api.get<UserOption[]>('/users')
  return res.data
}

// ── Share slider ──────────────────────────────────────────────────────────────
// The component lives in `@/components/ui/share-slider` (relocated from
// `components/users/` in PR #39 round 1). `value` is the SENIOR's share
// (matches API field `seniorSharePercent`). Visual order [company %] [senior %].

const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
const phoneFieldSchema = z.string().max(30)

// PhoneInput seeds this calling code (UA default) into an untouched field on mount.
const SEEDED_CALLING_CODE = '+380'

/** The phone the user actually entered, or undefined when empty / only the seeded calling code. */
function enteredPhone(value: string): string | undefined {
  return value && value !== SEEDED_CALLING_CODE ? value : undefined
}

// ── HR: Create Senior Dialog ──────────────────────────────────────────────────
// HR uses this to create a new SENIOR user (which auto-creates the team).
// hrIds is pre-filled with the current HR user; accountant is optional.

export function HrCreateSeniorDialog({
  open,
  onClose,
  hrUserId,
}: {
  open: boolean
  onClose: () => void
  hrUserId: string
}) {
  const { t } = useLingui()
  const queryClient = useQueryClient()

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: fetchAllUsers,
    enabled: open,
  })

  const accountantUsers = useMemo(
    // Stryker disable next-line ArrayDeclaration: a non-empty placeholder array has no ACCOUNTANT-role item either, so the filtered result is identical
    () => (allUsers ?? []).filter((u) => u.role === 'ACCOUNTANT'),
    [allUsers],
  )

  // Stryker disable next-line StringLiteral: the initial value is overwritten by the open-effect on the first commit, before any user can observe or submit it
  const [selectedAccountantId, setSelectedAccountantId] = useState('')

  useEffect(() => {
    if (!open) return
    setSelectedAccountantId(
      accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : '',
    )
  }, [open, accountantUsers])

  const mutation = useMutation({
    mutationFn: (data: HrCreateSeniorDto) => api.post<UserProfileDto>('/users', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success(t`Сеньйора створено, команду сформовано`)
      onClose()
      form.reset()
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err, t`Не вдалося створити команду — спробуйте ще раз`))
    },
  })

  const techErrorId = useId()
  const form = useForm({
    defaultValues: {
      email: '',
      displayName: '',
      telegram: '',
      phone: '' as PhoneValue | '',
      techStack: [] as string[],
      seniorSharePercent: 26 as number,
    },
    onSubmit: async ({ value }) => {
      const payload: HrCreateSeniorDto = {
        email: value.email.trim(),
        displayName: value.displayName.trim(),
        role: 'SENIOR',
        telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
        phone: enteredPhone(value.phone as string),
        techStack: value.techStack.length > 0 ? value.techStack : undefined,
        seniorSharePercent: value.seniorSharePercent,
        hrIds: [hrUserId],
        accountantId: selectedAccountantId || null,
      }
      const result = hrCreateSeniorSchema.safeParse(payload)
      if (!result.success) {
        // fix-round 2 (SR-M-6/COPY-H-3): translate the actual issue when it
        // is a migrated code, same pattern as every other submit-toast in
        // UserDialog.tsx — was a fixed Russian literal regardless of which
        // field actually failed.
        const first = result.error.issues[0]
        toast.error(
          // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see UserDialog.tsx's own field validators for the same invariant
          translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
        )
        return
      }
      mutation.mutate(result.data)
    },
  })

  const handleClose = () => {
    form.reset()
    setSelectedAccountantId('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            <Trans>Створити сеньйора</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Створіть сеньйора та сформуйте команду.</Trans>
          </DialogDescription>
          <p className="text-xs text-muted-foreground mt-1">
            <Trans>Буде створено акаунт сеньйора та сформовано команду з вами в ролі HR.</Trans>
          </p>
        </CrmDialogHeader>
        <CrmDialogBody>
          <div className="grid gap-4 py-2">
            {/* Email */}
            <form.Field
              name="email"
              validators={{
                onBlur: ({ value }) => {
                  const r = hrCreateSeniorSchema.shape.email.safeParse(value.trim())
                  // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse (same invariant as the submit handler below)
                  return r.success ? undefined : translateZodMessage(r.error.issues[0]?.message)
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched
                  ? (field.state.meta.errors[0] as string | undefined)
                  : undefined
                return (
                  <Field label="Email" error={err} required>
                    <Input
                      type="email"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="senior@cheekycheese.dev"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                      autoComplete="off"
                    />
                  </Field>
                )
              }}
            </form.Field>

            {/* Name */}
            <form.Field
              name="displayName"
              validators={{
                onBlur: ({ value }) => {
                  const r = hrCreateSeniorSchema.shape.displayName.safeParse(value.trim())
                  // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse (same invariant as the submit handler below)
                  return r.success ? undefined : translateZodMessage(r.error.issues[0]?.message)
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched
                  ? (field.state.meta.errors[0] as string | undefined)
                  : undefined
                return (
                  <Field label={t`Ім’я та прізвище`} error={err} required>
                    <Input
                      placeholder={t`Іван Іваненко`}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      autoCapitalize="words"
                      autoComplete="off"
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                  </Field>
                )
              }}
            </form.Field>

            {/* Tech Stack */}
            {/* A SENIOR needs at least 3 distinct technologies (shared rule). */}
            <form.Subscribe selector={(s) => s.submissionAttempts}>
              {(attempts) => (
                <form.Field
                  name="techStack"
                  validators={{ onSubmit: ({ value }) => seniorTechStackError('SENIOR', value) }}
                >
                  {(field) => {
                    // Recomputed after the first submit, so it follows every change.
                    const err =
                      attempts > 0 ? seniorTechStackError('SENIOR', field.state.value) : undefined
                    return (
                      <Field label={t`Технології`} error={err} errorId={techErrorId}>
                        <TechAutocompleteInput
                          value={field.state.value}
                          onChange={field.handleChange}
                          onBlur={field.handleBlur}
                          placeholder={t`Почніть вводити: React, Node.js…`}
                          errorId={err ? techErrorId : undefined}
                        />
                      </Field>
                    )
                  }}
                </form.Field>
              )}
            </form.Subscribe>

            {/* Telegram */}
            <form.Field
              name="telegram"
              validators={{
                onBlur: ({ value }) => {
                  if (!value.trim()) return undefined
                  const r = telegramFieldSchema.safeParse(value.trim())
                  // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse (same invariant as the submit handler below)
                  return r.success ? undefined : translateZodMessage(r.error.issues[0]?.message)
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched
                  ? (field.state.meta.errors[0] as string | undefined)
                  : undefined
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

            {/* Phone */}
            <form.Field
              name="phone"
              validators={{
                onBlur: ({ value }) => {
                  // The optional phone holding only the seeded calling code is "no phone",
                  // not an invalid one — otherwise a pristine form could not be submitted.
                  const v = enteredPhone(value as string)
                  if (!v) return undefined
                  const r = phoneFieldSchema.safeParse(v)
                  // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse (same invariant as the submit handler below)
                  if (!r.success) return translateZodMessage(r.error.issues[0]?.message)
                  if (!isValidPhoneNumber(v)) return translateZodCode('PHONE_INVALID')
                  return undefined
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched
                  ? (field.state.meta.errors[0] as string | undefined)
                  : undefined
                return (
                  <Field label={t`Телефон`} error={err}>
                    <PhoneInput
                      value={field.state.value as PhoneValue | undefined}
                      onChange={(v) => field.handleChange((v ?? '') as PhoneValue | '')}
                      onBlur={field.handleBlur}
                      className={cn(err && '[&_input]:border-destructive')}
                    />
                  </Field>
                )
              }}
            </form.Field>

            {/* Financials + team */}
            <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground">
                <Trans>Фінанси та команда</Trans>
              </p>

              {/* Share % */}
              <form.Field
                name="seniorSharePercent"
                validators={{
                  onBlur: ({ value }) => {
                    if (value < 1 || value > 100)
                      return translateZodCode('SHARE_PERCENT_RANGE_1_100')
                    return undefined
                  },
                }}
              >
                {(field) => {
                  // ut-31: value is SENIOR's share (default 26 → 74% company / 26% senior).
                  const val = field.state.value ?? 26
                  const err = field.state.meta.isTouched
                    ? (field.state.meta.errors[0] as string | undefined)
                    : undefined
                  return (
                    <Field label={t`Частка сеньйора (%)`} error={err} required>
                      <ShareSlider
                        value={val}
                        onChange={(v) => field.handleChange(v)}
                        onBlur={field.handleBlur}
                        error={!!err}
                      />
                    </Field>
                  )
                }}
              </form.Field>

              {/* HR — auto (current user) */}
              <Field label={t`HR`}>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                  <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  <span>
                    <Trans>Ви</Trans>
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    <Trans>авто</Trans>
                  </span>
                </div>
              </Field>

              {/* Accountant */}
              <Field label={t`Бухгалтер`}>
                {accountantUsers.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    <Trans>Бухгалтерів ще немає — зверніться до адміністратора</Trans>
                  </p>
                ) : accountantUsers.length === 1 ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    <span>{accountantUsers[0]!.displayName}</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      <Trans>авто</Trans>
                    </span>
                  </div>
                ) : (
                  <Select value={selectedAccountantId} onValueChange={setSelectedAccountantId}>
                    <SelectTrigger>
                      <SelectValue placeholder={t`— оберіть бухгалтера —`} />
                    </SelectTrigger>
                    <SelectContent>
                      {accountantUsers.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            <Trans>Скасувати</Trans>
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={mutation.isPending}>
            {mutation.isPending ? t`Створюємо…` : t`Створити`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
