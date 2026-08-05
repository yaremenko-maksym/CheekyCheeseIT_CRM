/**
 * mobile-keyboard-registry.ts — task-mobile-keyboards.md taxonomy, encoded.
 *
 * Classification is INVERTED on purpose (task §1): `EXEMPT_FIELDS` names
 * every field that's genuinely free text (descriptions, notes, fictional
 * "legend" cover-story details, dynamic per-template values whose content
 * type isn't statically knowable, …) — everything else found by the scanner
 * MUST resolve to exactly one entry in `FIELD_CATEGORIES`. A brand-new field
 * that lands in neither list fails the guard (`mobile-keyboard-fields.spec.ts`)
 * by construction — "новое поле по умолчанию под строгим правилом".
 *
 * Field identity (see `input-scan.ts`): `data-testid` > `id` > `name` >
 * `${file}#${n}` (nth field in that file, source order) when the JSX node
 * carries none of the three. Most fields below key off a stable
 * testid/id/name; the occurrence-index fallback is used only where the
 * source genuinely has none (noted inline).
 *
 * A single registry entry can cover MANY runtime call sites when they share
 * one JSX definition (`AmountCurrencyInput`, `PhoneInput`, `ShareSlider`,
 * `SliderNumberInput`, and `InterviewDetailSheet`'s local `FieldRow` all
 * render exactly one `<Input>`/`<input>` node reused across screens) — see
 * `input-scan.ts` module doc.
 */

export type Category =
  /** Money / rates / fractional percentages — `type="text"` + `inputMode="decimal"`. */
  | 'MONEY'
  /** Integer counters WITHOUT a visible/implied spinner — `inputMode="numeric"` + `pattern="[0-9]*"`. */
  | 'INTEGER_TEXT'
  /** Integer counters paired with a range slider (spinner semantics kept) — `type="number"` + `inputMode="numeric"`. */
  | 'INTEGER_SPINNER'
  /** Phone number — `type="tel"`. */
  | 'PHONE'
  /** Own email (autofill wanted) — `type="email"` + `autoComplete="email"` + anti-autocorrect trio. */
  | 'EMAIL'
  /** Someone ELSE's email, entered by an admin on their behalf — same as EMAIL but `autoComplete="off"` (an admin's own saved email must never autofill into another person's record). */
  | 'EMAIL_NO_AUTOFILL'
  /** Link — `type="url"` + anti-autocorrect trio. */
  | 'URL'
  /** Wallet address / tx hash / bank identifier that must survive verbatim — anti-autocorrect trio + `autoComplete="off"`. */
  | 'WALLET_HASH'
  /** IBAN-shaped bank identifier — same intent as WALLET_HASH, but the schema (`/^UA\d{27}$/`, case-sensitive, untouched here) requires the letters typed IN UPPERCASE, so `autoCapitalize="characters"` (not "off") is what actually protects data integrity here. */
  | 'BANK_ID'
  /** Telegram handle / login / URL slug — free-form identifier where autocapitalize/autocorrect would corrupt the value. */
  | 'HANDLE'
  /** Full-text search box — `type="search"` + `enterKeyHint="search"`. */
  | 'SEARCH'
  /** A person's own real name (self-entry) — autofill wanted. */
  | 'PERSON_NAME'
  /** Someone ELSE's name, entered by an admin on their behalf (or a fictional "legend" persona) — same shape, but `autoComplete="off"` for the same reason as EMAIL_NO_AUTOFILL. */
  | 'PERSON_NAME_NO_AUTOFILL'
  /** Password (may toggle `type="text"`/`"password"` for a show/hide affordance). */
  | 'PASSWORD'

interface Requirement {
  describe: string
  check(attrs: import('./input-scan').ScannedAttrs): boolean
}

const ANTI_AUTOCORRECT: Requirement[] = [
  { describe: 'autoCapitalize="off"', check: (a) => a.has('autoCapitalize', 'off') },
  { describe: 'autoCorrect="off"', check: (a) => a.has('autoCorrect', 'off') },
  { describe: 'spellCheck={false}', check: (a) => a.boolValue('spellCheck') === false },
]

