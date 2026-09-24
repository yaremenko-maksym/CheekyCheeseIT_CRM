import { z } from 'zod'
import type { MessageDescriptor } from '@lingui/core'

/**
 * Onboarding Phase 6A — MSA contract schemas.
 *
 * Five MSA templates exist: one per non-ADMIN role (HR, SENIOR, JUNIOR, DROP,
 * ACCOUNTANT). ADMIN bypasses the onboarding gate and never signs a contract;
 * the database enforces `contract_templates.target_role <> 'ADMIN'` via CHECK.
 *
 * Templates carry `is_active` semantics: at most one row per (target_role)
 * is active at a time. Publishing a new version atomically deactivates the
 * previous one (service layer). Signed contracts freeze the template body
 * via `bodyMarkdownSnapshot` + `variablesFilled` at signing time — the row
 * is an immutable audit trail.
 *
 * `contractNumber` follows `CHK-<seq>-<year>` (e.g. `CHK-1-2026`). The
 * sequence is server-side (`contract_number_seq`), monotonic, gaps allowed
 * on rollback.
 */

/**
 * Roles eligible to sign an MSA. ADMIN is excluded — they bypass the
 * onboarding gate entirely. Mirrors the DB CHECK constraint on
 * `contract_templates.target_role`.
 */
export const contractTargetRoleSchema = z.enum(['HR', 'SENIOR', 'JUNIOR', 'DROP', 'ACCOUNTANT'])

export const contractTemplateSchema = z.object({
  id: z.string().uuid(),
  targetRole: contractTargetRoleSchema,
  version: z.number().int().positive(),
  bodyMarkdown: z.string(),
  isActive: z.boolean(),
  createdByUserId: z.string().uuid(),
  createdAt: z.string().or(z.date()),
})

/**
 * A custom (non-system) variable that can be added to a contract template.
 * At signing time the employee fills in the value via the onboarding form.
 */
export const customVariableSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/, 'zod.VARIABLE_KEY_FORMAT'),
  label: z.string().min(1, 'zod.VARIABLE_LABEL_REQUIRED').max(200),
  defaultValue: z.string().max(500).optional(),
})

export type CustomVariable = z.infer<typeof customVariableSchema>

/**
 * ADMIN publishes a new version. Service layer atomically deactivates the
 * previous active row (per role) and inserts a new one with
 * `version = max + 1`, `isActive = true`.
 */
export const createContractTemplateSchema = z.object({
  targetRole: contractTargetRoleSchema,
  bodyMarkdown: z.string().min(1, 'zod.DOCUMENT_BODY_REQUIRED').max(100_000), // BIZ-14
  customVariables: z.array(customVariableSchema).default([]),
})

/**
 * Body for `POST /api/contracts/templates/preview-pdf` (ADMIN-only).
 *
 * Accepts the editor's CURRENT markdown so unsaved edits can be previewed
 * (no saved templateId required). The PDF preview deliberately leaves
 * `{{tokens}}` VISIBLE (no standard-variable substitution) and appends the
 * company requisites section — matching what a signed contract will look like.
 * `role` is accepted for parity with the editor (which tracks a target role)
 * and to keep the audit/telemetry shape consistent; it does not change the
 * unsigned-preview rendering.
 */
export const previewContractPdfSchema = z.object({
  bodyMarkdown: z.string().min(1, 'zod.DOCUMENT_BODY_REQUIRED').max(100_000),
  role: contractTargetRoleSchema,
})
export type PreviewContractPdfDto = z.infer<typeof previewContractPdfSchema>

