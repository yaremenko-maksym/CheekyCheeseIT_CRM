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
 *
 * `EXEMPT_FIELDS` is a `key -> reason` map, not a bare list (PR #481 review
 * round 2, MED finding): a mutation test proved that moving a REAL money/
 * wallet field into a bare exempt list is caught by nothing — the guard only
 * ever checked "is this key present", never "is this exemption legitimate".
 * Two checks close that gap (`mobile-keyboard-fields.spec.ts`):
 *   1. every reason must be a substantive, non-empty explanation (a one-word
 *      or empty "reason" fails) — raises the cost of a lazy fake exemption.
 *   2. a key whose own text contains a money/contact-data keyword
 *      (`SENSITIVE_KEYWORDS`) is refused unless ALSO listed in
 *      `ACKNOWLEDGED_SENSITIVE_EXEMPTIONS` with its own reason addressing
 *      the keyword specifically — this is the check that would have caught
 *      the reviewer's exact repro (`testid:amount-currency-amount-input`
 *      moved into the exempt list): the key text itself can't be faked
 *      without renaming the real `data-testid` in source, which breaks
 *      every other selector targeting that field.
 * No automated check can fully replace human review of a registry the
 * developer controls — this raises the bar, it does not claim to close the
 * gap completely.
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
  'testid:amount-currency-amount-input': 'MONEY', // AmountCurrencyInput — money/rate everywhere
  'app/components/ui/phone-input.tsx#1': 'PHONE', // PhoneInput's underlying text input
  'app/components/ui/share-slider.tsx#2': 'INTEGER_SPINNER', // % share number input (paired with range slider)
  'app/components/ui/slider-number-input.tsx#2': 'INTEGER_SPINNER', // generic number input (paired with range slider)

  // ---- ui/image-upload-field.tsx ----
  'testid:image-upload-field-url-input': 'URL',

  // ---- contracts/AddCustomVariableDialog.tsx ----
  'testid:cv-key-input': 'HANDLE', // latin/camelCase variable key

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

  // ---- user-profile/resume/ResumeTab.tsx (task-resume-base) ----
  // Portfolio / GitHub / mailto link on a senior's resume. Classified (not
  // exempted) precisely BECAUSE it is a URL: iOS autocapitalisation and
  // autocorrect corrupt pasted addresses, and the server only accepts
  // https:/mailto: — a "corrected" value is a rejected value.
  'app/components/user-profile/resume/ResumeTab.tsx#name:resumeLinkUrl': 'URL',
}

/**
 * Fields deliberately left plain — free text (descriptions, notes,
 * fictional legend/cover-story details, dynamic per-template custom
 * values, type-to-confirm boxes, …). Every entry is named explicitly so a
 * NEW field never lands here implicitly, AND every entry carries its own
 * substantive reason (checked by the guard — see module doc).
 */
