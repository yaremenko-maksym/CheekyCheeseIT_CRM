# CRM internationalization — design (uk + en, Lingui 6)

**Date:** 2026-09-19. **Status:** agreed with the owner (decisions recorded in §1), awaiting
stage plans. **Scope:** `apps/web`, `apps/api`, `packages/shared`, tests and project rules.
The landing (`apps/landing`) is already five-language and is not touched here.

---

## 1. Owner decisions (2026-09-19)

| #   | Question            | Decision                                                                                                                                                                        |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Interface languages | **`uk` (default) and `en`.** Russian text is removed from the CRM entirely. The "Ukrainian — never" rule applies only to the owner's communication with agents, not the product |
| 2   | Mechanism           | Library — **Lingui 6** (`@lingui/core`, `@lingui/react`, `@lingui/vite-plugin`, `@lingui/cli`, `eslint-plugin-lingui`)                                                          |
| 3   | Server text         | API errors — **codes + parameters**, translated on the client. Emails and PDFs — by the **recipient's** locale                                                                  |
| 4   | Order               | **Backlog 136 first** (CRM text audit), then the foundation                                                                                                                     |
| 5   | Boundaries          | Interface, API errors, emails **and invoice PDFs** (by recipient locale). Signal bot "+" — out of scope. Contracts are Ukrainian-only for now; UA\|EN logic — separately, later |
| 6   | Tests               | Anchors — `data-testid` and roles; text in assertions — **from the `uk` catalog**, not literals                                                                                 |
| 7   | Text authorship     | **The coder writes both languages** in one PR as two originals (skill `copywriting` §5); `copy-reviewer` gives a verdict per language                                           |

## 2. Goal and non-goal

**Goal.** Every employee sees the CRM, emails and invoices in their language (`uk` or `en`), switches
it in the profile, and no product surface contains Russian text. Translation coverage is
checked mechanically in CI, not by eye.

**Non-goal.** Translation of user data (project names, rejection reasons, legends, vacancy
texts — they have their own mechanism), contracts (already Ukrainian), the Signal bot, telemetry and logs
(remain English per `russian-language.md`), and adding a third language. The architecture
must not get in the way of this, but nothing is built for it.

## 3. Current state (measured on `origin/main` 2026-09-19)

| Surface                                           | Volume                                  |
| ------------------------------------------------- | --------------------------------------- |
| `apps/web` files with Russian text                | 261                                     |
| `apps/web` Russian string literals                | ~5,000 (finance 1,241, profile 829)     |
| `apps/api` exceptions with Russian text           | 289                                     |
| `packages/shared` literals (Zod messages, titles) | ~1,200                                  |
| E2E locators by Russian text                      | 88 across 121 specs                     |
| Unit tests with Russian assertions                | 159 web files, 333 api files            |
| Date/number formatting                            | 29 × `ru-RU`, 27 × `en-US`, 5 × `uk-UA` |
| Invoice PDFs (`invoice-pdf.service.ts`)           | 59 lines with Cyrillic                  |

The CRM has no dictionaries; the user has no language field; the notification title (`notifications.title`)
is written to the database as text at creation time.

## 4. Architecture

### 4.1. Locale

- `users.locale` — enum `uk | en`, `NOT NULL DEFAULT 'uk'`. DDL — only via `deploy.yml`
  (`apps/api/drizzle/manual/`, idempotent, `check-prod-ddl-wiring.py`). Set in the user-creation
  wizard and changed in the profile ("Settings" tab); `/auth/me` returns `locale`.
- Before login (login page, invitation email without an account): cookie `pref_locale` (the same one used on
  the landing) → `Accept-Language` → `uk`.
- Emails, notifications and PDFs are rendered by the **recipient's** `locale` from `users`, not the sender's.
- Date, number and money formatting — one function per kind in `packages/shared/i18n/format.ts`
  on top of `Intl` with the locale from context; direct `toLocaleString('ru-RU')` and `date-fns` with
  a fixed locale go away.