const TYPE_ABSENT_OR_TEXT: Requirement = {
  describe: 'type is absent or "text" (never "number")',
  check: (a) => {
    const types = a.stringValues('type')
    if (types.size === 0) return true
    return types.has('text') && !a.has('type', 'number')
  },
}

function typeIncludes(value: string): Requirement {
  return { describe: `type includes "${value}"`, check: (a) => a.has('type', value) }
}

export const CATEGORY_REQUIREMENTS: Record<Category, Requirement[]> = {
  MONEY: [
    TYPE_ABSENT_OR_TEXT,
    { describe: 'inputMode="decimal"', check: (a) => a.has('inputMode', 'decimal') },
  ],
  INTEGER_TEXT: [
    { describe: 'inputMode="numeric"', check: (a) => a.has('inputMode', 'numeric') },
    { describe: 'pattern="[0-9]*"', check: (a) => a.has('pattern', '[0-9]*') },
  ],
  INTEGER_SPINNER: [
    typeIncludes('number'),
    { describe: 'inputMode="numeric"', check: (a) => a.has('inputMode', 'numeric') },
  ],
  PHONE: [typeIncludes('tel')],
  EMAIL: [
    typeIncludes('email'),
    { describe: 'autoComplete="email"', check: (a) => a.has('autoComplete', 'email') },
    ...ANTI_AUTOCORRECT,
  ],
  EMAIL_NO_AUTOFILL: [
    typeIncludes('email'),
    { describe: 'autoComplete="off"', check: (a) => a.has('autoComplete', 'off') },
    ...ANTI_AUTOCORRECT,
  ],
  URL: [typeIncludes('url'), ...ANTI_AUTOCORRECT],
  WALLET_HASH: [
    ...ANTI_AUTOCORRECT,
    { describe: 'autoComplete="off"', check: (a) => a.has('autoComplete', 'off') },
  ],
  BANK_ID: [
    {
      describe: 'autoCapitalize="characters"',
      check: (a) => a.has('autoCapitalize', 'characters'),
    },
    { describe: 'autoCorrect="off"', check: (a) => a.has('autoCorrect', 'off') },
    { describe: 'spellCheck={false}', check: (a) => a.boolValue('spellCheck') === false },
  ],
  HANDLE: [
    { describe: 'autoCapitalize="off"', check: (a) => a.has('autoCapitalize', 'off') },
    { describe: 'autoCorrect="off"', check: (a) => a.has('autoCorrect', 'off') },
  ],
  SEARCH: [
    typeIncludes('search'),
    { describe: 'enterKeyHint="search"', check: (a) => a.has('enterKeyHint', 'search') },
  ],
  PERSON_NAME: [
    { describe: 'autoCapitalize="words"', check: (a) => a.has('autoCapitalize', 'words') },
    {
      describe: 'autoComplete is name/given-name/family-name',
      check: (a) =>
        a.has('autoComplete', 'name') ||
        a.has('autoComplete', 'given-name') ||
        a.has('autoComplete', 'family-name'),
    },
  ],
  PERSON_NAME_NO_AUTOFILL: [
    { describe: 'autoCapitalize="words"', check: (a) => a.has('autoCapitalize', 'words') },
    { describe: 'autoComplete="off"', check: (a) => a.has('autoComplete', 'off') },
  ],
  PASSWORD: [typeIncludes('password'), ...ANTI_AUTOCORRECT],
}

/**
 * file -> category. Keys match `ScannedField.key` from `input-scan.ts`.
 * Comment on each line names the field for humans reviewing a diff.
 */