export const signedContractSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  templateId: z.string().uuid(),
  bodyMarkdownSnapshot: z.string(),
  /**
   * JSONB blob of resolved template variables, frozen at signing time. Keys:
   * `employeeName`, `employeeEmail`, `role`, `onboardingDate`, `companyName`,
   * `walletUsdt`, `bankUahFop`, `preferredMethod`. Missing values stored as
   * the literal Russian string `'не указано'`.
   */
  variablesFilled: z.record(z.string(), z.string()),
  signedTypedName: z.string(),
  signedIp: z.string().nullable(),
  signedUserAgent: z.string().nullable(),
  signedAt: z.string().or(z.date()),
  /**
   * `CHK-<6 uppercase hex>` — server-generated, unique (e.g. `CHK-7F3A9C`).
   * Legacy seed rows use the old `CHK-<seq>-<year>` format and are allowed
   * through on read (the schema is used for API responses, not DB inserts).
   * Both patterns are accepted so existing seed contracts do not fail validation.
   *
   * task-i18n-stage4-task5: this message is NOT registered in `zod-errors.ts`
   * — `contractNumber` is server-generated (never typed by a person), so a
   * failure here means a corrupt/legacy DB row, not a user mistake. Same
   * carve-out as `paymentTypeStringSchema` (`projects.ts`) and
   * `notification-preferences.ts`'s response-invariant messages — left
   * English, log-only.
   */
  contractNumber: z
    .string()
    .regex(
      /^CHK-([0-9A-F]{6}|\d+-\d{4})$/,
      'Invalid contract_number (expected CHK-XXXXXX or CHK-N-YYYY for legacy rows)',
    ),
})

/**
 * Body for `POST /api/contracts/sign`. IP / UA captured server-side from
 * `req.ip` + `req.headers['user-agent']` — not part of the request body.
 *
 * A2a change: `typedName` is now optional — the backend resolves the signed
 * name from `users.legalFullName` (spec §4.3 Option A). Clients MAY still
 * send `typedName` for backward compatibility but the value is ignored.
 */
// SEC-19: .strict() rejects unknown fields so a rogue caller cannot smuggle
// extra properties past the controller boundary.
export const signContractSchema = z
  .object({
    typedName: z.string().max(200).optional(),
  })
  .strict()

export type ContractTargetRole = z.infer<typeof contractTargetRoleSchema>
export type ContractTemplateDto = z.infer<typeof contractTemplateSchema>
export type CreateContractTemplateDto = z.infer<typeof createContractTemplateSchema>
export type SignedContractDto = z.infer<typeof signedContractSchema>
export type SignContractDto = z.infer<typeof signContractSchema>

/**
 * Бэклог 212. Один литерал на СЕРВЕРНЫЙ отказ `POST /contracts/sign` под
 * «войти как» (`signed-contracts.service.ts`, `ForbiddenException`) и на
 * клиентское объяснение под кнопкой подписи (`SignContractStep.tsx`) — та же
 * форма, что уже приняли для доли (`users.service.ts`
 * `approveSeniorShareChange`/`rejectSeniorShareChange`) и для настроек
 * уведомлений (`NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE` рядом).
 *
 * Без точки: конвенция сообщений исключений `apps/api` не ставит точку
 * нигде («Инвойс уже подписан», «Нет доступа к легенде проекта»,
 * `NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE`). `SignContractStep.tsx`
 * строит СВОЙ текст добавлением точки к этому — тот же приём, что
 * `IMPERSONATION_EXPLANATION` в `NotificationSettingsTab.tsx`.
 */
export const CONTRACT_SIGN_IMPERSONATION_MESSAGE =
  'Пока вы вошли как другой сотрудник, подписать его контракт нельзя — это должен сделать он сам'

/**
 * Minimal contract DTO returned by GET /api/contracts/me.
 * Used in the JUNIOR hub to display contract status.
 * Moved from an inline interface in project.tsx to shared (task-junior-ux-3-cleanup defer #2).
 */
export const contractMeDtoSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['DRAFT', 'READY_TO_SIGN', 'SIGNED', 'CANCELLED']),
})

export type ContractMeDto = z.infer<typeof contractMeDtoSchema>