### 4.2. Catalogs and build

- Source of truth — `packages/shared/i18n/locales/{uk,en}/messages.po`; `lingui compile`
  places `messages.ts` next to it. One catalog for three consumers: web (`@lingui/react`, the Vite plugin,
  macros `t`/`Trans`/`msg`/`plural`), API (`@lingui/core`, `i18n.activate(locale)` at email
  or PDF render time), shared (`msg` descriptors without activation).
- Source text in the code — **Ukrainian**; the message id is a hash of the text (Lingui ≥4 default); explicit
  ids only for strings without text (error codes, §4.3).
- `lingui.config.ts` at the monorepo root; `sourceLocale: 'uk'`, `locales: ['uk','en']`,
  `catalogs` per the three packages. Versions — in `version-pins.md` (`@lingui/*` packages at a single version).

### 4.3. API errors

- Error envelope: `{ statusCode, code, params?, message }`. `code` — a stable identifier
  (`CONTRACT_SIGN_IMPERSONATION`, `PROJECT_NOT_IN_TEAMS`, …), `params` — substitutions without PII,
  `message` — an English string for logs and clients without a catalog (backward compatibility).
- `apps/api`: `throw new ForbiddenException({ code, params })` via a thin helper
  `apiError(code, params)`; the exception filter builds the envelope. The code registry —
  `packages/shared/src/schemas/api-errors.ts` (enum + Zod schema of the envelope + a `msg` descriptor
  per code, so that `lingui extract` sees the strings).
- Client: `getApiErrorMessage` looks up `code` in the catalog, otherwise — a generic text "Failed to
  perform the action"; codes that need a "what to do" hint carry it in the catalog text.
- Zod messages in `packages/shared` (`message: '…'`) → codes via the same registry; client
  forms render them by code.

### 4.4. Notifications and emails

- `notifications`: `title`/`body` stop being the text source for new types. Display
  (popup, `/pending`, tab, email) renders text by `type` + `data` through the catalog by the
  viewer/recipient locale. Existing strings remain as fallback text for legacy types.
- `notification-email-copy.ts` — templates via `t`/`plural` in the catalog; the cron activates the
  recipient's locale before rendering; the email subject — also from the catalog.
- `NOTIFICATION_TITLES` and similar `Record<Type, string>` in shared → `Record<Type, MessageDescriptor>`.

### 4.5. Invoice PDFs

`invoice-pdf.service.ts` renders by the recipient's locale; text constants — from the catalog. The PDF
font must contain `і ї є ґ` (check `pdf.constants.ts`, replace if necessary).
Contracts are not touched.

### 4.6. Web

- Provider `I18nProvider` in `__root.tsx`; locale from `/auth/me`, before login — from a cookie.
- Switcher: profile "Settings" tab + a field in the creation wizard.
- Each module migrates entirely in one PR (§7): literals → macros, en/uk lengths at 320
  checked by the designer (design-gate Tier 2), both languages' texts — by copy-reviewer.

## 5. Gates and observability

| Gate                                                     | Where                                | Mode                                                     |
| -------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| `lingui/no-unlocalized-strings` (`eslint-plugin-lingui`) | `apps/web`, `packages/shared`        | stages 2–4: warning; stage 6: error                      |
| `lingui extract --clean` + 0 untranslated `en`           | CI, required check "Typecheck…"      | from stage 2 for migrated modules                        |
| Guard for Russian letters `[ыЫэЭъЪёЁ]` in product code   | `scripts/devops/check-no-russian.sh` | stage 6: error (these letters are absent from Ukrainian) |
| Workflow 8 "Language / locale-leak sweep"                | on request                           | after stage 6 — coverage audit, not leaks                |
| `copy-reviewer` on every PR with catalogs                | review                               | verdict on `uk` and on `en` separately                   |

## 6. Project rules and documents that change