export const EXEMPT_FIELDS: Record<string, string> = {
  // ---- archive/ArchiveConfirmDialog.tsx + users/ArchiveConfirmDialog.tsx ----
  'testid:archive-confirm-input':
    'Type-to-confirm box — user retypes an existing name to confirm a destructive action; not a data field, and autofill would defeat the point of typing it manually.',
  'testid:archive-confirm-name-input':
    'Same type-to-confirm pattern as archive-confirm-input, in the users list archive dialog.',

  // ---- user-profile/admin-actions/ArchiveUserDialog.tsx ----
  'app/components/user-profile/admin-actions/ArchiveUserDialog.tsx#1':
    "Type-to-confirm box (retype the profile owner's display name) before archiving — same pattern as archive-confirm-input.",

  // ---- user-profile/admin-actions/AdminNoteDialog.tsx ----
  'app/components/user-profile/admin-actions/AdminNoteDialog.tsx#1':
    'Free-text internal admin note about the profile — arbitrary prose, no taxonomy class applies.',

  // ---- job-sourcing/JobSuggestionDialog.tsx ----
  'testid:job-exclusion-input':
    'Company name or stop-word the user types to exclude a vacancy («EPAM», «gambling», «ТОВ Ромашка») — arbitrary free text in any alphabet; no numeric/contact taxonomy class applies and autofill would offer the wrong kind of value.',

  // ---- contracts/AddCustomVariableDialog.tsx ----
  'testid:cv-label-input':
    'Russian display label the admin types for a custom contract variable (e.g. "Город подписания") — free text, not an identifier.',
  'testid:cv-default-input':
    'Example default value for a custom contract variable — arbitrary free text (could be a city, a date spelled out, anything the template author wants).',

  // ---- contracts/VariablesPanel.tsx ----
  'app/components/contracts/VariablesPanel.tsx#1':
    "Inline rename of a contract variable's display label — same free-text Russian label as cv-label-input.",

  // ---- ui/input.tsx + ui/textarea.tsx ----
  'app/components/ui/input.tsx#1':
    "The base Input wrapper's OWN inner native <input> — its `type` is forwarded dynamically from whatever caller renders <Input>, never a literal, so this node itself can never satisfy a category; every call site is scanned separately.",
  'app/components/ui/textarea.tsx#1':
    "Same as ui/input.tsx#1 — the base Textarea wrapper's own inner native <textarea>, props forwarded dynamically from the caller.",

  // ---- user-profile/contract/ContractFillForm.tsx ----
  'app/components/user-profile/contract/ContractFillForm.tsx#1':
    'Dynamic per-template custom contract value (v.key/v.label come from the template author) — content type is not statically knowable, could be a city, a date, anything.',

  // ---- projects/ProjectCredentialsSection.tsx ----
  'testid:credentials-input-label':
    'Free-text service name for a saved credential (e.g. "GitHub", "Jira") — a nickname the user picks, not a data value.',
  'testid:credentials-input-notes': 'Free-text notes field attached to a saved credential entry.',

  // ---- projects/ProjectLegendSection.tsx (per-project legend/cover story) ----
  'testid:legend-entry-input':
    'Free-text journal entry in the legend/cover-story timeline (e.g. "client asked about education, we said MSU").',
  'testid:legend-input-dob':
    'Fictional cover-story date of birth typed as free text — no existing date-picker is used here, and the task explicitly says not to invent one.',
  'testid:legend-input-presented-role':
    'Fictional job title presented to the client as part of the cover story — free text.',
  'testid:legend-input-presented-stack':
    'Fictional tech stack presented to the client as part of the cover story — free text.',
  'testid:legend-input-address':
    'Fictional home address for the cover-story persona — despite the word "address" this is NOT a crypto wallet address, just prose like a street/city.',
  'testid:legend-input-backstory':
    'Fictional backstory prose for the cover-story persona — free text by definition.',
  'testid:legend-input-hobbies': 'Fictional hobbies list for the cover-story persona — free text.',
  'testid:legend-input-notes':
    'Free-text internal notes attached to the per-project legend/cover story.',

  // ---- user-profile/self-edit/RequisitesEditForm.tsx ----
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:walletUsdtLabel':
    'Free-text NICKNAME for a saved wallet (e.g. "Основной") — not the address itself. The actual address field is id:walletUsdtErc20, classified WALLET_HASH above. See ACKNOWLEDGED_SENSITIVE_EXEMPTIONS below (key contains "wallet").',
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:bankName':
    'Free-text bank name (e.g. "ПриватБанк") the user types for their own reference — not a validated identifier like the IBAN/RNOKPP fields nearby.',

  // ---- users/UserDialog.tsx ----
  'testid:user-dialog-registration-address':
    'Free-text ФОП registration address ("г. Киев, ул. Крещатик, 1") used verbatim in the generated contract — prose, not a wallet/crypto address.',
  'app/components/users/UserDialog.tsx#7':
    "walletUsdtLabel (no testid on this occurrence) — same free-text nickname field as RequisitesEditForm's walletUsdtLabel, admin-create-user variant.",
  'app/components/users/UserDialog.tsx#11':
    "bankUahBankName (no testid on this occurrence) — same free-text bank-name field as RequisitesEditForm's bankName, admin-create-user variant.",

  // ---- routes/_authenticated/legend.tsx (default persona template) ----
  'app/routes/_authenticated/legend.tsx#id:persona-address':
    "Fictional default-template address — same reasoning as ProjectLegendSection's legend-input-address (prose, not a wallet address).",
  'app/routes/_authenticated/legend.tsx#id:persona-hobbies':
    'Fictional default-template hobbies — free text.',
  'app/routes/_authenticated/legend.tsx#id:cover-role':
    'Fictional default-template presented job title — free text.',
  'app/routes/_authenticated/legend.tsx#id:cover-stack':
    'Fictional default-template presented tech stack — free text.',
  'app/routes/_authenticated/legend.tsx#id:cover-backstory':
    'Fictional default-template backstory prose — free text.',
  'testid:legend-entry-textarea':
    "Free-text journal entry field on the default persona template page — same as ProjectLegendSection's legend-entry-input.",

  // ---- routes/_authenticated/projects/index.tsx ----
  'app/routes/_authenticated/projects/index.tsx#2':
    'Название проекта — free-text project name, no taxonomy class applies.',
  'app/routes/_authenticated/projects/index.tsx#3': 'Компания — free-text client company name.',
  'app/routes/_authenticated/projects/index.tsx#5':
    'Dynamic labels[fieldName] (techStack/teamSize/benefits/salaryReview/corpTech) — content type varies per field, all free text by design.',
  'app/routes/_authenticated/projects/index.tsx#6':
    'Общие заметки — free-text general notes textarea.',

  // ---- routes/_authenticated/projects/$projectId.tsx ----
  'app/routes/_authenticated/projects/$projectId.tsx#1':
    'Название проекта (edit form) — same free-text project name as projects/index.tsx#2.',
  'app/routes/_authenticated/projects/$projectId.tsx#2':
    'Компания (edit form) — same free-text company name as projects/index.tsx#3.',
  'app/routes/_authenticated/projects/$projectId.tsx#3':
    'Dynamic labels[fieldName] (edit form) — same as projects/index.tsx#5.',
  'app/routes/_authenticated/projects/$projectId.tsx#4':
    'Общие заметки (edit form) — same free-text notes textarea as projects/index.tsx#6.',

  // ---- routes/_authenticated/finance/index.tsx ----
  'testid:delete-tx-reason-input':
    'Free-text reason typed before deleting a transaction — a human-readable justification, not a data value.',
  'testid:restore-tx-reason-input':
    'Free-text reason typed before restoring a deleted transaction.',

  // ---- routes/_authenticated/team/$teamId.tsx ----
  'app/routes/_authenticated/team/$teamId.tsx#id:edit-name': 'Free-text team name.',
  'app/routes/_authenticated/team/$teamId.tsx#id:edit-notes': 'Free-text internal team notes.',

  // ---- finance dialogs — free-text notes ----
  'app/routes/_authenticated/finance/components/dialogs/EditSeniorIncomeDialog.tsx#1':
    'Free-text "Заметки" field on the senior-income edit dialog.',
  'testid:pay-salary-notes': 'Free-text "Заметки" field on the pay-salary dialog.',
  'testid:payout-detail-manual-note': 'Free-text note describing a manual payout confirmation.',
  'app/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx#3':
    'Free-text "Заметки" field on the create-transaction dialog (non-dividend types).',
  'app/routes/_authenticated/finance/components/dialogs/ValidateDialog.tsx#1':
    'Free-text rejection reason typed by ACCOUNTANT when rejecting a transaction.',
  'app/routes/_authenticated/finance/components/dialogs/AdminEditTransactionDialog.tsx#1':
    'Salary month typed as a raw "2025-03" string — no existing date-picker component is used here, and the task explicitly says not to invent a new one for this PR.',
  'app/routes/_authenticated/finance/components/dialogs/AdminEditTransactionDialog.tsx#2':
    'Free-text "Заметки" field on the admin edit-transaction dialog.',

  // ---- interviews — free-text company/notes fields ----
  'app/routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx#1':
    'Название проекта — same free-text project name as elsewhere.',
  'app/routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx#2':
    'Компания — same free-text company name as elsewhere.',
  'app/routes/_authenticated/interviews/components/CreateInterviewDialog.tsx#1':
    'Компания — free-text company name on the create-interview dialog.',
  'app/routes/_authenticated/interviews/components/InterviewDetailSheet.tsx#1':
    'The local FieldRow Textarea — every textarea call site on this sheet is a free-text notes/description field by construction (the URL-capable one is the separate Input node, classified URL above).',

  // ---- vacancies — free-text title/description/SEO fields ----
  'testid:vacancy-form-title': 'Free-text vacancy title.',
  'testid:vacancy-form-skills': 'Free-text comma-separated skills list.',
  'testid:vacancy-form-qualifications':
    'Free-text qualifications prose for Google-for-Jobs enrichment.',
  'testid:vacancy-form-responsibilities':
    'Free-text responsibilities prose for Google-for-Jobs enrichment.',
  'testid:vacancy-form-job-benefits': 'Free-text benefits prose for Google-for-Jobs enrichment.',
  'testid:vacancy-form-work-hours': 'Free-text work-hours description (e.g. "40 часов в неделю").',
  'app/routes/_authenticated/vacancies/components/VacancyTranslationFields.tsx#1':
    'Per-locale vacancy title (dynamic testid per locale) — free-text translation.',
  'app/routes/_authenticated/vacancies/components/VacancyTranslationFields.tsx#2':
    'Per-locale vacancy description markdown (dynamic testid per locale) — free-text translation.',

  // ---- ui/tech-autocomplete-input.tsx ----
  'app/components/ui/tech-autocomplete-input.tsx#1':
    'Tag/chip type-ahead filter input for technology names — not a data-entry field in the taxonomy sense, it drives an autocomplete dropdown.',

  // ---- user-profile/resume/** (task-resume-base) ----
  // A resume is prose end to end. The ONLY structured value anywhere in it is
  // the link URL, which is classified URL in FIELD_CATEGORIES above — every
  // field below is genuinely free text a person writes in their own words.
  'testid:resume-summary-input':
    'Раздел «О себе» — free-form prose the senior writes about themselves; no taxonomy class applies.',
  'testid:resume-skills-input':
    'Newline-separated list of skill names ("TypeScript", "Проектирование систем") — arbitrary words in either alphabet, not identifiers.',
  'testid:resume-text-input':
    'Paste-the-whole-resume fallback textarea used when a PDF has no text layer — an entire CV as prose.',
  'app/components/user-profile/resume/ResumeExperienceEditor.tsx#name:resumeExperienceRole':
    'Job title as written on the resume ("Технический лидер") — free text, and autocapitalising it is if anything desirable.',
  'app/components/user-profile/resume/ResumeExperienceEditor.tsx#name:resumeExperienceCompany':
    'Employer name ("Акме Технологии") — a proper noun in free text, not an identifier.',
  'app/components/user-profile/resume/ResumeExperienceEditor.tsx#name:resumeExperiencePeriod':
    'Deliberately free-form employment period ("2021 — наст. время") — the schema stores it as a string, not a date range, so no numeric/date keyboard fits.',
  'app/components/user-profile/resume/ResumeExperienceEditor.tsx#name:resumeExperienceBullets':
    'Achievements, one per line — prose sentences.',
  'app/components/user-profile/resume/ResumeTab.tsx#name:resumeLinkLabel':
    'Human-readable caption for a link ("GitHub", "Портфолио") — free text. The URL beside it is classified URL in FIELD_CATEGORIES.',
  'app/components/user-profile/resume/ResumeTab.tsx#name:resumePairField':
    'Shared field of the education/languages rows (institution, degree, period, language, level) — every column is free-text prose.',
}

