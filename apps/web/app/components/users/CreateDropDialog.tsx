import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Coins, Landmark, Percent, Send, UserPlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import type { AxiosError } from 'axios'
import type {
  CreateDropDto,
  PaymentMethod,
  UserProfileDto,
} from '@crm/shared'
import { createDropSchema, updateProfileSchema } from '@crm/shared'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
  Dialog,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { ShareSlider } from '@/components/ui/share-slider'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { normalizeTelegram, ROLE_LABELS, ROLE_VARIANT } from './constants'
import { Field, Section } from './section'
import { HrChipsField } from './HrChipsField'
import { AccountantChipField } from './AccountantChipField'

const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
const phoneFieldSchema = z.string().max(30)

const usdtWalletPattern = /^0x[a-fA-F0-9]{40}$/
const ibanPattern = /^UA\d{27}$/
const rnokppPattern = /^\d{10}$/

/**
 * Drop role - phase 1 (AC2) — «Создать дропа» dialog.
 *
 * Mirrors the senior-create surface (UserDialog with role=SENIOR) but:
 *  - role is locked to DROP; identity section omits the role picker
 *  - finance section shows the «Доля дропа, %» slider (default 5) instead of
 *    the senior share / monthly salary fork
 *  - payment requisites support both USDT ERC-20 and Bank UAH ФОП (spec §8.3)
 *  - the team section is **mandatory**: backend always provisions the drop-team
 *    atomically via POST /api/users/drops
 *
 * On success: invalidates queries + navigates to `/crm/team/<newTeamId>`
 * (the response shape is `{ user, team: { id, ... }, members: [...] }` —
 * see UsersService.createDrop / TeamsService.createDropTeam).
 */