/**
 * Self contract status DTO returned by GET /api/contracts/me/status.
 * Returns the employee_contracts status for the current user (not signed_contracts list).
 * Used in JUNIOR hub to correctly show contract status — resolves the bug where
 * signed_contracts list rows lacked the \ field causing .parse() to throw.
 *
 * AC1 fix: source is employee_contracts.status, not signed_contracts.
 */
export const contractStatusMeDtoSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['DRAFT', 'READY_TO_SIGN', 'SIGNED', 'CANCELLED']),
})

export type ContractStatusMeDto = z.infer<typeof contractStatusMeDtoSchema>

/**
 * Row shape returned by GET /api/contracts/templates and
 * GET /api/contracts/templates/current/:role.
 *
 * Extracted here to serve as the single source of truth shared between
 * contracts.index.tsx (list page) and contracts.$role.tsx (editor page).
 * The `createdByUserId` field is optional in UI contexts where the API
 * may omit it for non-ADMIN callers.
 */
export interface ContractTemplateRow {
  id: string
  targetRole: ContractTargetRole
  version: number
  bodyMarkdown: string
  isActive: boolean
  createdByUserId?: string
  createdAt: string
  /** Custom (non-system) template variables. Empty array when none defined. */
  customVariables: CustomVariable[]
}

/**
 * Canonical map of template variable bare-keys → human-readable descriptions.
 *
 * Bare-key form (without `{{...}}` delimiters) is the authoritative type source.
 * Braced form is derived via CONTRACT_VARIABLE_DESCRIPTIONS_BRACED for admin hint
 * panel display and template authoring UI.
 *
 * This is the single source of truth for variable names used in:
 *   - Backend: SignedContractsService.interpolateVariables() — types the variables map
 *   - Frontend: contract-variables.ts — re-exports braced form for the admin hint panel
 *
 * `contractNumber` is generated server-side (CHK-N-YYYY) and not resolved via
 * interpolateVariables — included for admin documentation purposes only (see
 * InterpolatableVariableKey which excludes it).
 *
 * task-i18n-stage4-task5, plan Track B Task 5 Step 1 (COPY-H-shared-1): this
 * used to be `Record<string, string>` — a Russian-labelled map with five
 * already-Ukrainian entries mixed in (`registrationAddress`,
 * `companyRegNumber`, `companyVat`, `companyBank`, `companyAuthorityBasis` —
 * those five keep their existing text verbatim below, the other 19 are newly
 * translated). Same `MessageDescriptor` shape as `ZOD_ERROR_MESSAGES`, its own
 * `contract-variable.<key>` id namespace (not `zod-error.*` — this is not a
 * validation message). Two consumers resolve it, both added by this task:
 * `VariablesPanel.tsx` (client, admin hint panel — `useLingui()`) and
 * `EmployeeContractsService.getContractVariables` (server, `GET
 * /api/users/:id/contract/variables`). Fix-round 1 (COPY-H-3/CR-H-1): that
 * endpoint is `@Roles('ADMIN')` on the whole controller — an employee never
 * calls it for their own contract, an ADMIN does, filling in Screen 2 for
 * that employee. So the server resolves these descriptions on the VIEWER's
 * (the requesting admin's) locale via `@RequestLocale()`, not
 * `user.locale` (the employee whose contract it is). Every other consumer
 * (`AddCustomVariableDialog.tsx`, `contractTokenHighlight.ts`,
 * `use-contract-tokens.ts`, `contracts.$role.tsx`, `contract-variables.ts`)
 * reads only `Object.keys(...)` for the known-key set — unaffected by the
 * value type change (verified: `git grep -n CONTRACT_VARIABLE_DESCRIPTIONS`
 * across apps/web + apps/api).
 */
