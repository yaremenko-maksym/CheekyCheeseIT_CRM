import type { Value as PhoneValue } from 'react-phone-number-input'
import type { Locale, PaymentMethod, TeamMode, UserProfileDto } from '@crm/shared'
import { type Currency } from '@/components/ui/amount-currency-input'
import { type Role } from '../constants'
import { defaultPaymentMethod } from './validation'

/**
 * Single source of the UserDialog form default values. Used by BOTH the
 * initial `useForm({ defaultValues })` (create, or edit before the re-seed
 * effect runs) and the edit-mode `form.reset(...)` re-seed, so the two can
 * never drift apart.
 *
 * `editingUser === null` -> blank create defaults (role falls back to SENIOR
 * for HR-only creation, JUNIOR otherwise).
 */
export function buildUserDialogDefaults(
  editingUser: UserProfileDto | null,
  opts: { hrOnly: boolean },
) {
  const role: Role = (editingUser?.role as Role) ?? (opts.hrOnly ? 'SENIOR' : 'JUNIOR')
  const paymentMethod: PaymentMethod =
    (editingUser?.paymentMethod as PaymentMethod | null) ?? defaultPaymentMethod(role)

  return {
    email: editingUser?.email ?? '',
    // §4.4 — ADMIN-entered at creation only (no edit-mode default: the
    // spec's decision 7 restricts this field to the create flow).
    // §4.4 — create-only field, always blank on re-seed for Edit mode.
    // This instance is mounted with `mode="edit"` HARDCODED at its call
    // site (routes/_authenticated/users/index.tsx renders a SEPARATE
    // `<UserDialog mode="create" .../>` for creation) — `isCreate` is
    // therefore always false for the lifetime of this component, the
    // personalEmail `form.Field` above is gated on `isCreate &&` and so
    // never renders here, and the only reader of `value.personalEmail`
    // is the CREATE submit handler's payload builder, which this
    // instance's onSubmit branch never reaches either. The VALUE here
    // cannot become observable through any path — kept only because
    // `form.reset()`'s argument is the full form-values shape.
    personalEmail: '',
    displayName: editingUser?.displayName ?? '',
    role,
    // task-i18n-stage2 (Task 3, Step 6) — create-wizard-only field (this
    // dialog's Edit mode never sends it: `adminUpdateUserSchema` has no
    // `locale`, matching the profile-view/create-wizard scope decision
    // recorded in `profile-view.util.ts`'s `FilteredUser` comment). Default
    // 'uk' matches `createUserSchema`'s own server-side default.
    // Same reasoning as `personalEmail` immediately above: the
    // `locale` `form.Field` is gated on `isCreate &&` and this
    // mode="edit"-locked instance's onSubmit branch never reads
    // `value.locale`. Kept only because `form.reset()`'s argument is
    // the full form-values shape.
    locale: 'uk' as Locale,
    telegram: editingUser?.telegram ?? '',
    phone: ((editingUser?.phone as PhoneValue | undefined) ?? '') as PhoneValue | '',
    techStack: (editingUser?.techStack ?? []) as string[],
    seniorSharePercent: editingUser?.seniorSharePercent ?? 26,
    monthlySalary: editingUser?.monthlySalary ?? '',
    salaryCurrency: ((editingUser?.salaryCurrency as Currency | undefined) ?? 'USD') as Currency,
    projectId: '' as string,
    // Payment requisites (ut-14)
    paymentMethod,
    walletUsdtErc20: editingUser?.walletUsdtErc20 ?? '',
    walletUsdtLabel: editingUser?.walletUsdtLabel ?? '',
    bankUahRecipient: editingUser?.bankUahRecipient ?? '',
    bankUahIban: editingUser?.bankUahIban ?? '',
    bankUahRnokpp: editingUser?.bankUahRnokpp ?? '',
    bankUahBankName: editingUser?.bankUahBankName ?? '',
    // ut-17: SENIOR-only Telegram channel of the senior's team. Resolved from
    // the senior's team in the `allTeams` query (useEffect in UserDialog).
    // Empty string when no channel set or non-SENIOR. Re-seeded again by the
    // allTeams effect once the query resolves.
    teamTelegramChannel: '' as string,
    // Drop role - phase 1 (AC3): senior create mode picker. Default
    // `CREATE_NEW` preserves the legacy senior-team auto-create path
    // 1:1 — backend service also defaults to CREATE_NEW when this
    // field is omitted (defense-in-depth). In edit mode the field is
    // ignored — re-seed to default for safety.
    teamMode: 'CREATE_NEW' as TeamMode,
    dropTeamId: '' as string,
    // DROP role — share % the drop keeps from each payout. Default 5
    // matches the spec and `createDropSchema` default.
    dropSharePercent: editingUser?.dropSharePercent ?? 5,
    // DROP role — optional Telegram channel of the drop-team (same
    // regex as the SENIOR team telegram channel).
    teamTelegramChannelDrop: '' as string,
    // Данные для контракта — юридическое ФИО (задаётся ADMIN, используется в MSA)
    legalFullName: editingUser?.legalFullName ?? '',
    // ФОП юридические данные для контракта
    registrationAddress: editingUser?.registrationAddress ?? '',
  }
}