/**
 * Money/contact-data-shaped substrings. A key in `EXEMPT_FIELDS` that
 * contains one of these (case-insensitive) is refused unless also present
 * in `ACKNOWLEDGED_SENSITIVE_EXEMPTIONS` — see module doc.
 */
export const SENSITIVE_KEYWORDS = [
  'amount',
  'wallet',
  'iban',
  'phone',
  'email',
  'hash',
  'password',
  'salary',
] as const

/**
 * Explicit, individually-justified override for a legitimate EXEMPT_FIELDS
 * entry whose key happens to contain a SENSITIVE_KEYWORDS substring. The
 * reason here must address the keyword specifically (why THIS field,
 * despite looking sensitive by name, really is free text) — checked for
 * substance by the same guard that checks EXEMPT_FIELDS reasons.
 */
export const ACKNOWLEDGED_SENSITIVE_EXEMPTIONS: Record<string, string> = {
  'app/components/user-profile/self-edit/RequisitesEditForm.tsx#id:walletUsdtLabel':
    'Key contains "wallet" only because this field sits next to the wallet address field in the same form section — it is the free-text NICKNAME (e.g. "Основной"), never the address. The address itself is id:walletUsdtErc20, which IS classified WALLET_HASH in FIELD_CATEGORIES above.',
  'testid:pay-salary-notes':
    'Key contains "salary" only because the testid is scoped to the PaySalaryDialog component name — this is that dialog\'s free-text "Заметки" note field, not the salary amount itself (which goes through AmountCurrencyInput, classified MONEY separately).',
}