export const CONTRACT_VARIABLE_DESCRIPTIONS = {
  employeeName: /* i18n */ {
    id: 'contract-variable.employeeName',
    // fix-round 1 (COPY-M-7): the value resolved here is `legalFullName` —
    // the glossary's «юридичне ім'я» (the admin-set full legal name used on
    // documents), not the in-system display name. Naming that distinction
    // matters because both exist on the same user.
    message: 'ПІБ співробітника для контракту (юридичне ім’я)',
  },
  employeeEmail: /* i18n */ {
    id: 'contract-variable.employeeEmail',
    // fix-round 1 (COPY-M-8): resolved value is `user.email` (the work
    // email) — the user also has a personal email
    // (`PERSONAL_EMAIL_MUST_DIFFER` keeps the two distinct), so "email" alone
    // does not say which one ends up in the contract.
    message: 'Робочий email співробітника',
  },
  role: /* i18n */ {
    id: 'contract-variable.role',
    // fix-round 1 (COPY-M-9): `ROLE_LABELS` substitutes the ENGLISH role
    // word (Senior/Admin/…), not the Ukrainian list this used to enumerate —
    // listing values here promised text that never appears in the document.
    // ADMIN also never has an employee contract (`api-error`: "An
    // administrator can't have an employee contract"), so it never belonged
    // in the list either.
    message: 'Роль співробітника в компанії',
  },
  onboardingDate: /* i18n */ {
    id: 'contract-variable.onboardingDate',
    message: 'Дата підписання контракту',
  },
  salary: /* i18n */ {
    id: 'contract-variable.salary',
    // fix-round 1 (COPY-M-1): «зарплата» — the one glossary term for this
    // concept (not «ставка», reserved for a share percentage), matching the
    // already-existing `zod-error.SALARY_OR_SHARE_REQUIRED` wording.
    message: 'Щомісячна зарплата з профілю разом із валютою',
  },
  salaryCurrency: /* i18n */ {
    id: 'contract-variable.salaryCurrency',
    // fix-round 1 (COPY-M-1): the previous text enumerated USD/EUR/UAH, but
    // `currencyEnumSchema` also allows USDT — an incomplete list. Not
    // enumerating at all is both shorter and cannot drift out of sync again.
    message: 'Валюта зарплати з профілю',
  },
  sharePercent: /* i18n */ {
    id: 'contract-variable.sharePercent',
    message: 'Частка співробітника, % (сеньйор/дроп)',
  },
  companySharePercent: /* i18n */ {
    id: 'contract-variable.companySharePercent',
    message: 'Частка компанії, % (100 − частка співробітника)',
  },
  rnokpp: /* i18n */ { id: 'contract-variable.rnokpp', message: 'РНОКПП (ІПН ФОП) співробітника' },
  phone: /* i18n */ { id: 'contract-variable.phone', message: 'Телефон співробітника' },
  registrationAddress: /* i18n */ {
    id: 'contract-variable.registrationAddress',
    message: 'Адреса реєстрації (ФОП)',
  },
  companyName: /* i18n */ {
    id: 'contract-variable.companyName',
    message: 'Назва компанії (Cheeky Cheese IT)',
  },
  /** Legal name of the contracting legal entity */
  companyLegalName: /* i18n */ {
    id: 'contract-variable.companyLegalName',
    message: 'Юридична назва компанії-контрагента',
  },
  /** Registered address of the contracting legal entity */
  companyAddress: /* i18n */ {
    id: 'contract-variable.companyAddress',
    message: 'Адреса компанії-контрагента',
  },
  /** Country of incorporation of the contracting legal entity */
  companyCountry: /* i18n */ {
    id: 'contract-variable.companyCountry',
    message: 'Країна реєстрації компанії-контрагента',
  },
  companyRegNumber: /* i18n */ {
    id: 'contract-variable.companyRegNumber',
    message: 'Реєстраційний номер компанії-контрагента',
  },
  companyVat: /* i18n */ {
    id: 'contract-variable.companyVat',
    message: 'VAT-номер компанії-контрагента',
  },
  companyBank: /* i18n */ {
    id: 'contract-variable.companyBank',
    message: 'Банківські реквізити компанії-контрагента',
  },
  companyAuthorityBasis: /* i18n */ {
    id: 'contract-variable.companyAuthorityBasis',
    message: 'На підставі чого діє представник компанії',
  },
  walletUsdt: /* i18n */ {
    id: 'contract-variable.walletUsdt',
    message: 'Гаманець USDT ERC-20 (якщо вказано)',
  },
  bankUahFop: /* i18n */ {
    id: 'contract-variable.bankUahFop',
    // fix-round 1 (COPY-L-6): «UAH» — a currency code sitting inside a
    // Ukrainian phrase; «гривневі» says the same thing in the language it's
    // written in.
    message: 'Гривневі банківські реквізити ФОП',
  },
  preferredMethod: /* i18n */ {
    id: 'contract-variable.preferredMethod',
    // fix-round 1 (COPY-H-2): the previous text named non-existent values
    // ("crypto / fop") — neither the enum (`USDT_ERC20`/`BANK_UAH_FOP`) nor
    // the actual substitution (`METHOD_LABELS`: "USDT (ERC-20)"/"ФОП (UAH)")
    // uses those identifiers. Name the real values instead.
    message: 'Спосіб оплати з профілю: USDT (ERC-20) або ФОП (UAH)',
  },
  /**
   * Smart composite: shows the relevant payment requisites based on paymentMethod.
   * USDT_ERC20 → wallet address; BANK_UAH_FOP → ФОП fields; empty → 'не указано' (once).
   * Replaces the `{{walletUsdt}}{{bankUahFop}}` pair that produced "не указаноне указано"
   * when both fields were empty. `'не указано'` itself is `contract-rendering.ts`'s own
   * fallback literal (resolved VALUE, not this DESCRIPTION) — out of this task's
   * perimeter (frozen legal-document text, not a Zod message; see PR body «Допущения»).
   */
  requisites: /* i18n */ {
    id: 'contract-variable.requisites',
    // fix-round 1 (COPY-M-10): «спосіб оплати» — same panel, same word as
    // `preferredMethod` above (was «метод оплати», a second word for one
    // concept).
    message: 'Реквізити для оплати — підставляються автоматично за способом оплати',
  },
  contractNumber: /* i18n */ {
    id: 'contract-variable.contractNumber',
    // fix-round 1 (COPY-M-6): `generateUniqueContractNumber` produces
    // `CHK-<6 hex>` (e.g. `CHK-7F3A9C`), not `CHK-N-YYYY` — the previous
    // format was never accurate. The number is also assigned at signing, not
    // at preview time (the preview shows «—»).
    message: 'Номер контракту — присвоюється під час підписання, напр. CHK-7F3A9C',
  },
} as const satisfies Record<string, MessageDescriptor>