- `.claude/rules/common/russian-language.md`: Russian — the language of communication with the owner, PR discussions
  and agent reports; the **product** (UI, emails, PDF) — `uk`/`en`; the ban on Ukrainian in the product
  is lifted. Logs — English, as before.
- `CONTEXT.md`: the glossary gets `uk` and `en` columns for each term (source for
  catalogs and for copy-reviewer).
- `.claude/agents/copy-reviewer.md`, `.claude/skills/copywriting`: two CRM languages, the "two
  originals" rubric extends to the CRM.
- `.claude/rules/common/version-pins.md`: `@lingui/*` pins.
- `.claude/agents/workflow-registry.md` №8: transition to translation-coverage.
- `docs/runbooks/human-only.md`: nothing new for the owner (locale — a field in the profile).

## 7. Stages (each — its own spec-appendix and plan; PRs by module)

1. **Audit (backlog 136 + workflow 8).** Read-only, by slices: shell/navigation, team and
   profile, projects and interviews, finance, documents/notifications/pending, API exceptions,
   shared. Per slice the output: text-behavior defects (an error without "what to do", English
   leaks, divergences from the glossary) and **migration hazards** — string concatenation, manual
   plural forms, gender endings, text in constants and `Record`. Result —
   `docs/architecture/2026-09-19-crm-i18n-audit.md`.
2. **Foundation.** Lingui and config, `packages/shared/i18n` (empty catalogs + `format.ts`),
   `users.locale` + DDL, `/auth/me`, provider and switcher, the error-code envelope and registry,
   `getApiErrorMessage` by code, the ESLint rule in warning, rule edits (§6). Zero translated
   screens — but everything ready for a module to migrate in one PR.
3. **Web by module** in waves of ≤3 PRs: (a) shell, navigation, login, common `ui`/`layout` components,
   `lib`/`hooks`; (b) team, users, profile, onboarding; (c) projects, interviews,
   vacancies; (d) finance, statistics, invoices; (e) documents, notifications, `/pending`, routing.
4. **API and shared.** Exceptions → codes (289), Zod messages, notification titles on display,
   uk/en emails.
5. **Invoice PDFs** by the recipient's locale.
6. **Closeout.** ESLint rule to error, guard for Russian letters, `extract --clean` mandatory,
   removal of leftovers, workflow 8 as a coverage audit, lifting temporary exceptions.

Stages 3 and 4 can run in parallel in waves; 5 — after 4 (shared catalog and locale activation).

## 8. Testing

- Unit/E2E: elements are found by `data-testid` and roles; text in assertions is taken from the `uk` catalog
  (import of the compiled message), not a literal. The rule is extended in
  `.claude/skills/playwright-patterns`.
- Each module PR: unit web/api/shared, integration of affected modules, module E2E specs
  on the live stand, the mutation gate on the diff, screenshots 320/1440 in both languages.
- Emails: `notification-email-copy.spec.ts` — a snapshot of the subject and body in `uk` and `en`.
- PDF: a snapshot test of the invoice text in both locales + a font glyph check.

## 9. Risks

- **Volume.** ~6,500 strings and ~500 test files. Mitigation: module PRs, the mutation gate on the
  diff, the ESLint rule catches misses before review.
- **Language mixing in the transition period.** Until a module is migrated, it shows Russian.
  Mitigation: wave order from the shell to the periphery; the Russian-letters guard turns on only in
  stage 6.
- **Notifications in the database.** Old strings remain Russian until they expire; render-by-type
  closes this for everything new.
- **English and Ukrainian length.** Ukrainian is 15–30% longer than English: the designer
  checks 320 in both languages in each module PR.

## 10. Milestone readiness check

- In `apps/web`, `apps/api`, `packages/shared` the Russian-letters guard is silent.
- `lingui extract --clean` yields 0 untranslated `en` keys.
- An employee with `locale = en` sees the interface, email and invoice in English; with `uk` — in
  Ukrainian.
- `copy-reviewer` returned `PASS` on both catalogs.