export const FIELD_CATEGORIES: Record<string, Category> = {
  // ---- Shared components (fix once, covers every call site) ----
  'app/components/ui/amount-currency-input.tsx#1': 'MONEY', // AmountCurrencyInput — money/rate everywhere
  'app/components/ui/phone-input.tsx#1': 'PHONE', // PhoneInput's underlying text input
  'app/components/ui/share-slider.tsx#2': 'INTEGER_SPINNER', // % share number input (paired with range slider)
  'app/components/ui/slider-number-input.tsx#2': 'INTEGER_SPINNER', // generic number input (paired with range slider)

  // ---- ui/image-upload-field.tsx ----
  'testid:image-upload-field-url-input': 'URL',

  // ---- contracts/AddCustomVariableDialog.tsx ----
  'app/components/contracts/AddCustomVariableDialog.tsx#id:cv-key': 'HANDLE', // latin/camelCase variable key

  // ---- projects/ProjectCredentialsSection.tsx ----
  'testid:credentials-input-login': 'HANDLE',
  'testid:credentials-input-password': 'PASSWORD',
  'testid:credentials-input-url': 'URL',

  // ---- projects/ProjectLegendSection.tsx (per-project legend/cover story) ----
  'testid:legend-input-fullname': 'PERSON_NAME_NO_AUTOFILL', // fictional persona name — no real-name autofill

  // ---- user-profile/tabs/FinanceTab.tsx ----
  'app/components/user-profile/tabs/FinanceTab.tsx#1': 'SEARCH',

  // ---- user-profile/self-edit/ProfileEditFields.tsx (self-edit — real autofill wanted) ----
  'app/components/user-profile/self-edit/ProfileEditFields.tsx#id:displayName': 'PERSON_NAME',
  // #id:email is `disabled` + `readOnly` (auth-controlled, never editable) — auto-exempt, no entry needed.
  'app/components/user-profile/self-edit/ProfileEditFields.tsx#id:telegram': 'HANDLE',

  // ---- user-profile/self-edit/RequisitesEditForm.tsx (own payout requisites) ----
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:walletUsdtErc20': 'WALLET_HASH',
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:bankRecipient': 'PERSON_NAME',
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:bankIban': 'BANK_ID',
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:bankRnokpp': 'INTEGER_TEXT',

  // ---- finance/ConfirmPayoutDialog.tsx ----
  'testid:confirm-payout-tx-hash': 'WALLET_HASH',

  // ---- users/UserDialog.tsx (admin creating/editing ANOTHER person's record) ----
  'testid:user-dialog-email': 'EMAIL_NO_AUTOFILL',
  'testid:user-dialog-name': 'PERSON_NAME_NO_AUTOFILL',
  'testid:user-dialog-legal-full-name': 'PERSON_NAME_NO_AUTOFILL',
  'app/components/users/UserDialog.tsx#5': 'HANDLE', // "Telegram" contact field — no testid on this one
  'testid:user-dialog-wallet': 'WALLET_HASH',
  'testid:user-dialog-bank-recipient': 'PERSON_NAME_NO_AUTOFILL',
  'testid:user-dialog-bank-iban': 'BANK_ID',
  'testid:user-dialog-bank-rnokpp': 'INTEGER_TEXT',
  'testid:user-dialog-drop-team-telegram-channel': 'HANDLE',
  'testid:user-dialog-team-telegram-channel': 'HANDLE',

  // ---- routes/_authenticated/legend.tsx (default persona template — fictional) ----
  'app/routes/_authenticated/legend.tsx#id:persona-fullName': 'PERSON_NAME_NO_AUTOFILL',

  // ---- search boxes (toolbar filters across list pages) ----
  'testid:projects-search-input': 'SEARCH',
  'testid:documents-search': 'SEARCH',
  'testid:login-as-search': 'SEARCH',
  'app/routes/_authenticated/finance/index.tsx#1': 'SEARCH',
  'app/routes/_authenticated/team/index.tsx#4': 'SEARCH',
  'app/routes/_authenticated/users/index.tsx#1': 'SEARCH',

  // ---- routes/_authenticated/team/index.tsx (create-senior form — admin fills ANOTHER person's data) ----
  'app/routes/_authenticated/team/index.tsx#1': 'EMAIL_NO_AUTOFILL',
  'app/routes/_authenticated/team/index.tsx#2': 'PERSON_NAME_NO_AUTOFILL',
  'app/routes/_authenticated/team/index.tsx#3': 'HANDLE',

  // ---- routes/_authenticated/admin/ChangeWalletAddressDialog.tsx ----
  'app/routes/_authenticated/admin/ChangeWalletAddressDialog.tsx#2': 'WALLET_HASH', // "Новый адрес" — #1 (current, readOnly) is auto-exempt

  // ---- routes/_authenticated/team/$teamId.tsx ----
  'app/routes/_authenticated/team/$teamId.tsx#id:edit-telegram': 'URL', // validated as an https://t.me/... link, not a handle

  // ---- routes/_authenticated/finance/components/ReceiptInput.tsx ----
  'testid:receipt-input-url-field': 'URL',

  // ---- routes/_authenticated/finance/components/dialogs/PayoutPaymentForm.tsx ----
  'testid:payout-detail-tx-hash-input': 'WALLET_HASH',
  'testid:payout-detail-manual-tx-hash': 'WALLET_HASH',

  // ---- routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx ----
  'testid:create-transaction-dividend-amount': 'MONEY', // already compliant pre-existing inputMode="decimal"

  // ---- routes/_authenticated/interviews/components/CreateInterviewDialog.tsx ----
  'app/routes/_authenticated/interviews/components/CreateInterviewDialog.tsx#2': 'URL', // "Ссылка на вакансию"
  'app/routes/_authenticated/interviews/components/CreateInterviewDialog.tsx#3': 'URL', // "Ссылка на звонок"

  // ---- routes/_authenticated/interviews/components/InterviewDetailSheet.tsx ----
  // local `FieldRow` — one shared <Input>; reaches `type="url"` only when
  // `inputType="url"` is passed (currently just the vacancyUrl field).
  'app/routes/_authenticated/interviews/components/InterviewDetailSheet.tsx#2': 'URL',

  // ---- routes/_authenticated/vacancies/components/VacancyFormFields.tsx ----
  'testid:vacancy-form-slug': 'HANDLE',

  // ---- routes/_authenticated/vacancies/components/VacancySalaryFields.tsx ----
  'testid:vacancy-form-salary-min': 'MONEY',
  'testid:vacancy-form-salary-max': 'MONEY',

  // ---- routes/_authenticated/vacancies/components/VacancySeoFields.tsx ----
  'testid:vacancy-form-experience-months': 'INTEGER_SPINNER',

  // ---- user-profile/AvatarUploadDialog.tsx ----
  'app/components/user-profile/AvatarUploadDialog.tsx#2': 'URL', // avatar-by-URL tab
}