export function CreateDropDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: allUsers } = useQuery({
    queryKey: ['users-admin'],
    queryFn: () => api.get<UserProfileDto[]>('/users').then((r) => r.data),
    enabled: open,
  })

  const hrUsers = useMemo(
    () => allUsers?.filter((u) => u.role === 'HR' && !u.archivedAt) ?? [],
    [allUsers],
  )
  const accountantUsers = useMemo(
    () => allUsers?.filter((u) => u.role === 'ACCOUNTANT' && !u.archivedAt) ?? [],
    [allUsers],
  )

  const [selectedHrIds, setSelectedHrIds] = useState<string[]>([])
  const [selectedAccountantId, setSelectedAccountantId] = useState<string>('')

  // Refs to avoid stale-closure in onSubmit (mirror UserDialog approach).
  const selectedHrIdsRef = useRef(selectedHrIds)
  const selectedAccountantIdRef = useRef(selectedAccountantId)
  useEffect(() => {
    selectedHrIdsRef.current = selectedHrIds
  }, [selectedHrIds])
  useEffect(() => {
    selectedAccountantIdRef.current = selectedAccountantId
  }, [selectedAccountantId])

  // Auto-select single HR / accountant — same affordance as UserDialog create.
  useEffect(() => {
    if (!open) return
    const initialHr = hrUsers.length === 1 && hrUsers[0] ? [hrUsers[0].id] : []
    setSelectedHrIds(initialHr)
    const initialAcc =
      accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : ''
    setSelectedAccountantId(initialAcc)
  }, [open, hrUsers.length, accountantUsers.length])

  const mutation = useMutation({
    mutationFn: (data: CreateDropDto) =>
      api.post<{
        user: UserProfileDto
        team: { id: string }
      }>('/users/drops', data),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Дроп создан')
      onClose()
      // Navigate to the new drop-team detail page so the admin lands on
      // the artefact they just created — same pattern as Create Project.
      const newTeamId = res.data.team?.id
      if (newTeamId) {
        void navigate({ to: '/crm/team/$teamId', params: { teamId: newTeamId } })
      }
    },
    onError: (err: AxiosError<{ message: string }>) => {
      toast.error(err?.response?.data?.message ?? 'Ошибка при создании дропа')
    },
  })

  const form = useForm({
    defaultValues: {
      email: '',
      displayName: '',
      telegram: '',
      phone: '' as PhoneValue | '',
      // Share — drop keeps this off each project income. Default 5% per spec.
      dropSharePercent: 5 as number,
      // Drop is NOT USDT-only (§8.3) — default to USDT but allow Bank UAH.
      paymentMethod: 'USDT_ERC20' as PaymentMethod,
      walletUsdtErc20: '',
      walletUsdtLabel: '',
      bankUahRecipient: '',
      bankUahIban: '',
      bankUahRnokpp: '',
      bankUahBankName: '',
      telegramChannel: '' as string,
    },
    onSubmit: async ({ value }) => {
      const hrIds = selectedHrIdsRef.current
      const accountantId = selectedAccountantIdRef.current

      if (hrIds.length === 0) {
        toast.error('Выберите хотя бы одного HR')
        return
      }
      if (!accountantId) {
        toast.error('Выберите бухгалтера')
        return
      }

      const trimmedChannel = value.telegramChannel.trim()
      const normalizedChannel = trimmedChannel
        ? trimmedChannel.startsWith('@')
          ? trimmedChannel.slice(1)
          : trimmedChannel
        : null

      const payload: CreateDropDto = {
        email: value.email.trim(),
        displayName: value.displayName.trim(),
        telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
        phone: (value.phone as string) || undefined,
        dropSharePercent: value.dropSharePercent,
        paymentMethod: value.paymentMethod,
        ...(value.paymentMethod === 'USDT_ERC20' && {
          walletUsdtErc20: value.walletUsdtErc20.trim(),
          ...(value.walletUsdtLabel.trim() && {
            walletUsdtLabel: value.walletUsdtLabel.trim(),
          }),
        }),
        ...(value.paymentMethod === 'BANK_UAH_FOP' && {
          bankUahRecipient: value.bankUahRecipient.trim(),
          bankUahIban: value.bankUahIban.trim(),
          bankUahRnokpp: value.bankUahRnokpp.trim(),
          ...(value.bankUahBankName.trim() && {
            bankUahBankName: value.bankUahBankName.trim(),
          }),
        }),
        hrIds,
        accountantId,
        telegramChannel: normalizedChannel,
      }

      const result = createDropSchema.safeParse(payload)
      if (!result.success) {
        const first = result.error.issues[0]
        toast.error(first?.message ?? 'Ошибка валидации данных')
        return
      }
      mutation.mutate(result.data)
    },
  })

  const handleClose = () => {
    form.reset()
    setSelectedHrIds([])
    setSelectedAccountantId('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-lg" data-testid="create-drop-dialog">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Создать дропа
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Будет создан аккаунт дропа и сформирована команда дропа с выбранными HR и
            бухгалтером.
          </p>
        </CrmDialogHeader>

        <CrmDialogBody>
          <div className="grid gap-3 py-2">
            {/* Identity */}
            <Section title="Идентичность">
              <form.Field
                name="email"
                validators={{
                  onBlur: ({ value, fieldApi }) => {
                    if (!fieldApi.state.meta.isDirty) return undefined
                    const trimmed = value.trim()
                    if (!trimmed) return 'Email обязателен'
                    const r = z.string().email('Некорректный email').safeParse(trimmed)
                    return r.success ? undefined : r.error.issues[0]?.message
                  },
                }}
              >
                {(field) => {
                  const showError =
                    field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
                  return (
                    <Field label="Email" error={err} required>
                      <Input
                        placeholder="drop@cheekycheese.dev"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        className={cn(
                          err && 'border-destructive focus-visible:ring-destructive/30',
                        )}
                        autoComplete="off"
                        data-testid="create-drop-email"
                      />
                    </Field>
                  )
                }}
              </form.Field>

              <form.Field
                name="displayName"
                validators={{
                  onBlur: ({ value, fieldApi }) => {
                    if (!fieldApi.state.meta.isDirty) return undefined
                    const r = z
                      .string()
                      .min(2, 'Имя минимум 2 символа')
                      .max(255)
                      .safeParse(value.trim())
                    return r.success ? undefined : r.error.issues[0]?.message
                  },
                }}
              >
                {(field) => {
                  const showError =
                    field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
                  return (
                    <Field label="Имя и фамилия" error={err} required>
                      <Input
                        placeholder="Иван Иванов"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        className={cn(
                          err && 'border-destructive focus-visible:ring-destructive/30',
                        )}
                        data-testid="create-drop-name"
                      />
                    </Field>
                  )
                }}
              </form.Field>

              <Field label="Роль">
                <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2">
                  <Badge variant="drop" className="text-[11px]">
                    {ROLE_LABELS.DROP}
                  </Badge>
                  <span className="text-xs text-muted-foreground">фиксированно</span>
                </div>
              </Field>
            </Section>

            {/* Contacts */}
            <Section title="Контакты">
              <form.Field
                name="telegram"
                validators={{
                  onBlur: ({ value, fieldApi }) => {
                    if (!fieldApi.state.meta.isDirty) return undefined
                    if (!value.trim()) return undefined
                    const r = telegramFieldSchema.safeParse(value.trim())
                    return r.success ? undefined : r.error.issues[0]?.message
                  },
                }}
              >
                {(field) => {
                  const showError =
                    field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
                  return (
                    <Field label="Telegram" error={err}>
                      <Input
                        placeholder="@username"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        className={cn(
                          err && 'border-destructive focus-visible:ring-destructive/30',
                        )}
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
                    if (!r.success) return r.error.issues[0]?.message
                    if (!isValidPhoneNumber(v)) return 'Некорректный номер телефона'
                    return undefined
                  },
                }}
              >
                {(field) => {
                  const showError =
                    field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
                  return (
                    <Field label="Телефон" error={err}>
                      <PhoneInput
                        value={field.state.value as PhoneValue | undefined}
                        onChange={(v) =>
                          field.handleChange((v ?? '') as PhoneValue | '')
                        }
                        onBlur={field.handleBlur}
                        className={cn(err && '[&_input]:border-destructive')}
                      />
                    </Field>
                  )
                }}
              </form.Field>
            </Section>

            {/* Finance — drop share % */}
            <Section title="Финансы">
              <form.Field
                name="dropSharePercent"
                validators={{
                  onBlur: ({ value }) => {
                    if (value < 0 || value > 100) return 'Введите от 0 до 100'
                    return undefined
                  },
                }}
              >
                {(field) => {
                  const val = field.state.value ?? 5
                  const err = field.state.meta.isTouched
                    ? field.state.meta.errors[0]
                    : undefined
                  return (
                    <Field
                      label="Доля дропа (%)"
                      hint="Сколько дроп оставляет себе с каждой выплаты"
                      error={err}
                      required
                    >
                      <ShareSlider
                        value={val}
                        onChange={(v) => field.handleChange(v)}
                        onBlur={field.handleBlur}
                        error={!!err}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
                        <Percent className="h-3 w-3" />
                        По умолчанию 5%
                      </p>
                    </Field>
                  )
                }}
              </form.Field>
            </Section>

            {/* Payment requisites — DROP allows both USDT and Bank UAH */}
            <Section title="Платёжные реквизиты">
              <form.Field name="paymentMethod">
                {(field) => (
                  <Field label="Способ оплаты" required>
                    <SegmentedToggle<PaymentMethod>
                      value={field.state.value}
                      onChange={(v) => field.handleChange(v)}
                      options={[
                        { value: 'USDT_ERC20', label: 'USDT ERC-20', icon: Coins },
                        {
                          value: 'BANK_UAH_FOP',
                          label: 'Bank UAH (ФОП)',
                          icon: Landmark,
                        },
                      ]}
                      ariaLabel="Способ оплаты"
                      layoutId="create-drop-payment-method"
                      testId="create-drop-payment-method"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {field.state.value === 'USDT_ERC20'
                        ? 'Будет использоваться адрес кошелька в сети Ethereum.'
                        : 'Будет использоваться украинский банковский счёт ФОП.'}
                    </p>
                  </Field>
                )}
              </form.Field>

              <form.Subscribe selector={(s) => s.values.paymentMethod}>
                {(method) =>
                  method === 'USDT_ERC20' ? (
                    <>
                      <form.Field
                        name="walletUsdtErc20"
                        validators={{
                          onBlur: ({ value, fieldApi }) => {
                            if (!fieldApi.state.meta.isDirty) return undefined
                            if (!value.trim()) return 'USDT кошелёк обязателен'
                            return usdtWalletPattern.test(value.trim())
                              ? undefined
                              : 'USDT ERC-20 адрес должен начинаться с 0x и содержать 42 символа'
                          },
                        }}
                      >
                        {(field) => {
                          const showError =
                            field.state.meta.isTouched && field.state.meta.isDirty
                          const err = showError ? field.state.meta.errors[0] : undefined
                          return (
                            <Field label="USDT ERC-20 кошелёк" error={err} required>
                              <Input
                                placeholder="0x..."
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                                onBlur={field.handleBlur}
                                autoComplete="off"
                                className={cn(
                                  err &&
                                    'border-destructive focus-visible:ring-destructive/30',
                                )}
                                data-testid="create-drop-wallet"
                              />
                            </Field>
                          )
                        }}
                      </form.Field>
                      <form.Field name="walletUsdtLabel">
                        {(field) => (
                          <Field label="Лейбл кошелька">
                            <Input
                              placeholder="Основной"
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
                              : 'ФИО получателя минимум 3 символа'
                          },
                        }}
                      >
                        {(field) => {
                          const showError =
                            field.state.meta.isTouched && field.state.meta.isDirty
                          const err = showError ? field.state.meta.errors[0] : undefined
                          return (
                            <Field label="ФИО получателя (ФОП)" error={err} required>
                              <Input
                                placeholder="Иванов Иван Иванович"
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                                onBlur={field.handleBlur}
                                className={cn(
                                  err &&
                                    'border-destructive focus-visible:ring-destructive/30',
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
                              : 'IBAN должен быть в формате UA + 27 цифр'
                          },
                        }}
                      >
                        {(field) => {
                          const showError =
                            field.state.meta.isTouched && field.state.meta.isDirty
                          const err = showError ? field.state.meta.errors[0] : undefined
                          return (
                            <Field label="IBAN" error={err} required>
                              <Input
                                placeholder="UA000000000000000000000000000"
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                                onBlur={field.handleBlur}
                                className={cn(
                                  err &&
                                    'border-destructive focus-visible:ring-destructive/30',
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
                              : 'РНОКПП должен быть 10 цифр'
                          },
                        }}
                      >
                        {(field) => {
                          const showError =
                            field.state.meta.isTouched && field.state.meta.isDirty
                          const err = showError ? field.state.meta.errors[0] : undefined
                          return (
                            <Field label="РНОКПП (ИНН ФОП)" error={err} required>
                              <Input
                                placeholder="1234567890"
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                                onBlur={field.handleBlur}
                                className={cn(
                                  err &&
                                    'border-destructive focus-visible:ring-destructive/30',
                                )}
                              />
                            </Field>
                          )
                        }}
                      </form.Field>
                      <form.Field name="bankUahBankName">
                        {(field) => (
                          <Field label="Банк (опционально)">
                            <Input
                              placeholder="ПриватБанк"
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

            {/* Team — обязательно (drop-team создаётся атомарно вместе с дропом) */}
            <Section title="Команда дропа">
              <HrChipsField
                hrUsers={hrUsers}
                selectedIds={selectedHrIds}
                onChange={setSelectedHrIds}
                required
                onlyHr={hrUsers.length === 1}
              />

              <AccountantChipField
                accountantUsers={accountantUsers}
                selectedId={selectedAccountantId}
                onChange={setSelectedAccountantId}
                onlyAccountant={accountantUsers.length === 1}
              />

              <form.Field
                name="telegramChannel"
                validators={{
                  onBlur: ({ value, fieldApi }) => {
                    if (!fieldApi.state.meta.isDirty) return undefined
                    const trimmed = value.trim()
                    if (!trimmed) return undefined
                    return /^@?[a-zA-Z0-9_]{5,32}$/.test(trimmed)
                      ? undefined
                      : 'Некорректный канал (5–32 латинских символов или _, опц. @)'
                  },
                }}
              >
                {(field) => {
                  const showError =
                    field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
                  return (
                    <Field
                      label="Telegram-канал команды"
                      error={err}
                      hint={err ? undefined : 'Опционально. Канал для общения команды.'}
                    >
                      <div className="relative">
                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Send className="h-3.5 w-3.5" />
                          t.me/
                        </span>
                        <Input
                          placeholder="team_channel"
                          className={cn(
                            'pl-16',
                            err &&
                              'border-destructive focus-visible:ring-destructive/30',
                          )}
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          autoComplete="off"
                          data-testid="create-drop-team-telegram-channel"
                        />
                      </div>
                    </Field>
                  )
                }}
              </form.Field>
            </Section>
          </div>
        </CrmDialogBody>

        <CrmDialogFooter className="items-center justify-between">
          <Badge variant={ROLE_VARIANT.DROP} className="text-[11px]">
            {ROLE_LABELS.DROP}
          </Badge>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleClose}>
              Отмена
            </Button>
            <Button
              onClick={() => void form.handleSubmit()}
              disabled={mutation.isPending}
              data-testid="create-drop-submit"
            >
              {mutation.isPending ? 'Создание...' : 'Создать'}
            </Button>
          </div>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