export type ContractVariableKey = keyof typeof CONTRACT_VARIABLE_DESCRIPTIONS

/**
 * Response shape for `GET /api/contracts/preview-rendered/:templateId`.
 * Returns the template body with all `{{placeholder}}` tokens substituted
 * using the calling user's current profile data (preview before signing).
 */
export const contractRenderedPreviewSchema = z.object({
  bodyMarkdown: z.string(),
})

export type ContractRenderedPreviewDto = z.infer<typeof contractRenderedPreviewSchema>

/**
 * Variables resolved at sign-time via interpolateVariables.
 * `contractNumber` is generated server-side (NOT interpolated from user data) — excluded
 * so the backend variables map is typed without it.
 */
export type InterpolatableVariableKey = Exclude<ContractVariableKey, 'contractNumber'>

/**
 * Derived braced form for admin UI display and template authoring hint panel.
 * Example: { '{{employeeName}}': { id: 'contract-variable.employeeName', message: '...' }, ... }
 */
export const CONTRACT_VARIABLE_DESCRIPTIONS_BRACED = Object.fromEntries(
  Object.entries(CONTRACT_VARIABLE_DESCRIPTIONS).map(([key, desc]) => [`{{${key}}}`, desc]),
) as Record<`{{${ContractVariableKey}}}`, MessageDescriptor>