/**
 * Fields deliberately left plain — free text (descriptions, notes,
 * fictional legend/cover-story details, dynamic per-template custom
 * values, type-to-confirm boxes, …). Every entry is named explicitly so a
 * NEW field never lands here implicitly.
 */
export const EXEMPT_FIELDS = new Set<string>([
  // ---- archive/ArchiveConfirmDialog.tsx + users/ArchiveConfirmDialog.tsx — type-to-confirm text (must match a name, not autofill-worthy) ----
  'app/components/archive/ArchiveConfirmDialog.tsx#1',
  'testid:archive-confirm-name-input', // users/ArchiveConfirmDialog.tsx

  // ---- user-profile/admin-actions/ArchiveUserDialog.tsx — same type-to-confirm pattern ----
  'app/components/user-profile/admin-actions/ArchiveUserDialog.tsx#1',

  // ---- user-profile/admin-actions/AdminNoteDialog.tsx — free-text internal note ----
  'app/components/user-profile/admin-actions/AdminNoteDialog.tsx#1',

  // ---- contracts/AddCustomVariableDialog.tsx — Russian display label + example default value ----
  'app/components/contracts/AddCustomVariableDialog.tsx#id:cv-label',
  'app/components/contracts/AddCustomVariableDialog.tsx#id:cv-default',

  // ---- contracts/VariablesPanel.tsx — inline rename of a variable's display label ----
  'app/components/contracts/VariablesPanel.tsx#1',

  // ---- user-profile/contract/ContractFillForm.tsx — dynamic per-template custom value (any content type) ----
  'app/components/user-profile/contract/ContractFillForm.tsx#1',

  // ---- projects/ProjectLegendSection.tsx — per-project legend/cover story (all free text) ----
  'testid:legend-input-dob',
  'testid:legend-input-presented-role',
  'testid:legend-input-presented-stack',
  'testid:legend-input-address',
  'testid:legend-input-backstory',
  'testid:legend-input-hobbies',
  'testid:legend-input-notes',
  // the "add legend entry" journal textarea has no id/testid of its own:
  'app/components/projects/ProjectLegendSection.tsx#1',

  // ---- user-profile/self-edit/RequisitesEditForm.tsx — free-text labels ----
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:walletUsdtLabel',
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:bankName',

  // ---- users/UserDialog.tsx — free text (registration address, wallet label, bank name) ----
  'testid:user-dialog-registration-address',
  'app/components/users/UserDialog.tsx#7', // walletUsdtLabel — no testid
  'app/components/users/UserDialog.tsx#11', // bankUahBankName — no testid

  // ---- routes/_authenticated/legend.tsx — default persona template, fictional free text ----
  'app/routes/_authenticated/legend.tsx#id:persona-address',
  'app/routes/_authenticated/legend.tsx#id:persona-hobbies',
  'app/routes/_authenticated/legend.tsx#id:cover-role',
  'app/routes/_authenticated/legend.tsx#id:cover-stack',
  'app/routes/_authenticated/legend.tsx#id:cover-backstory',
  'testid:legend-entry-textarea',

  // ---- routes/_authenticated/projects/index.tsx — free-text project fields ----
  'app/routes/_authenticated/projects/index.tsx#2', // Название проекта
  'app/routes/_authenticated/projects/index.tsx#3', // Компания
  'app/routes/_authenticated/projects/index.tsx#5', // dynamic labels[fieldName]
  'app/routes/_authenticated/projects/index.tsx#6', // Общие заметки

  // ---- routes/_authenticated/projects/$projectId.tsx — same edit form, free text ----
  'app/routes/_authenticated/projects/$projectId.tsx#1',
  'app/routes/_authenticated/projects/$projectId.tsx#2',
  'app/routes/_authenticated/projects/$projectId.tsx#3',
  'app/routes/_authenticated/projects/$projectId.tsx#4',

  // ---- routes/_authenticated/finance/index.tsx — delete/restore reason text ----
  'app/routes/_authenticated/finance/index.tsx#id:delete-tx-reason',
  'app/routes/_authenticated/finance/index.tsx#id:restore-tx-reason',

  // ---- routes/_authenticated/team/$teamId.tsx — free text ----
  'app/routes/_authenticated/team/$teamId.tsx#id:edit-name',
  'app/routes/_authenticated/team/$teamId.tsx#id:edit-notes',

  // ---- finance dialogs — free-text notes ----
  'app/routes/_authenticated/finance/components/dialogs/EditSeniorIncomeDialog.tsx#1',
  'app/routes/_authenticated/finance/components/dialogs/PaySalaryDialog.tsx#1',
  'testid:payout-detail-manual-note',
  'app/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx#3',
  'app/routes/_authenticated/finance/components/dialogs/ValidateDialog.tsx#1',
  'app/routes/_authenticated/finance/components/dialogs/AdminEditTransactionDialog.tsx#1', // salary month "2025-03" — no existing date picker here, not reinventing one
  'app/routes/_authenticated/finance/components/dialogs/AdminEditTransactionDialog.tsx#2',

  // ---- interviews — free-text company/notes fields ----
  'app/routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx#1',
  'app/routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx#2',
  'app/routes/_authenticated/interviews/components/CreateInterviewDialog.tsx#1', // Компания
  'app/routes/_authenticated/interviews/components/InterviewDetailSheet.tsx#1', // FieldRow Textarea — always free text

  // ---- vacancies — free-text title/description/SEO fields ----
  'testid:vacancy-form-title',
  'testid:vacancy-form-skills',
  'testid:vacancy-form-qualifications',
  'testid:vacancy-form-responsibilities',
  'testid:vacancy-form-job-benefits',
  'testid:vacancy-form-work-hours',
  'app/routes/_authenticated/vacancies/components/VacancyTranslationFields.tsx#1', // per-locale title (dynamic testid)
  'app/routes/_authenticated/vacancies/components/VacancyTranslationFields.tsx#2', // per-locale description (dynamic testid)

  // ---- ui/tech-autocomplete-input.tsx — tag/chip type-ahead, not a taxonomy class ----
  'app/components/ui/tech-autocomplete-input.tsx#1',
])
