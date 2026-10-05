# CRM i18n — Emails (recipient-locale rendering) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each **PR** below is an independently reviewable, independently mergeable unit; implement one PR per branch, open it, run review (security-reviewer **and** copy-reviewer mandatory), merge, then rebase the next.

**Goal:** Every email the CRM sends to a user is rendered in the **recipient's** locale (`users.locale`, default `uk`; `uk` and `en` only): subject, body, button label, fallback lines and the `<html lang>` attribute all come from the Lingui catalog. Zero Russian user-facing literals remain in the email modules.

**Architecture:** The server composes the email through a **per-call** `createI18n(recipientLocale)` and the shared `renderMessage` (same renderer as `api-error.ts`, notifications, invoice PDF #749). Message descriptors live in two new `@crm/shared` registries (`notification-email-registry.ts`, `invite-email-registry.ts`) with explicit ids and hand-written `uk` + `en` `msgstr`. `email-layout.ts` takes the locale for `<html lang>`. The cron reads the recipient's locale from `users` **at send time** (same moment it already reads archived/address/preference state) and passes it into the renderer — no global `i18n.activate`, no singleton. Legacy/unknown notification types keep the stored text as fallback.

**Tech Stack:** NestJS 11 + Fastify + Drizzle (api) · Zod v4 + `@crm/shared` · `@lingui/core` `5.9.5` EXACT (server: `setupI18n` via `createI18n`; extraction: `lingui extract`) · Vitest · Stryker mutation gate · Node 22.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.1 (locale; "emails… by the recipient's `locale` from `users`, not the sender's"), §4.4 ("`notification-email-copy.ts` — templates… in the catalog; the cron activates the recipient's locale before rendering; the email subject — also from the catalog"). Predecessor plans (format, contracts, lessons): `2026-10-03-crm-i18n-server-user-facing-text.md` (#743–#748), `2026-09-20-crm-i18n-stage4-api-shared.md` (in-app titles, already migrated — NOT redone here), invoice PDF stage 5 (#749, the per-call recipient-locale precedent).

---

## Global Constraints

Copied from the i18n programme; every task's requirements implicitly include this section.

- **Lingui `5.9.5` EXACT** across `@lingui/*` (`version-pins.md`). Do not bump. **Node 22** (`engines: >=22.19 <23`) — run every command below under Node 22.
- **Explicit-id catalogs:** every descriptor is `/* i18n */ { id, message }` as an object **property value** inside a `Record` literal (`lingui extract` only sees it there — see the `MISC_MESSAGES` comment in `notification-registry.ts`). Add the `msgstr` to **both** `packages/shared/src/i18n/locales/uk/messages.po` and `.../en/messages.po` **by hand**; **`en` is a second original, not a calque of `uk`** (copywriting §5).
- **Three-arg render:** always `renderMessage(i18n, descriptor, params)` (→ `i18n._(id, params, { message })`). Never pass a descriptor object literal to `i18n._`, never a template literal as id.
- **Per-call i18n, never a singleton:** `createI18n(locale)` once per rendered email. Forbidden on the server: `i18n.activate(...)` on the global `@lingui/core` export, a module-level `I18n`, a locale stored on the service instance.
- **Case:** substitute names (project/team/vacancy/first name) in the **nominative only** (template K); every sentence is a whole message with named placeholders — nothing is assembled from fragments on the server (the legacy `projectPhrase` / `sharePhrase` concatenation is replaced by whole messages).
- **ICU apostrophe trap:** in ICU MessageFormat an ASCII `'` is an escape character. Message sources use the typographic `’` (U+2019) or no apostrophe; a spec asserts no rendered email text contains a stray `'`/`''` artifact.
- **Privacy rule of the emails stays as-is (spec §10/§11):** the email names the **object** (project, team, contract, vacancy) and **never** a person (except the invitee's own first name in the invite), an amount or a percentage. The existing guards (`notification-email-copy.spec.ts` «ни одной цифры», no-names) must stay green **in both locales**.
- **Glossary (`CONTEXT.md`):** `частка` (share), `проєкт`, `контракт`, `сеньйор`. A term from a glossary `_Избегать_` list is a review finding. English-loanword terms are fine; no slang.
- **Logs stay English and are not migrated** (owner decision, server-text plan). Neither are service metadata, skip reasons, telemetry `meta`.
- **E2E:** grep the whole `apps/e2e` for any email string before/after (done at plan time: no e2e spec references email subjects/bodies — re-verify, the tree moves). Do not run the heavy E2E sweep on a loaded machine; push and let CI arbitrate.
- **guard-test-gate FM-5:** if a PR edits an `apps/api` **controller**, extend that controller's RBAC 403-spec in the same PR (PR2 edits `users.controller.ts`).
- **Push:** `DATABASE_URL= git push`. Final (non-`wip:`) commit of every PR carries `ac_verified:`. Co-Authored-By trailer per the conversation attribution.
- **security-reviewer is MANDATORY on every PR here** (emails carry identity / financial context to a recipient; another recipient's locale must never leak — the #749 class of defect). **copy-reviewer is MANDATORY** on PR1 and PR2 (two languages, 49 new strings; verdict per language, `Copy Review: PASS|ISSUES|BLOCK`).

---

## Perimeter (verified live against `origin/main` d617ce98, 2026-10-03)

Method: every `*.ts` under `apps/api/src` that sends mail (`grep mailer.send` → exactly **three** call sites) plus every file in the task brief, classified by reading each non-comment Cyrillic literal.

| File                                                                                                                    | Cyrillic non-comment content                                                                                                                                                                                                                                                                                                                                                                                                                           | Verdict                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications/notification-email-copy.ts`                                                                              | **13** types in `BODIES` (10 Russian + 3 already-Ukrainian plain strings added by stage 4 task 6: `INVOICE_SIGNED`, `INVOICE_SIGN_REQUIRED`, `VACANCY_APPLICATION`); `acceptedLine`/`rejectedLine`/`projectPhrase`/`sharePhrase`; `EMAIL_ACTION_LABELS` + `emailActionLabelFor` + `emailAction`; `'Ответить на запрос'`, `'Открыть CRM'`, `'Открыть'`, `'Подробности — в CRM.'`; subject fallback via legacy `NOTIFICATION_TITLES[type]` (**Russian**) | **USER-FACING → PR1**                                                                                                                         |
| `common/email-layout.ts`                                                                                                | Only `<html lang="ru">`. No visible words (blocks/button/footer come from callers). The brief's «общие строки шапки/футера/кнопки» do not exist in this file — the footer/button text belongs to each caller                                                                                                                                                                                                                                           | **USER-FACING (attribute) → PR1** (+ PR2 removes the transitional default)                                                                    |
| `notifications/notification-email.cron.ts`                                                                              | **None** in code — only comments and **English** log/telemetry strings. The migration here is wiring (recipient locale → renderer)                                                                                                                                                                                                                                                                                                                     | **WIRING → PR1**; logs untouched                                                                                                              |
| `notifications/notification-email.repository.ts`                                                                        | None (SQL). Needs `users.locale` added to `deliveryContextFor`                                                                                                                                                                                                                                                                                                                                                                                         | **WIRING → PR1**                                                                                                                              |
| `users/personal-email-invite-mailer.service.ts`                                                                         | subject, 3 body blocks, button, footer (with `<strong>`), text twin; greeting by first name. Logs/telemetry are English                                                                                                                                                                                                                                                                                                                                | **USER-FACING → PR2**                                                                                                                         |
| `notifications/notification-email-outbox.ts`                                                                            | **None.** Pure decision logic (`decideDelivery`, `SkipReason` codes, `MAX_EMAIL_ATTEMPTS`); the only prose is comments and an English `throw new Error(...)`. **Not email text** — the brief's «~136 кир. строк» are comments                                                                                                                                                                                                                          | **SERVICE (out)** — not touched                                                                                                               |
| `contact/resend-mailer.service.ts`, `contact/mailer.module.ts`                                                          | **None** (HTTP client + wiring; error text `Resend API HTTP <status>` is English)                                                                                                                                                                                                                                                                                                                                                                      | **SERVICE (out)**                                                                                                                             |
| `contact/contact.service.ts`                                                                                            | Russian **internal** email to the company's own public inbox («Заявка с сайта — …», «Имя:», «Компания:»), recipient is staff, not a CRM user → no recipient locale exists; plus `UnprocessableEntityException`/`ServiceUnavailable` Russian messages returned to **landing** visitors                                                                                                                                                                  | **OUT** — landing has its own 5-language mechanism; HTTP prose belongs to the error-code track (server-text plan Q1). Recorded as Decision D4 |
| `users/invite-token.util.ts`, `users/users-access.service.ts`, `users.module.ts`, `config/env.ts`, `database/schema.ts` | none user-facing (matched only the word `resend`/`nodemailer`)                                                                                                                                                                                                                                                                                                                                                                                         | out                                                                                                                                           |
| In-app `NOTIFICATION_TITLE_MESSAGES` / `renderNotification`                                                             | already migrated (stage 4 task 6)                                                                                                                                                                                                                                                                                                                                                                                                                      | **not redone**; PR1 only _reuses_ `ACTION_LABELS`, `MISC_MESSAGES.open/actionApproval*`, `NOTIFICATION_TITLE_MESSAGES`                        |

Net: **49 new catalog ids** (42 notification-email, 7 invite), all in two new registries.

---

## Contract design (applies to all PRs)

1. **Registry, not inline strings.** `packages/shared/src/schemas/notification-email-registry.ts` exports `EMAIL_NOTIFICATION_MESSAGES` (one flat `Record` literal, ids `email.notification.<TYPE>.<slot>` and `email.notification.shared.<slot>`); `invite-email-registry.ts` exports `EMAIL_INVITE_MESSAGES` (`email.invite.<slot>`). Both are exported from `packages/shared/src/schemas/index.ts`. Source text is `uk`; `en` is in the `.po`.
2. **Data-dependent variants are separate whole messages** (e.g. subject with/without project name), selected by the existing `BODIES` builders — not ICU `select` over fragments, and never string concatenation.
3. **Renderer signature:** `renderNotificationEmail(source, { frontendUrl, locale })` where `locale: Locale` is **required** (no default — a forgotten caller must fail typecheck, not silently ship `uk`). It builds `const i18n = createI18n(opts.locale)` itself, so a caller cannot pass someone else's activated instance.
4. **Locale source for notification emails:** the recipient's `users.locale`, read in `OutboxRepository.deliveryContextFor` (send time, so a locale changed between event and send, or across retries, is honoured). Validated through `resolveLocale([row.locale])` — a corrupt/unknown value degrades to `uk`, never throws, never reads a cookie/header (a cron has no request).
5. **Locale source for the invite:** the **invitee's** `users.locale` (see Decision D2): `SendInviteInput.locale: Locale` is required; the three callers pass the invitee's stored value. The admin's request locale/cookie/`Accept-Language` is **never** consulted.
6. **Escaping order is unchanged and load-bearing:** render the whole sentence with `renderMessage` (plain text; ICU does not escape param values) **then** `escapeHtml` → `EscapedHtml` for the HTML twin; the plain-text twin and the `subject` use the raw rendered string; `stripCrlf` on the subject stays (names are user input). Only the invite footer needs markup (Decision D5).
7. **Privacy invariant for security-reviewer:** the set of data substituted into each email is **identical to today's** — no new param, no name/amount/percent added while "improving" a sentence. Params are exactly: `projectName`, `teamName`, `vacancyTitle`, `subjectTitle`, (`firstName` for the invite).

---

## File structure

**Shared (`packages/shared/src/`):**

- `schemas/notification-email-registry.ts` _(new, PR1)_ — `EMAIL_NOTIFICATION_MESSAGES`.
- `schemas/notification-email-registry.spec.ts` _(new, PR1)_ — exhaustiveness, direct `.id/.message` pins, uk/en golden renders, apostrophe + subject-length guards.
- `schemas/invite-email-registry.ts` + `.spec.ts` _(new, PR2)_.
- `schemas/index.ts` — export both.
- `i18n/locales/{uk,en}/messages.po` — `msgstr` for every new id (each PR appends its own block).

**API (`apps/api/src/`):**

- `common/email-layout.ts` (+ `.spec.ts`) — `lang` from locale.
- `notifications/notification-email-copy.ts` (+ `.spec.ts`) — descriptors + `locale`; legacy Russian removed.
- `notifications/notification-email.repository.ts` (+ `.spec.ts`) and `notification-email-outbox.ts` (type `DeliveryContext` gains `locale`; `decideDelivery` untouched) — recipient locale.
- `notifications/notification-email.cron.ts` (+ `.spec.ts`) — pass `locale` to the renderer.
- `notifications/notification-email-delivery.integration.spec.ts` — real-SQL locale read + two-recipient no-leak.
- `users/personal-email-invite-mailer.service.ts` (+ spec), `users/users.service.ts` (`resendPersonalEmailInvite` / `changePersonalEmail` return `locale`; `createUser` passes the created row's locale), `users/users.controller.ts` (3 call sites; + RBAC 403 spec extension) _(PR2)_.
- `common/email-no-cyrillic-literals.spec.ts` _(new, PR3)_ — AST guard over the email modules.

---

## PR decomposition & merge order

Three PRs, merged **sequentially** (`PR1 → PR2 → PR3`, rebase each on the previous): every PR appends to the same two `.po` files, and PR2 depends on PR1's layout signature.

- **PR1 — Notification emails end-to-end.** Registry (all 13 types, buttons, fallbacks) + `email-layout` `lang` + repository/outbox-type locale + cron wiring + tests in both locales + real-DB locale test. Atomic by design: splitting the 13 types across PRs would ship emails with a Ukrainian button over a Russian body (or require a throw-away "migrated types" gate); the whole of this copy is read by copy-reviewer in one place anyway (the file's own design rule).
- **PR2 — Invite email.** `invite-email-registry` + mailer + 3 callers + `users.service` return shapes + layout default removed. Different surface (identity: the invitee, pre-first-login), different reviewer focus.
- **PR3 — Close-out guard.** AST guard test (no Cyrillic literal in the email modules, comment-proof), stale-comment cleanup, docs (`project-state.md`/`CONTEXT.md` pointer, runbook line). No product behavior change; small.

**Transitional state between PR1 and PR2:** `renderEmailLayout`'s `lang` is optional with default `'ru'` so the not-yet-migrated invite stays byte-identical (pinned by its existing golden). PR2 passes the locale and makes it required — Task 2.6.

---

## Task PR1 — Notification emails

**Files:**

- Create: `packages/shared/src/schemas/notification-email-registry.ts`, `packages/shared/src/schemas/notification-email-registry.spec.ts`
- Modify: `packages/shared/src/schemas/index.ts`, `packages/shared/src/i18n/locales/uk/messages.po`, `packages/shared/src/i18n/locales/en/messages.po`
- Modify: `apps/api/src/common/email-layout.ts`, `apps/api/src/common/email-layout.spec.ts`
- Modify: `apps/api/src/notifications/notification-email-copy.ts`, `apps/api/src/notifications/notification-email-copy.spec.ts`
- Modify: `apps/api/src/notifications/notification-email-outbox.ts` (type only), `apps/api/src/notifications/notification-email.repository.ts`, `apps/api/src/notifications/notification-email.repository.spec.ts`
- Modify: `apps/api/src/notifications/notification-email.cron.ts`, `apps/api/src/notifications/notification-email.cron.spec.ts`
- Modify: `apps/api/src/notifications/notification-email-delivery.integration.spec.ts`

**Interfaces:**

- Produces (shared): `EMAIL_NOTIFICATION_MESSAGES: Record<string, MessageDescriptor>` (keys listed in Task 1.2); stays a plain object literal `satisfies`-free at the top level so `lingui extract` sees every property value.
- Produces (api): `renderNotificationEmail(source: NotificationEmailSource, opts: { frontendUrl: string; locale: Locale }): RenderedNotificationEmail` (**breaking**: `locale` required); `DeliveryContext.locale: Locale`; `renderEmailLayout(input: EmailLayoutInput & { lang?: Locale | 'ru' })` (transitional, default `'ru'`).
- Consumes: `createI18n(locale)`, `renderMessage`, `resolveLocale`, `Locale` (`@crm/shared`); `ACTION_LABELS`, `MISC_MESSAGES.open`, `MISC_MESSAGES.actionApprovalProject/Profile`, `NOTIFICATION_TITLE_MESSAGES`, `notificationHref`, `isActionRequiredNotificationType`, `isNewNotificationType`, `notificationDataSchemaFor` (all already exported from `notification-registry.ts`).

**Blast-radius (record in `.progress.md` `blast_radius:` before editing; pin old behavior first):**

- `renderNotificationEmail` — call-sites: `notification-email.cron.ts` (1) + `notification-email-copy.spec.ts` (all renders) + any `notifications.email-enqueue.spec.ts` helper. Find with `mcp__codegraph__codegraph_callers renderNotificationEmail`.
- `renderEmailLayout` — 2 production callers (copy, invite) + `email-layout.spec.ts`. Invite golden must stay byte-identical in PR1.
- `DeliveryContext` — consumed by `decideDelivery` (spread `{ ...context, subjectState }`) and tests; adding a field must not change any `decideDelivery` result (pin: existing `notification-email-outbox.spec.ts` stays green untouched).
- `OutboxGateway.deliveryContextFor` — implemented by `OutboxRepository`, faked in `notification-email.cron.spec.ts` (`makeGateway`-style helper) and the integration spec.

### Task 1.1: Characterization pins of today's Russian output (behavior freeze, before any change)

- [ ] **Step 1: Verify the existing guard is green.** `pnpm --filter @crm/api test notification-email-copy notification-email.cron email-layout notification-email-outbox` → PASS. Save the baseline output in the scratchpad (not in the repo).
- [ ] **Step 2: Add structural pins that survive the migration** to `notification-email-copy.spec.ts` (these assert **routing and structure**, not language, so they are expected to stay green through Task 1.4 unchanged): for each of the 13 `NEW_NOTIFICATION_TYPES`: `buttonHref` equals today's value (`/pending` for the three action-required types, `notificationHref(subjectType, subjectId)` otherwise, `/` when neither link nor subject); `html` contains exactly one `<a href=`; subject has no CR/LF; `text` last line is `` `${buttonLabel}: ${buttonHref}` ``. Several of these already exist (`кнопка ведёт туда…`, `каркас письма…`) — extend `it.each(NEW_NOTIFICATION_TYPES)` to cover all **13** (today's `десять писем` suite iterates the constant, so the three stage-4 types are already in; confirm and make the count explicit: `expect(NEW_NOTIFICATION_TYPES).toHaveLength(13)` so a 14th type fails loudly here).
- [ ] **Step 3: Run → GREEN.** `wip:` commit (`wip(i18n): email structural pins before locale migration`), `DATABASE_URL= git push`.

### Task 1.2: Shared registry + catalog (RED → GREEN)

**Registry content (source = `uk`; `en` = second original). Ids `email.notification.<slot>`.** Write exactly these:

| key in `EMAIL_NOTIFICATION_MESSAGES` | id suffix                                      | uk (source)                                                                | en                                                                                    |
| ------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `transactionAddedSubjectProject`     | `TRANSACTION_ADDED.subject.project`            | `Транзакція за проєктом «{projectName}»`                                   | `Transaction on the project “{projectName}”`                                          |
| `transactionAddedSubject`            | `TRANSACTION_ADDED.subject`                    | `Вам додали транзакцію`                                                    | `A transaction was added for you`                                                     |
| `transactionAddedLine`               | `TRANSACTION_ADDED.line`                       | `У ваших фінансах нова транзакція. Сума й деталі — у CRM.`                 | `There is a new transaction in your finances. The amount and details are in the CRM.` |
| `statusValidatedSubject`             | `TRANSACTION_STATUS_CHANGED.subject.validated` | `Дохід валідовано`                                                         | `Income validated`                                                                    |
| `statusRejectedSubject`              | `TRANSACTION_STATUS_CHANGED.subject.rejected`  | `Дохід відхилено`                                                          | `Income rejected`                                                                     |
| `statusRejectedLine`                 | `TRANSACTION_STATUS_CHANGED.line.rejected`     | `Причина відмови — у CRM.`                                                 | `The reason is in the CRM.`                                                           |
| `teamMemberAddedSubject`             | `TEAM_MEMBER_ADDED.subject`                    | `Вас додали до команди «{teamName}»`                                       | `You were added to the team “{teamName}”`                                             |
| `teamMemberAddedLine`                | `TEAM_MEMBER_ADDED.line`                       | `Склад команди — у CRM.`                                                   | `The team roster is in the CRM.`                                                      |
| `projectMemberAddedSubject`          | `PROJECT_MEMBER_ADDED.subject`                 | `Вас додали до проєкту «{projectName}»`                                    | `You were added to the project “{projectName}”`                                       |
| `projectMemberAddedLine`             | `PROJECT_MEMBER_ADDED.line`                    | `Деталі проєкту та його склад — у CRM.`                                    | `Project details and its members are in the CRM.`                                     |
| `teamNewMemberSubject`               | `TEAM_NEW_MEMBER.subject`                      | `У команді «{teamName}» новий учасник`                                     | `New member in the team “{teamName}”`                                                 |
| `teamNewMemberLine`                  | `TEAM_NEW_MEMBER.line`                         | `Хто саме — у CRM.`                                                        | `Who it is — in the CRM.`                                                             |
| `projectConfirmSubject`              | `PROJECT_CONFIRM_REQUIRED.subject`             | `Запит на додавання проєкту «{projectName}»`                               | `Request to add the project “{projectName}”`                                          |
| `projectConfirmLine1`                | `PROJECT_CONFIRM_REQUIRED.line1`               | `Вам пропонують участь у проєкті «{projectName}».`                         | `You are being offered a place on the project “{projectName}”.`                       |
| `projectConfirmLine2`                | `PROJECT_CONFIRM_REQUIRED.line2`               | `Проєкт не стартує, доки учасники не відповіли.`                           | `The project will not start until the participants respond.`                          |
| `shareConfirmSubjectBase`            | `SHARE_CONFIRM_REQUIRED.subject.base`          | `Запит на зміну частки за замовчуванням`                                   | `Request to change your default share`                                                |
| `shareConfirmSubjectProject`         | `SHARE_CONFIRM_REQUIRED.subject.project`       | `Запит на зміну частки за проєктом «{projectName}»`                        | `Request to change your share on the project “{projectName}”`                         |
| `shareConfirmLine1Base`              | `SHARE_CONFIRM_REQUIRED.line1.base`            | `Вам пропонують змінити частку за замовчуванням.`                          | `You are being asked to change your default share.`                                   |
| `shareConfirmLine1Project`           | `SHARE_CONFIRM_REQUIRED.line1.project`         | `Вам пропонують змінити вашу частку за проєктом «{projectName}».`          | `You are being asked to change your share on the project “{projectName}”.`            |
| `shareConfirmLine2`                  | `SHARE_CONFIRM_REQUIRED.line2`                 | `Зараз діє попередня частка. Нова набуде чинності лише після вашої згоди.` | `Your previous share still applies. The new one takes effect only after you agree.`   |
| `documentSignSubject`                | `DOCUMENT_SIGN_REQUIRED.subject`               | `Запит на підпис контракту`                                                | `Request to sign your contract`                                                       |
| `documentSignLine`                   | `DOCUMENT_SIGN_REQUIRED.line`                  | `Ваш контракт готовий і чекає на підпис.`                                  | `Your contract is ready and waiting for your signature.`                              |
| `approvalConfirmedSubject`           | `APPROVAL_CONFIRMED.subject`                   | `Вашу пропозицію прийнято`                                                 | `Your proposal was accepted`                                                          |
| `approvalRejectedSubject`            | `APPROVAL_REJECTED.subject`                    | `Вашу пропозицію відхилено`                                                | `Your proposal was declined`                                                          |
| `approvalReasonLine`                 | `APPROVAL_REJECTED.line.reason`                | `Причина — у CRM.`                                                         | `The reason is in the CRM.`                                                           |
| `acceptedProject`                    | `approval.accepted.project`                    | `Співробітник погодився взяти участь у проєкті «{subjectTitle}».`          | `The employee agreed to take part in the project “{subjectTitle}”.`                   |
| `acceptedProjectUntitled`            | `approval.accepted.projectUntitled`            | `Співробітник погодився взяти участь у проєкті.`                           | `The employee agreed to take part in the project.`                                    |
| `acceptedProjectShare`               | `approval.accepted.projectShare`               | `Співробітник погодився на зміну частки за проєктом «{subjectTitle}».`     | `The employee agreed to the change of their share on the project “{subjectTitle}”.`   |
| `acceptedProjectShareUntitled`       | `approval.accepted.projectShareUntitled`       | `Співробітник погодився на зміну частки за проєктом.`                      | `The employee agreed to the change of their share on the project.`                    |
| `acceptedBaseShare`                  | `approval.accepted.baseShare`                  | `Співробітник погодився на зміну частки за замовчуванням.`                 | `The employee agreed to the change of their default share.`                           |
| `rejectedProject`                    | `approval.rejected.project`                    | `Співробітник відмовився від участі у проєкті «{subjectTitle}».`           | `The employee declined to take part in the project “{subjectTitle}”.`                 |
| `rejectedProjectUntitled`            | `approval.rejected.projectUntitled`            | `Співробітник відмовився від участі у проєкті.`                            | `The employee declined to take part in the project.`                                  |
| `rejectedProjectShare`               | `approval.rejected.projectShare`               | `Співробітник відмовився від зміни частки за проєктом «{subjectTitle}».`   | `The employee declined the change of their share on the project “{subjectTitle}”.`    |
| `rejectedProjectShareUntitled`       | `approval.rejected.projectShareUntitled`       | `Співробітник відмовився від зміни частки за проєктом.`                    | `The employee declined the change of their share on the project.`                     |
| `rejectedBaseShare`                  | `approval.rejected.baseShare`                  | `Співробітник відмовився від зміни частки за замовчуванням.`               | `The employee declined the change of their default share.`                            |
| `invoiceSignedSubject`               | `INVOICE_SIGNED.subject`                       | `Рахунок підписано`                                                        | `Invoice signed`                                                                      |
| `invoiceSignRequiredSubject`         | `INVOICE_SIGN_REQUIRED.subject`                | `Рахунок очікує підпису`                                                   | `Invoice awaiting your signature`                                                     |
| `vacancyApplicationSubject`          | `VACANCY_APPLICATION.subject`                  | `Новий відгук на вакансію «{vacancyTitle}»`                                | `New application for the vacancy “{vacancyTitle}”`                                    |
| `sharedAmountAndDetailsLine`         | `shared.amountAndDetails`                      | `Сума й деталі — у CRM.`                                                   | `The amount and details are in the CRM.`                                              |
| `sharedDetailsLine`                  | `shared.details`                               | `Деталі — у CRM.`                                                          | `Details are in the CRM.`                                                             |
| `sharedRespondButton`                | `shared.button.respond`                        | `Відповісти на запит`                                                      | `Respond to the request`                                                              |
| `sharedOpenCrmButton`                | `shared.button.openCrm`                        | `Відкрити CRM`                                                             | `Open the CRM`                                                                        |

Reused as-is (no new id): `ACTION_LABELS.*` (info-type buttons — same words as the frozen email map: «Відкрити фінанси / команду / проєкт»), `MISC_MESSAGES.actionApprovalProject/Profile`, `MISC_MESSAGES.open` (legacy-with-link button), `NOTIFICATION_TITLE_MESSAGES[type]` (subject when the data shape is unparseable — replaces the legacy Russian `NOTIFICATION_TITLES`). Which line each type uses: `TRANSACTION_STATUS_CHANGED` validated → `sharedAmountAndDetailsLine`; `INVOICE_SIGNED`, `VACANCY_APPLICATION` → `sharedDetailsLine`; `INVOICE_SIGN_REQUIRED` → `sharedAmountAndDetailsLine`; the unparseable-data fallback line → `sharedDetailsLine`.

Copy assumptions to record in the task file's `## Допущения` and the PR body (A1 — reversible, copy-reviewer may overrule):

1. `SHARE_CONFIRM_REQUIRED` project subject says **«частка»**, not «процент»: the legacy comment kept «процент» only because the owner approved the §11 wording verbatim; the in-app canon already says «Пропозиція щодо частки» and `CONTEXT.md` lists «процент дропа» under `_Избегать_`. The Russian exception does not survive the migration into a language where the glossary term is mandatory.
2. Subject prefix `Запит на …` / `Request to …` is kept for everything that needs an answer (§11 rule: the prefix tells it is an offer, not a fact).
3. `INVOICE_SIGN_REQUIRED` keeps today's «очікує підпису» (the shorter popup title «на підпис» exists for a 24-char popup budget that an email subject does not have).

- [ ] **Step 1: Write the failing registry spec** `notification-email-registry.spec.ts`. Expected values are **hand-written literals**, never derived from the registry (tautology guard):

```ts
import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n'
import { renderMessage } from './notification-registry'
import { EMAIL_NOTIFICATION_MESSAGES as M } from './notification-email-registry'

describe('EMAIL_NOTIFICATION_MESSAGES — direct pins (the compiled catalog wins at render time, so a mutated `message` is invisible through i18n; read the fields directly)', () => {
  it('projectConfirmLine1: id and uk source', () => {
    expect(M.projectConfirmLine1.id).toBe('email.notification.PROJECT_CONFIRM_REQUIRED.line1')
    expect(M.projectConfirmLine1.message).toBe('Вам пропонують участь у проєкті «{projectName}».')
  })
  // … one such pair for EVERY key in the table of Task 1.2 (generate with it.each over a literal
  // [key, id, uk] table written by hand, 42 rows — not over Object.entries(M)).
})

describe('uk / en golden renders (hand-written expectations)', () => {
  it('uk: share-confirm project subject', () => {
    expect(
      renderMessage(createI18n('uk'), M.shareConfirmSubjectProject, { projectName: 'Alpha' }),
    ).toBe('Запит на зміну частки за проєктом «Alpha»')
  })
  it('en: share-confirm project subject', () => {
    expect(
      renderMessage(createI18n('en'), M.shareConfirmSubjectProject, { projectName: 'Alpha' }),
    ).toBe('Request to change your share on the project “Alpha”')
  })
  // … golden uk AND en for every parameterised key (13 keys) and one per non-parameterised group.
})

describe('catalog hygiene', () => {
  const keys = Object.keys(M) as (keyof typeof M)[]
  it('every id is unique and under email.notification.', () => {
    const ids = keys.map((k) => M[k].id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('email.notification.'))).toBe(true)
  })
  it.each(['uk', 'en'] as const)(
    '%s: no ASCII apostrophe artifact in any rendered message',
    (loc) => {
      const i18n = createI18n(loc)
      for (const k of keys) {
        const out = renderMessage(i18n, M[k], {
          projectName: 'P',
          teamName: 'T',
          vacancyTitle: 'V',
          subjectTitle: 'S',
        })
        expect(out).not.toMatch(/'/)
      }
    },
  )
  it.each(['uk', 'en'] as const)(
    '%s: a name in a subject starts no later than the 24th character',
    (loc) => {
      // COPY-L-2: the object name is the only thing two such emails differ by, and a phone inbox
      // shows ~40 chars — the name must start inside the first 24.
      const i18n = createI18n(loc)
      for (const k of [
        'transactionAddedSubjectProject',
        'teamMemberAddedSubject',
        'projectMemberAddedSubject',
        'teamNewMemberSubject',
        'projectConfirmSubject',
        'shareConfirmSubjectProject',
        'vacancyApplicationSubject',
      ] as const) {
        const out = renderMessage(i18n, M[k], {
          projectName: '@@',
          teamName: '@@',
          vacancyTitle: '@@',
        })
        expect(out.indexOf('@@')).toBeLessThanOrEqual(24 + 1) // +1 for the opening quote char
      }
    },
  )
  it.each(['uk', 'en'] as const)('%s: no digits (privacy: no amounts/percentages)', (loc) => {
    const i18n = createI18n(loc)
    for (const k of Object.keys(M) as (keyof typeof M)[]) {
      expect(
        renderMessage(i18n, M[k], {
          projectName: 'P',
          teamName: 'T',
          vacancyTitle: 'V',
          subjectTitle: 'S',
        }),
      ).not.toMatch(/[0-9]/)
    }
  })
})
```

If a subject genuinely cannot meet the 24-char rule in `en` (e.g. “Request to change your share on the project”), shorten the **English** source (second original), do not relax the test; record the final strings in the PR body for copy-reviewer.

- [ ] **Step 2: Run → RED.** `pnpm --filter @crm/shared test notification-email-registry` → FAIL (module not found).
- [ ] **Step 3: Create `notification-email-registry.ts`** — one object literal `export const EMAIL_NOTIFICATION_MESSAGES = { … } ` with every row of the table as `key: /* i18n */ { id: 'email.notification.<suffix>', message: '<uk>' }`. Header comment: purpose, "emails name the object, never a person/amount/percent", "do not move `message` text into code paths: the compiled catalog wins at render, pin `.message` directly in the spec". Export from `schemas/index.ts`.
- [ ] **Step 4: Write `msgstr` by hand** in both `.po` files for every id: `uk` = source text; `en` = the English column (second original). Then `pnpm i18n:extract` **under Node 22** and commit the resulting `.po` diff (CI `catalog-sync` fails on a missing/extra entry; the `.po` references are line-number-free since `037274c61`, so there is no merge drift). Then `pnpm i18n:compile`.
- [ ] **Step 5: Run → GREEN.** `pnpm --filter @crm/shared test notification-email-registry`; `pnpm --filter @crm/shared typecheck && pnpm lint` on the touched files (`mcp__eslint__lint-files`).
- [ ] **Step 6: `wip:` commit + push** (files: registry, its spec, `index.ts`, two `.po`).

### Task 1.3: `email-layout` takes the locale (RED → GREEN)

- [ ] **Step 1: Failing test** in `email-layout.spec.ts`: the existing golden stays (no `lang` passed → `<html lang="ru">`, byte-identical — protects the not-yet-migrated invite); add `renderEmailLayout({ …, lang: 'en' })` → output contains `<html lang="en">` and is otherwise byte-identical to the `ru` golden after replacing that one attribute; same for `'uk'`.
- [ ] **Step 2: RED.** `pnpm --filter @crm/api test email-layout`.
- [ ] **Step 3: Implement** — `EmailLayoutInput` gains `lang?: Locale | 'ru'`; template line becomes `<html lang="${input.lang ?? 'ru'}">`. Comment: the `'ru'` default exists **only** until PR2 migrates the invite; PR2 Task 2.6 removes it.
- [ ] **Step 4: GREEN; wip push.**

### Task 1.4: Copy module renders from the registry in the recipient's locale (RED → GREEN)

- [ ] **Step 1: Write the failing locale snapshot tests** in `notification-email-copy.spec.ts`. Add `render(type, locale)` helper and, **for each of the 13 types, one snapshot of subject + text + buttonLabel in `uk` AND in `en`**, each a hand-written literal (the spec already uses `toBe` goldens of the Russian text — convert them, do not add `toMatchSnapshot` files that a mutation could regenerate silently). Examples:

```ts
it('uk: PROJECT_CONFIRM_REQUIRED — subject, body, button', () => {
  const mail = render('PROJECT_CONFIRM_REQUIRED', 'uk')
  expect(mail.subject).toBe('Запит на додавання проєкту «Alpha»')
  expect(mail.text).toBe(
    'Вам пропонують участь у проєкті «Alpha».\nПроєкт не стартує, доки учасники не відповіли.\n\nВідповісти на запит: https://crm.test/pending',
  )
  expect(mail.buttonLabel).toBe('Відповісти на запит')
})
it('en: PROJECT_CONFIRM_REQUIRED — subject, body, button', () => {
  const mail = render('PROJECT_CONFIRM_REQUIRED', 'en')
  expect(mail.subject).toBe('Request to add the project “Alpha”')
  expect(mail.buttonLabel).toBe('Respond to the request')
})
```

Also (each in uk **and** en): every branch of the existing "reference: branches…" describe (share BASE / PROJECT / project name lost; validated vs rejected; no-project transaction; approvals × {PROJECT, PROJECT*SHARE, BASE_SHARE} × {titled, untitled} × {accepted, rejected} = 12 cases, **each asserted against the whole sentence**, proving the fragment-concatenation is gone); the degradation suite (`Деталі — у CRM.` / `Details are in the CRM.` for unparseable data; legacy type with stored body prints **the stored body verbatim in both locales** — it is data, not catalog; legacy type with stored title uses `source.title`; no link → `Відкрити CRM` / `Open the CRM`); the button for `APPROVAL*\*`on`subjectType: 'USER'`→ «Відкрити профіль» / “Open profile” (**read the actual`en`string from`MISC_MESSAGES.actionApprovalProfile`in the`.po`and hand-write it**), on`PROJECT` → «Відкрити проєкт».
Add the locale-isolation tests:

- alternate renders (`en`, `uk`, `en`, `uk`, same source) each return their own language — no shared state;
- **the global `@lingui/core` singleton is never touched**: `import { i18n as globalI18n } from '@lingui/core'`; record `globalI18n.locale` before, render both locales, `expect(globalI18n.locale).toBe(before)`;
- `renderNotificationEmail` called with no `locale` is a **compile error** (`// @ts-expect-error` test, so removing the requirement fails typecheck).
  Keep the privacy guards (no digits, no person names, one button, no thanks) iterating `['uk','en']`.
- [ ] **Step 2: RED.** `pnpm --filter @crm/api test notification-email-copy`.
- [ ] **Step 3: Implement.** In `notification-email-copy.ts`:
  1. `RenderOptions` → `{ frontendUrl: string; locale: Locale }`.
  2. `BODIES` builders take `(d, i18n)` and return `{ subject, lines }` built **only** via `renderMessage(i18n, M.<key>, { … })` — e.g.

```ts
TRANSACTION_ADDED: (d, i18n) => ({
  subject:
    d.projectName === null
      ? renderMessage(i18n, M.transactionAddedSubject)
      : renderMessage(i18n, M.transactionAddedSubjectProject, { projectName: d.projectName }),
  lines: [renderMessage(i18n, M.transactionAddedLine)],
}),
```

3. Replace `acceptedLine`/`rejectedLine`/`projectPhrase`/`sharePhrase` with one function each that **selects a whole message**:

```ts
function approvalLine(
  decision: 'accepted' | 'rejected',
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
  i18n: I18n,
): string {
  const set = decision === 'accepted' ? ACCEPTED : REJECTED // two hand-written maps of {PROJECT, PROJECT_SHARE, BASE_SHARE} → { titled, untitled }
  const pair = set[subjectKind]
  return subjectTitle === null
    ? renderMessage(i18n, pair.untitled)
    : renderMessage(i18n, pair.titled, { subjectTitle })
}
```

(keep the **two entry points** `acceptedLine`/`rejectedLine` the file's doc comment justifies — a boolean/enum `decision` parameter spawns an unkillable mutant; they become thin wrappers passing a literal map, not a parameter.) 4. Delete `EMAIL_ACTION_LABELS`. `emailActionLabelFor(type, subjectType, i18n)`: approvals → `MISC_MESSAGES.actionApprovalProfile|Project`; the five frozen info types → `ACTION_LABELS[type]`; anything else → `MISC_MESSAGES.open`. `emailAction(source, i18n)` keeps its **structure** (href via `notificationHref`, link fallback) so routing is unchanged — do **not** swap in `notificationActions()` (it prefers `link` over `subjectType/subjectId` for legacy types and would change hrefs; Task 1.1 pins prove it). 5. Action-required types: `{ href: PENDING_PATH, label: renderMessage(i18n, M.sharedRespondButton) }`; no action: `M.sharedOpenCrmButton`. 6. `composeBody(source, i18n)`: unparseable data → `{ subject: renderMessage(i18n, NOTIFICATION_TITLE_MESSAGES[source.type]), lines: [renderMessage(i18n, M.sharedDetailsLine)] }`; unknown type → `{ subject: source.title, lines: [source.body ?? renderMessage(i18n, M.sharedDetailsLine)] }` (stored text is data — unchanged). 7. `const i18n = createI18n(opts.locale)` at the top of `renderNotificationEmail`; pass `lang: opts.locale` to `renderEmailLayout`. 8. Drop the now-unused `NOTIFICATION_TITLES` import; update the file header (remove "Texts of the ten emails" Russian-only claims; keep §10/§11 rules, translated to the English header convention only if the file already mixes — leave existing Russian _comments_ alone, they are not product text).

- [ ] **Step 4: GREEN.** `pnpm --filter @crm/api test notification-email-copy email-layout` and `pnpm --filter @crm/api typecheck`.
- [ ] **Step 5: `typescript-reviewer` self-review** on the milestone files; apply findings; `wip:` commit + push.

### Task 1.5: Recipient locale from the database (RED → GREEN)

- [ ] **Step 1: Failing repository unit test** (`notification-email.repository.spec.ts`, follow the file's existing drizzle-chain style — only the _shape of the returned object_ is asserted; the SQL itself is proven in Step 6): `deliveryContextFor` returns `locale: 'en'` for a row with `users.locale = 'en'`; returns `'uk'` for `'uk'`; **returns `'uk'` for a corrupt value** (`'xx'`, `null`) and when the user row is absent (race with deletion).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** `DeliveryContext` (in `notification-email-outbox.ts`) gains `locale: Locale` with a doc comment ("recipient's language at send time; `decideDelivery` does not read it"). In `deliveryContextFor` add `locale: users.locale` to the select and `locale: resolveLocale([rows[0]?.locale ?? null])` to the returned object. `decideDelivery` is **not** modified — pin: `notification-email-outbox.spec.ts` passes unchanged (add one test: `decideDelivery` result is identical for `locale: 'en'` and `'uk'` contexts, so the field cannot influence delivery decisions).
- [ ] **Step 4: GREEN; wip push.**

### Task 1.6: Cron renders per recipient (RED → GREEN)

- [ ] **Step 1: Failing cron tests** in `notification-email.cron.spec.ts` (gateway fake: extend `deliveryContextFor` to return `locale`):
  - an `en` recipient's row → `mailer.send` receives the **English** subject/text/html (`lang="en"`), literal expectation;
  - a `uk` recipient → Ukrainian + `lang="uk"`;
  - **one `drainOnce` with two rows, `[en-recipient, uk-recipient]`, then the reverse order** → each `send` call carries its own recipient's language (no bleed between consecutive deliveries in a pass);
  - the locale used is the one returned by `deliveryContextFor` **for this item's `userId`** (fake returns different locales per `userId`; assert the call args `(userId, type)`);
  - a retried row (`attempts: 3`) re-reads the locale (change the fake's answer between two `drainOnce` calls → second mail in the new language);
  - **skipped rows** (`USER_ARCHIVED` etc.) never render (renderer spy not called) — unchanged behavior, pinned;
  - the global `@lingui/core` singleton's `locale` is unchanged after the pass (same assertion as Task 1.4).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — in `deliver()`: `renderNotificationEmail(item.notification, { frontendUrl: this.frontendUrl, locale: context.locale })`. **Nothing else changes in the cron**: no new field on the service, no activation call, logs/telemetry/`stripCrlf` untouched (they stay English).
- [ ] **Step 4: GREEN; wip push.**

### Task 1.7: Real-SQL proof (integration, scratch DB only)

Per `live-db-access.md`: **never** `crm_db`; scratch DB, inline `DATABASE_URL`, `SELECT current_database()` first.

- [ ] **Step 1: Failing integration test** in `notification-email-delivery.integration.spec.ts` (follows the file's `f7a10000-…` id space; add two users `USER_EN` (`locale='en'`) and `USER_UK`, each with a PERSONAL address): enqueue one `TEAM_MEMBER_ADDED` per user through the real `NotificationsService`, run the real `NotificationEmailCronService.drainOnce()` against the real `OutboxRepository` with a capturing mailer; assert the English mail went to `USER_EN`'s address and the Ukrainian to `USER_UK`'s, and **the English mail contains no Cyrillic** (`/[А-Яа-яЁёІіЇїЄєҐґ]/` — ASCII team name in the fixture, so any Cyrillic can only come from the catalog). Also: `users.locale` flipped `uk→en` between enqueue and drain → the mail is English (send-time read).
- [ ] **Step 2: Run against the scratch DB → RED**, then GREEN after Task 1.5 (already implemented) — i.e. this test's RED proof is run **before** Task 1.5's implementation commit if sequencing allows; otherwise show RED by temporarily hard-coding `'uk'` and reverting (record the output in the PR body).
- [ ] **Step 3: Skip behaviour:** with `DATABASE_URL=` empty the suite is SKIPPED (the file's `describe.skipIf(!hasDatabaseUrl())`), so the push hook stays safe.

### Task 1.8: Verification gates

- [ ] **Step 1:** `pnpm i18n:extract` (Node 22) → no diff vs committed `.po`; `pnpm i18n:compile`.
- [ ] **Step 2: Mutation gate on ALL changed packages** (the gate runs per package; running only one leaves the other red in CI — lesson of the server-text series):

```bash
MUTATION_PACKAGES="@crm/api,@crm/shared" pnpm mutation:changed
```

(confirm the separator against `scripts/devops/mutation-gate-runbook.md` §env, line ~602; the `vacuum-proof` script uses the single-name form). Kill every survivor with a test; suppress **only** with a written `// Stryker disable next-line <mutator>: <why>` where the mutant is provably unobservable. Expect pressure on: the two approval maps (a swapped pair must fail a whole-sentence golden), `emailActionLabelFor` branches, `resolveLocale` degradation, the `lang` default. `NoCoverage` on anything only the integration spec touches is expected (`mutation-gate-integration-specs.md`) — add a unit double (the gateway fake in Task 1.6 already covers the cron path).

- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm --filter @crm/api test && pnpm --filter @crm/shared test` (unit, `DATABASE_URL=` empty).
- [ ] **Step 4: grep all of `apps/e2e`** for email strings and renderer names: `grep -rn "Запит на\|Запрос на\|Відповісти на запит\|Ответить на запрос\|Доступ до CRM\|Доступ к CRM\|renderNotificationEmail\|notification_emails" apps/e2e` → expected: no hit relying on email text; paste the (empty) result in the PR body. Anything found is updated in this PR.
- [ ] **Step 5: AC-in-diff** (`git diff origin/main --name-only` vs the file list above); `grep -nP "[А-Яа-яЁё]" apps/api/src/notifications/notification-email-copy.ts | grep -v '^\s*[0-9]*:\s*\(//\|\*\|/\*\)'` → **no non-comment hit**.
- [ ] **Step 6: Final commit** `feat(i18n): notification emails render in the recipient's locale` with `ac_verified: 1,2,3,4,5,6,7`. `DATABASE_URL= git push`. Open PR (English body, `Допущения` block with the three copy assumptions, `Reuse & blast-radius` section, RED/GREEN evidence, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`). Dispatch **security-reviewer + copy-reviewer** (+ code-reviewer, spec-reviewer); numbered findings per `review-findings-transfer.md`.

**AC (PR1):**

1. The server renders each notification email in the **recipient's** `users.locale` (`uk`/`en`): subject, body lines, button label — for all **13** types.
2. Subject **and** body snapshot tests exist for **uk and en** for every type, with hand-written expectations (`notification-email-copy.spec.ts`).
3. Legacy/unknown types and unparseable data keep their fallback: stored `title`/`body` printed verbatim; the generic fallbacks are catalog messages in both locales.
4. **0 Russian user-facing literals** in `notification-email-copy.ts`, `email-layout.ts` (`lang` is a locale code), `notification-email.cron.ts`.
5. The cron passes the recipient's locale (unit: per-user, per-pass ordering, retry re-read; integration: real SQL, two recipients, no Cyrillic in the `en` mail).
6. No global i18n state: the shared `@lingui/core` singleton's locale is unchanged after renders (tested); `createI18n(locale)` per call.
7. `pnpm i18n:extract` clean; mutation gate green on `@crm/api` **and** `@crm/shared`; privacy guards (no digits / no names / one button) green in both locales; routing pins (`buttonHref`) unchanged.

---

## Task PR2 — Invite email

**Files:**

- Create: `packages/shared/src/schemas/invite-email-registry.ts`, `packages/shared/src/schemas/invite-email-registry.spec.ts`
- Modify: `packages/shared/src/schemas/index.ts`, `packages/shared/src/i18n/locales/{uk,en}/messages.po`
- Modify: `apps/api/src/users/personal-email-invite-mailer.service.ts`, `apps/api/src/users/personal-email-invite-mailer.service.spec.ts`
- Modify: `apps/api/src/users/users.service.ts` (`createUser` call; `resendPersonalEmailInvite`, `changePersonalEmail` return shapes), `apps/api/src/users/users.controller.ts` (2 call sites)
- Modify: `apps/api/src/common/email-layout.ts` (+ spec) — remove the transitional default
- Modify (tests): `apps/api/src/users/user-email-invites.integration.spec.ts`, `apps/api/src/users/personal-email-controller-guards.rbac.integration.spec.ts`, `apps/api/src/users/users.service.spec.ts`

**Interfaces:**

- Produces: `SendInviteInput = { to: string; displayName: string; rawToken: string; locale: Locale }` (**`locale` required**); `resendPersonalEmailInvite(...)` → `Promise<{ rawToken: string; email: string; displayName: string; locale: Locale }>`; `changePersonalEmail(...)` → `Promise<{ rawToken; email; displayName; locale: Locale } | null>`; `EMAIL_INVITE_MESSAGES` (below); `renderEmailLayout` `lang: Locale` **required**.
- Consumes: `createI18n`, `renderMessage`, `resolveLocale`, `Locale`; `renderEmailLayout`, `escapeHtml`, `trustedHtml`.

**Blast-radius:** `sendInvite` — 3 call sites (`users.service.ts` `createUser`, `users.controller.ts` ×2) + `personal-email-invite-mailer.service.spec.ts`; `resendPersonalEmailInvite`/`changePersonalEmail` return shapes — controller + `users.service.spec.ts` + integration specs; `renderEmailLayout` `lang` becoming required — copy module (already passes it) + invite + spec. Find with `mcp__codegraph__codegraph_callers`; pin the current return objects with `toEqual` **before** adding `locale`.

**Registry content** (`email.invite.<slot>`):

| key             | id suffix        | uk                                                                       | en                                                                                         |
| --------------- | ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `subject`       | `subject`        | `Доступ до CRM CheekyCheeseIT`                                           | `Access to CheekyCheeseIT CRM`                                                             |
| `greeting`      | `greeting`       | `{firstName}: цю адресу додали до CRM CheekyCheeseIT як вашу особисту.`  | `{firstName}, this address was added to CheekyCheeseIT CRM as your personal one.`          |
| `confirmLine1`  | `confirm.line1`  | `Підтвердіть її — тоді входити можна буде і з робочої адреси, і з цієї.` | `Confirm it — then you will be able to sign in with either your work address or this one.` |
| `confirmLine2`  | `confirm.line2`  | `Доки не підтвердите, вхід працює лише за робочою адресою.`              | `Until you confirm, sign-in works only with your work address.`                            |
| `button`        | `button`         | `Підтвердити адресу`                                                     | `Confirm address`                                                                          |
| `footer`        | `footer`         | `Якщо лист прийшов помилково, {warning}.`                                | `If this email reached you by mistake, {warning}.`                                         |
| `footerWarning` | `footer.warning` | `не переходьте за посиланням`                                            | `do not follow the link`                                                                   |

Notes for copy-reviewer (put in the PR body as assumptions): (a) the legacy greeting put the first name at the start of a sentence — in `uk` that slot is the **vocative** («Олексію»), which template K (nominative only) cannot produce, so the `uk` source uses the label form `{firstName}: …`; `en` has no case and keeps the comma form. (b) The old `uk`-less original kept `<strong>` on the warning (COPY-M-5: the disclaimer is not the palest text on the page) — preserved via Decision D5.

### Task 2.1: Locale of the invitee reaches `sendInvite` (RED → GREEN)

- [ ] **Step 1: Pin current return shapes** (`users.service.spec.ts` / integration): `resendPersonalEmailInvite` returns exactly `{ rawToken, email, displayName }`, `changePersonalEmail` the same or `null`. GREEN on `origin/main`. `wip:` commit.
- [ ] **Step 2: Failing tests:** (a) both return `locale` equal to the target user's stored `users.locale` (`'en'` row → `'en'`; `'uk'` → `'uk'`; corrupt → `'uk'` via `resolveLocale`); (b) `createUser` passes the **created row's** locale to `sendInvite` (`data.locale = 'en'` → `sendInvite` called with `locale: 'en'`; no `data.locale` → `'uk'`, the same expression as the inserted column `data.locale ?? 'uk'`, so mail and row cannot diverge); (c) controller: `resendPersonalEmailInvite` / `changePersonalEmail` pass `locale` from the service result, **and an admin whose own request carries `pref_locale=en` / `Accept-Language: en` invites a `uk` user → `sendInvite` gets `'uk'`** (the sender's locale never leaks into the recipient's mail).
- [ ] **Step 3: RED → implement.** Select `users.locale` where `target`/`row` are already loaded (both methods already read the `users` row for `displayName`); add `locale: resolveLocale([target.locale])` to the returned objects; thread through the three call sites. Do **not** inject `@RequestLocale()` into these handlers.
- [ ] **Step 4: Extend the controller RBAC 403-spec** (`personal-email-controller-guards.rbac.integration.spec.ts`; FM-5): non-ADMIN → 403 on both endpoints, unchanged by this PR — proves the surface was not loosened while threading a new field.
- [ ] **Step 5: GREEN; wip push.**

### Task 2.2: Registry + catalog (RED → GREEN)

- [ ] **Step 1: Failing `invite-email-registry.spec.ts`** — same three groups as Task 1.2 (direct `.id`/`.message` pins for all 7 keys; hand-written uk and en goldens incl. `greeting` with a Latin first name and with a Cyrillic one; no-apostrophe-artifact; ids unique under `email.invite.`).
- [ ] **Step 2: RED → create registry → `msgstr` by hand (uk+en) → `pnpm i18n:extract` + commit `.po` → GREEN.** `wip:` push.

### Task 2.3: Mailer renders the invite per locale (RED → GREEN)

- [ ] **Step 1: Failing mailer tests** (`personal-email-invite-mailer.service.spec.ts`; keep all existing structural/escaping/retry/telemetry tests, convert text goldens): for `locale: 'uk'` and `'en'` (hand-written literals):
  - `subject`, `text` (full, line by line), `html` blocks, button label, footer — each language;
  - `html` is `<html lang="uk">` / `<html lang="en">`;
  - first name = first whitespace token of `displayName`, `escapeHtml`-ed in `html`, raw in `text` (existing `<script>` substitution test, now in both locales);
  - footer: the warning phrase is wrapped in `<strong>…</strong>` **inside the footer sentence in both locales**, and the `text` twin has the same sentence without tags;
  - **no Cyrillic in the `en` mail** (ASCII display name fixture);
  - two invites in a row, `en` then `uk` then `en`: each carries its own language; global `@lingui/core` singleton locale unchanged;
  - not-configured path (`RESEND_API_KEY` missing) still returns `false` and records telemetry with the **English** message (service text, unchanged);
  - `sendInvite` without `locale` is a compile error (`@ts-expect-error`).
- [ ] **Step 2: RED → implement.** In `sendInvite`: `const i18n = createI18n(input.locale)`; `subject = renderMessage(i18n, M.subject)`; render each line with `renderMessage`; HTML twin = `escapeHtml(rendered)` for the greeting (the name is user input — the old code escaped `firstName` before interpolation; now the **whole rendered sentence** is escaped, which is equivalent and safer), `trustedHtml` only for the two literal lines; button label from `M.button`; `renderEmailLayout({ lang: input.locale, … })`. Remove all Russian literals and the stale `Доступ к CRM CheekyCheeseIT`/`Подтвердить адрес` comments' claims about copy being Russian.
- [ ] **Step 3: GREEN; wip push.**

### Task 2.4: Footer emphasis without fragment assembly (Decision D5)

- [ ] **Step 1: Failing test** for a tiny exported helper `emphasize(sentence: string, phrase: string): EscapedHtml` (in `common/email-layout.ts`'s neighbour `escape-html.ts` or the invite file — whichever the reuse check finds; `ast-grep` for an existing helper first): `emphasize('If this email reached you by mistake, do not follow the link.', 'do not follow the link')` → `'If this email reached you by mistake, <strong>do not follow the link</strong>.'`; the surrounding text and the phrase are each `escapeHtml`-ed (`'a < b, <i>x</i>'` stays inert); a phrase **not found** in the sentence → the escaped sentence, no tag, no throw (and a test that the real `uk` and `en` footer strings both **do** contain their warning phrase, so the not-found branch is a guard, not a live path); only the **first** occurrence is wrapped.
- [ ] **Step 2: RED → implement:** split on the first `indexOf(phrase)`, `escapeHtml` each side, join with `<strong>`/`</strong>` via `trustedHtml`. Use it for the invite footer: `emphasize(renderMessage(i18n, M.footer, { warning: renderMessage(i18n, M.footerWarning) }), renderMessage(i18n, M.footerWarning))`.
- [ ] **Step 3: GREEN; wip push.**

### Task 2.5: Real-flow proof

- [ ] **Step 1:** `user-email-invites.integration.spec.ts` (scratch DB): create a user with `locale: 'en'` and a personal address through the real service → the captured invite is English and `<html lang="en">`; `resend-invite` on a `uk` user while the admin's request carries `en` → Ukrainian; `changePersonalEmail` → the new address gets the invitee's locale. Empty `DATABASE_URL` → SKIPPED.
- [ ] **Step 2: RED→GREEN evidence** captured for the PR body.

### Task 2.6: Layout `lang` becomes required

- [ ] **Step 1: Failing test:** `renderEmailLayout({ blocks, button })` without `lang` is a compile error (`@ts-expect-error`); the old `lang="ru"` golden test is replaced by `uk`/`en` goldens; grep proves no `'ru'` remains in `email-layout.ts`.
- [ ] **Step 2: RED → implement:** `lang: Locale` required, drop the default and the `| 'ru'` union member.
- [ ] **Step 3: GREEN.**

### Task 2.7: Verification gates (same as 1.8, for this PR's files)

- [ ] `pnpm i18n:extract` clean · `MUTATION_PACKAGES="@crm/api,@crm/shared" pnpm mutation:changed`, kill survivors (watch: `firstName` split regex — an existing documented suppression; `emphasize` branches; the three call-site locale arguments) · `pnpm typecheck && pnpm lint && pnpm test` · `grep -rn` over `apps/e2e` for invite strings (`Доступ к CRM`, `Доступ до CRM`, `Подтвердить адрес`, `Підтвердити адресу`) — expected empty · non-comment Cyrillic grep on `personal-email-invite-mailer.service.ts` → none · AC-in-diff.
- [ ] **Final commit** `feat(i18n): personal-email invite renders in the invitee's locale` + `ac_verified:`; push; PR; **security-reviewer + copy-reviewer**.

**AC (PR2):**

1. The invite email's subject, body, button and footer are rendered in the **invitee's** `users.locale` (uk/en) — from the catalog; `<html lang>` matches.
2. All three senders (`createUser`, `resend-invite`, `change personal email`) pass the invitee's locale; the **admin's request locale/cookie never** affects the invite (tested).
3. Subject + body snapshot tests for uk **and** en; the escaped greeting, the `<strong>` footer and the retry/telemetry behavior preserved.
4. 0 Russian user-facing literals in `personal-email-invite-mailer.service.ts`; `renderEmailLayout`'s transitional `'ru'` default is gone.
5. RBAC 403-spec for the two endpoints extended (FM-5) and green.
6. i18n extract clean; mutation gate green on `@crm/api` and `@crm/shared`.

---

## Task PR3 — Close-out guard

**Files:**

- Create: `apps/api/src/common/email-no-cyrillic-literals.spec.ts`
- Modify: stale comments in `notification-email-copy.ts` / `personal-email-invite-mailer.service.ts` that still say the copy is Russian or "frozen until Task 7"
- Modify: `.claude/agents/project-state.md` (one line: emails render in the recipient locale; registries' names; pointer to this plan) — **zone-of-write:** Coder may not edit `.claude/agents/**` → if the executor is a Coder, write the proposed line into the PR body and let PM/Architect apply it; do not edit.
- Test: the new spec itself

**Interfaces:** Consumes the file list below; produces no runtime API.

- [ ] **Step 1: Failing test** `email-no-cyrillic-literals.spec.ts`: parse each email module with the TypeScript compiler API (`ts.createSourceFile`, already a transitive dev dependency of the repo) and walk `StringLiteral`, `NoSubstitutionTemplateLiteral`, `TemplateHead/Middle/Tail`, collecting `node.text`; assert none matches `/[А-Яа-яЁёІіЇїЄєҐґ]/`. Comment-proof by construction (comments are trivia, not nodes). Files (explicit literal list, plus a test that each exists so a rename fails loudly): `common/email-layout.ts`, `notifications/notification-email-copy.ts`, `notifications/notification-email.cron.ts`, `users/personal-email-invite-mailer.service.ts`. Add a **self-test** with an in-memory source string containing a Cyrillic literal in code and one in a comment → exactly one finding (so the guard can go red; mutation gate would otherwise flag it as vacuous).
- [ ] **Step 2: RED/GREEN honesty:** run it against `origin/main` (pre-PR1) by checking out the four files from that commit into a temp path via `git show origin/main~N:<path>` (scratchpad, **not** the repo) → it must FAIL there; on the branch → PASS. Record both outputs in the PR body.
- [ ] **Step 3: Cleanup** stale comments (comments only, no behavior); `pnpm typecheck && pnpm lint`.
- [ ] **Step 4: Gates:** `MUTATION_PACKAGES="@crm/api" pnpm mutation:changed` (comment-only + spec changes should produce 0 mutants; record it), `pnpm test`.
- [ ] **Step 5: Final commit** `test(i18n): guard email modules against Cyrillic literals` + `ac_verified:`; PR; **security-reviewer** (light: no product change — a one-line confirmation is the expected outcome; still mandatory per the plan's rule).

**AC (PR3):** the guard fails on a Cyrillic literal in code and ignores comments; passes on the migrated modules; no product behavior change (diff is spec + comments).

---

## Risks and decisions

**R1 — Cron locale activation: per-call, not global (HIGH, the #749 class).** `@lingui/core` exports a global `i18n`; the web uses it as the activated singleton. If the cron did `i18n.activate(locale)` before rendering, any `await` between activation and render (and the cron awaits constantly: `deliveryContextFor`, `resolveSubjectState`, `mailer.send`) could let another delivery or request flip the locale mid-render. Mitigation baked into the contract: `renderNotificationEmail` builds its own `createI18n(locale)`; the locale is a **function argument** end to end (`context.locale` → opts → i18n), stored nowhere; tests assert (a) alternating renders, (b) the global singleton is untouched, (c) omitting `locale` does not compile. The spec's wording "the cron activates the recipient's locale" is satisfied in the safe form — _a recipient-bound instance is created before rendering_ — and this deviation from the literal word "activates" is recorded in the PR body for the security-reviewer.

**R2 — Wrong recipient's locale (HIGH).** Only `users.locale` of the row the mail is addressed to; read in the same method that reads the address and archived flag (one user id, one moment). Never a cookie/header (no request in a cron; an admin's request in the invite flow). Integration tests use two recipients with different locales in one pass.

**R3 — `outbox` is not email text (resolved, D1).** `notification-email-outbox.ts` contains zero Cyrillic non-comment literals (verified): `decideDelivery`, `SkipReason` codes, `MAX_EMAIL_ATTEMPTS`, one English `Error`. Only its `DeliveryContext` **type** gains a field. Logs/telemetry/skip reasons stay English and are not migrated.

**R4 — Invite before first login (D2).** The invitee has a `users` row (with `locale`, set in the creation wizard, default `uk`) **before** the mail is sent, so §4.1's "before login — cookie `pref_locale`" case does not arise for this email — that fallback chain serves the `/login` page the invitee lands on afterwards (web, already migrated). The only request present at send time is the **admin's**; using its cookie/`Accept-Language` would write the invitee's mail in the admin's language. Residual product risk: the admin forgets to set the wizard's language field, so an English-speaking hire gets a Ukrainian invite — mitigated by the wizard field (spec §4.6) and the admin's ability to resend after fixing the locale in the profile; not solved by guessing from the admin's session.

**R5 — HTML/escaping regressions (MED).** Sentence-level escape after render is equivalent to today's per-substitution escape _only because_ ICU does not escape params and the layout's `EscapedHtml` brand forces every block through `escapeHtml`/`trustedHtml`. The existing `<script>`-in-name tests run in both locales for both senders. The invite footer is the one place with markup — isolated in the `emphasize` helper with its own tests (D5).

**R6 — ICU traps (MED).** ASCII apostrophe = escape char (guarded by spec); `{`/`}` in user names are safe (params are not parsed); a name that itself contains `{x}` must render literally — add one test string `'{projectName}'` as a project name in both locales.

**R7 — Mixed-language windows (MED).** PR1 is atomic per type family on purpose; between PR1 and PR2 the invite is still Russian (documented transitional default `'ru'`), a short window since PRs merge sequentially. Deploy after PR2 if the window matters.

**R8 — Legacy rows (LOW).** Queued `notification_emails` rows created before deploy render in the recipient's locale at send time (the text is composed at send, not stored) — no data migration. Legacy-type rows with stored `title`/`body` remain Russian by design (data, aging out; server-text plan Q2).

**Decisions (A1 unless marked):**

- **D1 (A1)** `notification-email-outbox.ts`, `resend-mailer.service.ts`, `mailer.module.ts`: outside the perimeter (service). Reversible.
- **D2 (A1)** Invite locale = invitee's `users.locale`; cookie/`Accept-Language` not used. Reversible (one argument at three call sites).
- **D3 (A1)** Cron wiring is per-call `createI18n`, not `activate` (R1). Reversible.
- **D4 (A2 — ask in the next decision brief)** `contact.service.ts` sends a Russian **internal** email to the company's public inbox («Заявка с сайта»). It is staff-facing, has no recipient locale and no CRM user; the same file's `UnprocessableEntityException` prose goes to **landing** visitors (own 5-language mechanism / error-code track). **Recommended: leave as is** (internal ops text; staff read Russian/Ukrainian); revisit only if the owner wants the inbox in `uk`. Cost of deferral: none user-visible. Not blocking.
- **D5 (A1)** Invite footer emphasis via `emphasize(sentence, phrase)` (render the whole sentence, then wrap the known catalog phrase), not by splitting the sentence into two messages (a split would fix the word order across locales).
- **D6 (A1)** `SHARE_CONFIRM_REQUIRED` project subject says «частка», dropping the legacy «процент» exception (glossary; in-app canon already says «частка»). copy-reviewer may overrule.
- **D7 (A1)** Buttons for the five info types and approvals reuse the in-app `ACTION_LABELS` / `MISC_MESSAGES` descriptors instead of a second parallel map (the freeze that justified a separate email map — «CR-M-1 until Task 7» — ends with this migration). Routing code (`emailAction`) is intentionally **not** replaced by `notificationActions()` (different href precedence for legacy rows).

---

## Self-Review

- **Spec coverage:** §4.1 (recipient locale from `users`, not sender) → Contract 4/5, Tasks 1.5/2.1, R2/R4. §4.4 (copy + subject from catalog; legacy fallback; locale before render) → Tasks 1.2–1.4, 1.6, R1. §4.2 (one catalog, explicit ids, uk source) → Global Constraints + Tasks 1.2/2.2. Brief's AC (recipient-locale render; uk/en subject+body; legacy fallback; 0 Russian; cron right locale test) → PR1 AC 1–5, PR2 AC 1–4, PR3. Brief's risks (cron activation, outbox vs body, invite before login) → R1, R3, R4. Mandatory prophylaxis (extract + `.po`; mutation gate on **all** changed packages; uk+en snapshot of subject and body in `copy.spec`/`cron.spec`; grep all `apps/e2e`; Node 22; security-reviewer per PR) → Tasks 1.8 / 2.7 / PR3 + Global Constraints.
- **Placeholder scan:** every message has literal uk and en; every step names files, the failing test and the shape of the change; the one deliberately open item (the exact `MUTATION_PACKAGES` separator) names the file/line to confirm and gives the single-name precedent. "Same as 1.8" in Task 2.7 lists the PR-specific gates explicitly.
- **Type consistency:** `locale: Locale` is required everywhere it is introduced (`renderNotificationEmail` opts, `DeliveryContext`, `SendInviteInput`, resend/change return shapes, `renderEmailLayout` after Task 2.6); registry names `EMAIL_NOTIFICATION_MESSAGES` / `EMAIL_INVITE_MESSAGES` and key names match across tasks; `acceptedLine`/`rejectedLine` stay two entry points as the file's own mutation rationale requires.
- **Reuse-first:** `createI18n`, `renderMessage`, `resolveLocale`, `ACTION_LABELS`, `MISC_MESSAGES`, `NOTIFICATION_TITLE_MESSAGES`, `renderEmailLayout`, `escapeHtml`/`trustedHtml`, `stripCrlf` reused; the only new helper (`emphasize`) is preceded by an `ast-grep` reuse check (Task 2.4).
- **Blast-radius:** `renderNotificationEmail`, `renderEmailLayout`, `DeliveryContext`/`deliveryContextFor`, `sendInvite` and the two `users.service` return shapes each have their call-sites listed and pinned before change.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-03-crm-i18n-emails.md`. Two execution options:

1. **Subagent-Driven (recommended)** — one fresh subagent per PR (PR1 → PR2 → PR3, sequential because of the shared `.po`), security-reviewer + copy-reviewer between PRs.
2. **Inline Execution** — execute PRs in this session via executing-plans with checkpoints.
