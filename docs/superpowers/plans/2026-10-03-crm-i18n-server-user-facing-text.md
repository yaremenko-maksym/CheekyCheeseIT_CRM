# CRM i18n — Server-Composed User-Facing Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each **PR** below is an independently reviewable, independently mergeable unit; implement one PR per branch, open it, run review (security-reviewer mandatory), merge, then rebase the next.

**Goal:** Remove every remaining user-facing Russian string that `apps/api` **composes into a DTO/notification payload** and the already-localized (uk/en) web renders verbatim, by having the server emit a stable structure (code/kind + params) that the client renders in the **viewer's** locale through the Lingui catalog.

**Architecture:** The CRM web is fully on uk/en (stages 2, 4, waves 3a–3e). The residual leaks are places where the server builds the final human string itself (pending-row titles, virtual-contract document names, the company-account counterparty label, a handful of null-name fallback labels, and a few data-at-rest columns). The fix follows the pattern already proven by the API-error registry and the notification registry: **server ships a machine identifier + parameters; client owns the words.** No server string is translated in place; the server stops producing prose.

**Tech Stack:** NestJS 11 + Fastify + Drizzle (api) · Zod v4 + `@crm/shared` (shared SSOT) · React + TanStack + Lingui `5.9.5` (web) · Vitest (unit) + Playwright (E2E). Catalog: `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

**Spec / source of truth:** owner decision 2026-10-03 (this text is priority over emails/PDF); audit `docs/architecture/2026-09-19-crm-i18n-audit.md` (Table B row "Server-provided text takes priority over client text"; EXPENSE data-at-rest precedent, line ~470); memory `project_crm_i18n_2026_09`. This plan was produced from a live audit of `apps/api/src` (`git grep -nP '[а-яА-ЯёЁ]'` filtered to non-comment/non-log string literals → 486 candidates → classified below).

---

## Global Constraints

Copied verbatim from the i18n programme; every task's requirements implicitly include this section.

- **Lingui version:** `5.9.5` EXACT across `@lingui/*` (see `version-pins.md`). Do not bump.
- **Macro usage:** `msg` for module-scope descriptors; `<Trans>` / `useLingui().t` in components; **`<Plural>` or `i18n._`, never `plural()`**.
- **`satisfies`, not `as const`** for registry record literals (lets TS check exhaustiveness against the key union).
- **Explicit-id catalogs:** when a descriptor uses an explicit `id`, add the matching `msgstr` to both `uk` and `en` `.po` **by hand**; **en is a second original, not a copy of uk.**
- **Three-arg `i18n._(id, params, { message })`** (triarg) at every render site — mirrors `translateApiError` / `renderMessage`; a message-descriptor object literal passed to `i18n._` breaks `lingui extract`.
- **Case:** substitute names/roles/projects in the **nominative only** (template K). Never let the server build a cased phrase; the client sentence is written so no case agreement is needed.
- **Glossary (`CONTEXT.md`):** `частка` (share), `контракт`/`договір` (per glossary), `сеньйор`, `дроп`. A term from a glossary `_Избегать_` list is a review finding.
- **No raw Russian/Ukrainian literal** in any migrated surface — guarded by the `ы э ъ ё` letter-guard (i18n stage 6) and `no-unlocalized-strings`.
- **E2E:** after any web change, run the FULL `apps/e2e` sweep **plus** api-integration; use `assertInCatalog` for catalog coverage. Do **not** run the heavy E2E locally on a loaded machine — let CI be the arbiter (push, read `gh run`).
- **guard-test-gate FM-5:** if a PR edits an `apps/api` **controller**, it must add/extend the controller's RBAC 403-spec in the same PR.
- **Data-at-rest / DDL:** any column-value migration ships through `.github/workflows/deploy.yml` (fail-loud, idempotent SQL), passes security + DDL review, and prod values/counts come from the **owner over SSH**, never a public Actions log (EXPENSE wave 3d precedent).
- **Push:** `DATABASE_URL= git push`. Commit trailer `ac_verified:` required on the final (non-`wip:`) commit of each PR.
- **security-reviewer is MANDATORY on every PR here** — all touch finance/RBAC/data surfaces.

---

## Perimeter — what this plan covers and what it deliberately excludes

**IN SCOPE — server composes a human string into a DTO / notification-data param that the localized web renders verbatim:**

| #                   | Source (file · symbol)                                                                                                                                                                                                | String(s)                                                                                                                                       | Reaches client via                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1                  | `pending/pending.service.ts` · pending builders (L181, L273, L516, L554)                                                                                                                                              | `'Ваш контракт'`; `'Доля по проекту «{companyName}»'`; `'Доля по умолчанию'` / `'Доля по умолчанию — {name}'`; `proposedByName ?? 'Неизвестно'` | `PendingItemDto.title` (`pending.ts`, `title: z.string()`) → `PendingItemRow` `{item.title}`                                                                                                          |
| S2                  | `documents/documents.service.ts` · `mapContractVirtualEntry` (L635–640); `contracts/employee-contracts.service.ts` L219                                                                                               | `'Трудовой договор {num}'` / `'Трудовой договор'` / `… (к подписанию)'` / `… (черновик)'`; notification `data.documentTitle: 'Ваш контракт'`    | document DTO `name` → `document-card/row/detail` (`originalName ?? name`); notification `data` param                                                                                                  |
| S3                  | `finance/company-account.service.ts` L375/L734 (writes); `finance/transactions.service.ts` `isInternalCompanySide` L838 (sentinel), L5352/L8370 (assignments)                                                         | `'Счёт компании'`                                                                                                                               | `TransactionDto.senderLabel`/`receiverLabel` (`mapTx`, `toTransactionDto`) → finance tables/dialogs. **Data-at-rest** in `transactions.sender_label`/`receiver_label` **and** a runtime RBAC sentinel |
| S4                  | `legends/legends.service.ts` L176 (`'Неизвестный'`); `approvals/approvals.service.ts` L264 (`'Сотрудник'`); `finance/transactions.service.ts` L4968 (`'— (пользователь удалён)'`)                                     | null-name fallback labels                                                                                                                       | respective DTOs → web                                                                                                                                                                                 |
| S5 (decision-gated) | `teams/teams.service.ts` L1196; `users/users.service.ts` L1007/L3561 (`'Команда {name}'`); transaction **system-notes** `transactions.service.ts` L4442/L6215/L6308/L6358, `pending-settlement.service.ts` L1246–1247 | auto team-name; server-written `notes`                                                                                                          | **Data-at-rest** (`teams.name`, `transactions.notes`) → web                                                                                                                                           |

**OUT OF SCOPE (with reason — each verified during the audit):**

- **Raw-prose `throw new NotFoundException('…')` / `ForbiddenException('…')` etc.** — a large tail (`vacancies.service` 10, `credentials.service` 14, `vacancies/applications.service` 13, `users/archived-entitlement`, …). These **do** reach the user verbatim (`extractBackendMessage` Priority 2 → `getUserFacingErrorMessage` → toast), so they are a real leak — but they are the **continuation of the stage-4 API-error-code migration** (same mechanism: `apiError(code, status, params)` + registry), which the owner scoped as "api error codes … do not touch". Folding dozens of throw-sites into this plan would duplicate that track and balloon it past 4 PRs. **Raised as Decision Q1 below; recommended as a separate plan.**
- **`job-sourcing/*`** raw-prose errors — module is **paused** (memory `project_resume_autosubmit_paused`, "do not touch the job-sourcing code"). Excluded regardless of channel.
- **PDF / invoice / contract / typst / ToS rendering** (`invoice-pdf.service` 41, `invoices.service` 20, `contract-pdf.service` 14, `contract-rendering` 9, `resume-typst` 6, `tos-pdf` 1, `default-resume.typ` 8) — the **PDF track**, deprioritized by the owner behind this one.
- **Email copy** (`notification-email-copy` 49, `personal-email-invite-mailer` 12, `notification-email.cron` 3, `resend-mailer` 1) — the **email track**, deprioritized by the owner.
- **Logs** (`[onchain-registry] …`, `createMonthlySalaries: …`, every `this.logger.*`) — owner decision: logs stay; existing ones non-critical.
- **Internal sentinels mapped to codes:** `users.service.ts` L138/L149 (`GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE`, `INVITE_TARGET_ARCHIVED_MESSAGE`) are compared by identity in `auth.controller.ts mapInviteAcceptError` and surface as `?error=` codes the **already-localized** `login.tsx` owns. Not user-facing prose.
- **Notification title/body residual — VERIFIED EFFECTIVELY CLOSED.** `renderNotification` (`packages/shared/src/schemas/notification-registry.ts` L1177–1190) renders `title`/`detail` **by `type` through `NOTIFICATION_TITLE_MESSAGES`** for every registered type with valid `data`; it falls back to the raw DB `n.title`/`n.body` **only** for an unknown/legacy `type` or unparseable `data`. All current producers write registry types (e.g. `projects.service` `title: NOTIFICATION_TITLES.PROJECT_CONFIRM_REQUIRED`), so **no new Russian is produced**; the only residue is legacy DB rows shown via fallback — a data-at-rest aging-out question folded into Decision Q2, not a code gap. (Exception captured as S2: `employee-contracts.service` L219 injects a Russian `data.documentTitle` **param** — that one is in scope.)
- **Seed data, comments, test helpers, glyph tables** (`resume-glyphs` is Cyrillic glyph _detection_, not copy; `resume-ai` prompts are internal).
- **Resume extraction internals** — processing text, not UI copy.

---

## Contract design (applies to all PRs)

Three shapes, chosen per source:

1. **Composed title/name → `kind` + `params`** (S1, S2). Server emits a stable discriminant plus a nominative-only param bag; the client renders through a small shared **title registry** mirroring `notification-registry.ts` (`renderMessage` + a `Record<Kind, MessageDescriptor>` built with `satisfies`). Reuse the existing `renderMessage` from `notification-registry.ts` — do not write a second renderer.
2. **Null-name fallback → `null` + client fallback** (S4). Server returns `null` instead of a Russian placeholder; the client renders the localized fallback (`«Невідомо»` / `«Користувача видалено»`) via catalog. Simplest shape; no new enum.
3. **Data-at-rest → stable code + migration** (S3, S5). Column stores a code, not prose; existing rows migrated via `deploy.yml`; client maps the code to catalog text. For S3 the target code (`'COMPANY'`) **and its localized render already exist** on the web (`TransactionRow.tsx` L144 `if (label === 'COMPANY') return companyLabel`) — this PR converges data + server writes onto that path rather than inventing anything.

**RBAC invariant (every PR, flag for security-reviewer):** the structure must reveal **no more than the string already did**. A param (`projectName`, `seniorName`, `companyName`) may be sent only to a viewer who was already receiving that same datum inside the Russian string. For S3, counterparty masking in `mapTx` (`isInternalCompanySide` → non-privileged see `'CheekyCheeseIT'`) must be preserved exactly; changing the sentinel from `'Счёт компании'` to `'COMPANY'` must not widen who sees the real label. Compare against PR2 #740 (`GET /projects/:id` guarded) — do not let a project-name param ride to a viewer without project access.

---

## File structure

**Shared (`packages/shared/src/`):**

- `schemas/pending.ts` — add `titleKind` enum + `titleParams` to pending item DTOs; keep `title` during transition (back-compat), drop in the same PR's final step once web no longer reads it.
- `schemas/pending-title-registry.ts` _(new)_ — `PENDING_TITLE_MESSAGES: Record<PendingTitleKind, MessageDescriptor>` + re-use `renderMessage`.
- `schemas/documents.ts` (or wherever the document DTO lives) — add virtual-contract `nameKind` + `contractNumber` param (nullable; real docs leave them null).
- `schemas/document-name-registry.ts` _(new)_ — `CONTRACT_NAME_MESSAGES`.
- `schemas/transaction.ts` — document that `senderLabel`/`receiverLabel` may be the code `'COMPANY'` (no schema change if already `z.string().nullable()`; add a test pinning the contract).
- `i18n/locales/{uk,en}/messages.po` — msgstr for every new id (hand-written, en ≠ uk).

**API (`apps/api/src/`):** `pending/pending.service.ts`, `documents/documents.service.ts`, `contracts/employee-contracts.service.ts`, `finance/company-account.service.ts`, `finance/transactions.service.ts`, `legends/legends.service.ts`, `approvals/approvals.service.ts`, `teams/teams.service.ts`, `users/users.service.ts` — stop composing prose; emit structure. Plus a Drizzle data-migration for S3 (and S5 if accepted), wired into `deploy.yml`.

**Web (`apps/web/app/`):** `components/pending/PendingItemRow.tsx` + `PendingKindSection.tsx`; `components/documents/document-card.tsx` + `document-row.tsx` + `document-detail-dialog.tsx`; `routes/_authenticated/finance/components/TransactionRow.tsx` + `ActiveTransactionsTable.tsx` + finance dialogs; plus the fallback-label render sites for S4.

---

## PR decomposition & merge order

Four PRs. Each = api + shared + web atomic (the contract and its only consumer ship together; splitting them breaks the render). Merge **sequentially** to avoid `.po` conflicts (every PR appends to the same `uk`/`en` catalogs): **PR1 → PR2 → PR3 → PR4**, rebasing each on the previous. PR1/PR2/PR4 touch disjoint product surfaces; PR3 is the only one touching the money ledger and carries the data migration.

- **PR1 — Pending-row titles → structured** (S1). Highest value, no data-at-rest, smallest blast radius.
- **PR2 — Virtual-contract document name → structured** (S2, incl. S2 notification param).
- **PR3 — Company-account counterparty label → `'COMPANY'` code + data migration** (S3). Converges onto the existing web `'COMPANY'` path; carries the only required DDL/data migration and the RBAC-sentinel change.
- **PR4 — Null-name fallbacks + data-at-rest decisions** (S4 always; S5 only if Decision Q2 accepts). May ship S4 alone if S5 is deferred.

---

## Task PR1 — Pending-row titles → structured

**Files:**

- Modify: `packages/shared/src/schemas/pending.ts`
- Create: `packages/shared/src/schemas/pending-title-registry.ts`
- Modify: `packages/shared/src/i18n/locales/uk/messages.po`, `.../en/messages.po`
- Modify: `apps/api/src/pending/pending.service.ts` (L181, L273, L516, L554 and their builders)
- Modify: `apps/web/app/components/pending/PendingItemRow.tsx`, `apps/web/app/components/pending/PendingKindSection.tsx`
- Test: `apps/api/src/pending/pending.service.spec.ts` (+ any `pending.*integration.spec.ts`), `packages/shared/src/schemas/pending-title-registry.spec.ts`, `apps/web/app/components/pending/__tests__/PendingItemRow.test.tsx`, `apps/e2e` pending specs

**Interfaces:**

- Produces: `PendingTitleKind = 'CONTRACT' | 'SHARE_PROJECT' | 'SHARE_BASE_MINE' | 'SHARE_BASE_OTHER' | 'PROJECT_APPROVAL'`; `PendingItemDto.titleKind: PendingTitleKind`; `PendingItemDto.titleParams: { projectName?: string; seniorName?: string }` (nominative only); `PENDING_TITLE_MESSAGES: Record<PendingTitleKind, MessageDescriptor>`.
- Consumes: existing `renderMessage(i18n, descriptor, params)` from `notification-registry.ts`; existing `pendingItemKindSchema` discriminated union.

- [ ] **Step 1: Write the failing shared test** — `pending-title-registry.spec.ts`: assert `PENDING_TITLE_MESSAGES` has an entry for every `PendingTitleKind` (exhaustiveness), each descriptor has a non-empty `message`, and `renderMessage` substitutes `{projectName}` / `{seniorName}` without case mutation.
- [ ] **Step 2: Run it, confirm RED** — `pnpm --filter @crm/shared test pending-title-registry` → FAIL (module missing).
- [ ] **Step 3: Create the registry** — `pending-title-registry.ts` with the enum + `satisfies Record<PendingTitleKind, MessageDescriptor>`, descriptors e.g. `CONTRACT: msg\`Ваш контракт\``(uk) → id-keyed;`SHARE_PROJECT: msg\`Частка за проєктом «{projectName}»\``; `SHARE_BASE_MINE: msg\`Частка за замовчуванням\``; `SHARE_BASE_OTHER: msg\`Частка за замовчуванням — {seniorName}\``; `PROJECT_APPROVAL`as needed. Add`uk`+`en` msgstr by hand.
- [ ] **Step 4: Run it, confirm GREEN.**
- [ ] **Step 5: Write the failing API test** — extend `pending.service.spec.ts`: the builder for each pending item sets `titleKind` + `titleParams` (nominative), and **no** longer sets a Russian `title`; `proposedByName` is `null` when the proposer is unknown (was `'Неизвестно'`).
- [ ] **Step 6: Run it, confirm RED.**
- [ ] **Step 7: Implement API** — in `pending.service.ts`, replace the four string sites: emit `titleKind`/`titleParams`; drop `?? 'Неизвестно'` (return `null`). Keep writing `title` for exactly this PR (back-compat) **only if** another consumer still reads it (grep first; `PendingKindSection` uses `kind`, not `title`, per L11 comment) — otherwise remove `title` now.
- [ ] **Step 8: Run API tests GREEN;** `wip:` commit + `DATABASE_URL= git push` (chunk ≤2 files).
- [ ] **Step 9: Write the failing web test** — `PendingItemRow.test.tsx`: given `titleKind:'SHARE_BASE_OTHER'`, `titleParams:{seniorName:'Олексій'}`, the row renders the uk title from the catalog (not a server string); given unknown proposer, renders localized «Невідомо», not «Неизвестно».
- [ ] **Step 10: Run it, confirm RED.**
- [ ] **Step 11: Implement web** — `PendingItemRow.tsx` renders title via `renderMessage(i18n, PENDING_TITLE_MESSAGES[item.titleKind], item.titleParams)`; drop the `{item.title}` read (keep the `t\`Запит на дію\``unknown-kind fallback). Wire`companyName={…}` (L180) off the param, not the composed title.
- [ ] **Step 12: Run web unit GREEN.** Update any `apps/e2e` pending selectors that keyed on the Russian title (they should key on `data-testid`/`kind`, per `PendingKindSection` L11 — verify).
- [ ] **Step 13: Drop the legacy `title` field** from `pending.ts` DTO (server + schema) once nothing reads it; update the client-lenient schema branch accordingly.
- [ ] **Step 14: Verify** — `pnpm typecheck && pnpm lint`; letter-guard clean on touched web files; `assertInCatalog` for new ids. Push; let CI run full E2E (do not run locally).
- [ ] **Step 15: Final commit** — `feat(i18n): pending-row titles emit kind+params, client renders by viewer locale` with `ac_verified: …`. Open PR, request **security-reviewer** (RBAC: `projectName`/`seniorName` params go only to the share's party — the existing pending visibility scoping already gates this; state it in the PR body).

**AC (PR1):** server emits no Russian pending title; client renders every pending kind in uk **and** en; unknown proposer → localized fallback; unknown `kind` still → localized «Запит на дію»; E2E pending sweep green on CI; mutation gate clean on the new registry; 0 Russian visible strings from `pending.service`.

---

## Task PR2 — Virtual-contract document name → structured

**Files:**

- Modify: `packages/shared/src/schemas/documents.ts` (document DTO) — add `nameKind?: ContractNameKind | null`, `contractNumber?: string | null`
- Create: `packages/shared/src/schemas/document-name-registry.ts` — `CONTRACT_NAME_MESSAGES: Record<ContractNameKind, MessageDescriptor>`
- Modify: `apps/api/src/documents/documents.service.ts` (`mapContractVirtualEntry`, L605–657), `apps/api/src/contracts/employee-contracts.service.ts` (L219 notification `data.documentTitle`)
- Modify: `apps/web/app/components/documents/document-card.tsx`, `document-row.tsx`, `document-detail-dialog.tsx`
- Modify: `packages/shared/src/i18n/locales/{uk,en}/messages.po`
- Test: `documents.service.spec.ts` (+ integration), `document-name-registry.spec.ts`, documents web `__tests__`, `apps/e2e` document specs

**Interfaces:**

- Produces: `ContractNameKind = 'CONTRACT_SIGNED' | 'CONTRACT' | 'CONTRACT_TO_SIGN' | 'CONTRACT_DRAFT'`; virtual-entry DTO fields `nameKind`, `contractNumber`; `CONTRACT_NAME_MESSAGES`.
- Consumes: `renderMessage`; existing document DTO shape (real uploads keep `name` = sanitized filename, `originalName`).

**Key nuance:** `name` is multiplexed — real uploads use it as the filename (`document-card.tsx` L128 `doc.originalName ?? doc.name`), virtual contracts use it as the composed label. Do **not** touch the real-upload path. Only the virtual-contract branch gains structured fields; the client renders `nameKind`+`contractNumber` **only** when `nameKind != null`, else keeps `originalName ?? name`.

- [ ] **Step 1: Failing shared test** — `document-name-registry.spec.ts`: exhaustive `CONTRACT_NAME_MESSAGES`, non-empty messages, `{contractNumber}` substitution.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Create registry** — descriptors: `CONTRACT_SIGNED: msg\`Трудовий договір {contractNumber}\``, `CONTRACT: msg\`Трудовий договір\``, `CONTRACT_TO_SIGN: msg\`Трудовий договір (до підписання)\``, `CONTRACT_DRAFT: msg\`Трудовий договір (чернетка)\``. Hand-write uk+en msgstr (en: "Employment contract …").
- [ ] **Step 4: GREEN.**
- [ ] **Step 5: Failing API test** — `documents.service.spec.ts`: `mapContractVirtualEntry` returns `nameKind` + `contractNumber` and **no** Russian `name` for virtual entries; a real uploaded doc still returns `name` = filename and `nameKind` null. `employee-contracts.service` emits a structured notification data param instead of `documentTitle: 'Ваш контракт'` (reuse the pending `CONTRACT` concept or the notification registry's own title).
- [ ] **Step 6: RED.**
- [ ] **Step 7: Implement API** — set `nameKind`/`contractNumber` in `mapContractVirtualEntry`; for `name`, either leave a stable non-displayed value or set it to the filename-less marker the client ignores when `nameKind` present. Fix `employee-contracts.service` L219 to pass a code/param, not Russian.
- [ ] **Step 8: GREEN; wip push.**
- [ ] **Step 9: Failing web test** — documents `__tests__`: a virtual contract entry renders the uk/en catalog name by `nameKind`; a real upload still shows its filename.
- [ ] **Step 10: RED.**
- [ ] **Step 11: Implement web** — `document-card/row/detail` compute display name: `nameKind ? renderMessage(i18n, CONTRACT_NAME_MESSAGES[nameKind], { contractNumber }) : (originalName ?? name)`.
- [ ] **Step 12: GREEN;** update E2E document selectors keyed on the Russian contract name.
- [ ] **Step 13: Verify** typecheck/lint/letter-guard/assertInCatalog; push; CI E2E.
- [ ] **Step 14: Final commit** `feat(i18n): virtual-contract document name emits kind+number` + `ac_verified`. Open PR; **security-reviewer** (contract numbers already visible to the same viewers; no new exposure — state it).

**AC (PR2):** virtual contracts render localized in uk+en; real uploads unchanged; `employee-contracts` notification data carries no Russian; E2E document sweep green; 0 Russian visible strings from `mapContractVirtualEntry`.

---

## Task PR3 — Company-account counterparty label → `'COMPANY'` code + data migration

**Files:**

- Modify: `apps/api/src/finance/company-account.service.ts` (L375 `receiverLabel`, L734 `senderLabel`), `apps/api/src/finance/transactions.service.ts` (`isInternalCompanySide` L838 sentinel; L5352/L8370 assignments)
- Create: Drizzle data-migration (`apps/api/src/database/migrations/…`) updating existing rows; wire into `.github/workflows/deploy.yml` (fail-loud idempotent SQL)
- Modify (web, verify/extend): `apps/web/app/routes/_authenticated/finance/components/TransactionRow.tsx` (already maps `'COMPANY'`→`companyLabel`), `ActiveTransactionsTable.tsx` (passes `senderLabel`/`receiverLabel` raw — ensure it routes through the same `'COMPANY'` mapping), finance dialogs that print a counterparty label
- Modify: `packages/shared/src/i18n/locales/{uk,en}/messages.po` (if `companyLabel` descriptor is new; it likely already exists — reuse)
- Test: `transactions.service` masking specs (`transaction-settled-exposure`/counterparty masking), `company-account.*integration.spec.ts`, finance web `__tests__`, `apps/e2e` finance specs

**Interfaces:**

- Produces: `senderLabel`/`receiverLabel` value `'COMPANY'` (code) wherever the company account is the party, replacing `'Счёт компании'`.
- Consumes: existing web render `if (label === 'COMPANY') return companyLabel` (`TransactionRow.tsx` L144) and the existing masking in `mapTx`.

**Why this is mostly convergence:** the web already localizes `'COMPANY'`; the masking already treats `'COMPANY'` as an internal side (`isInternalCompanySide` L837 checks `sideLabel === 'COMPANY'` **alongside** the Russian literal). So the change is: (a) server **writes** `'COMPANY'`, (b) migrate stored `'Счёт компании'` → `'COMPANY'`, (c) remove the now-dead `'Счёт компании'` arm of the sentinel, (d) confirm every web counterparty render routes through the `'COMPANY'` mapping (not raw).

- [ ] **Step 1: Confirm DB target first** — owner runs over SSH (read-only): `SELECT current_database(); SELECT count(*) FROM transactions WHERE sender_label = 'Счёт компании' OR receiver_label = 'Счёт компании';` Record the count in the PR body (not a public log). This sizes the migration and proves the pattern.
- [ ] **Step 2: Failing masking test** — extend the counterparty-masking spec: a company-account row with `senderLabel:'COMPANY'` masks to `'CheekyCheeseIT'` for SENIOR/DROP/JUNIOR/HR and shows the company label for ADMIN/ACCOUNTANT — i.e. identical behaviour to today's `'Счёт компании'` row. Pin it **before** changing the sentinel (blast-radius: `isInternalCompanySide` has 2 call-sites in `mapTx`).
- [ ] **Step 3: RED** (if the spec currently only covers the Russian literal).
- [ ] **Step 4: Switch server writes** — `company-account.service.ts` L375/L734 and `transactions.service.ts` L5352/L8370 write `'COMPANY'`.
- [ ] **Step 5: Keep the sentinel accepting BOTH during rollout** — leave `sideLabel === 'Счёт компании' || sideLabel === 'COMPANY'` until the data migration has run in prod, THEN drop the Russian arm (final step). This keeps pre-migration rows masked correctly.
- [ ] **Step 6: GREEN; wip push.**
- [ ] **Step 7: Write the data migration** — idempotent `UPDATE transactions SET sender_label='COMPANY' WHERE sender_label='Счёт компании'` (+ receiver_label); wire into `deploy.yml` with fail-loud guard. DDL/data-migration review required.
- [ ] **Step 8: Web verify/extend** — ensure `ActiveTransactionsTable.tsx` and every finance dialog counterparty render go through the `'COMPANY'`→`companyLabel` mapping (extract the `TransactionRow.tsx` mapping into a shared helper if duplicated — reuse-first). Failing web test first, then implement.
- [ ] **Step 9: Verify** typecheck/lint/letter-guard; push; CI E2E finance sweep.
- [ ] **Step 10: Final commit** `feat(i18n,finance): company-account counterparty label as COMPANY code + data migration` + `ac_verified`. Open PR; **security-reviewer MANDATORY** (finance + RBAC sentinel). In the PR body: the masking-equivalence proof, the prod row count, the two-phase sentinel plan.
- [ ] **Step 11 (post-prod-migration follow-up):** after the migration has run in prod (owner confirms), remove the `'Счёт компании'` arm of `isInternalCompanySide` — tiny cleanup PR or a checked box tracked on this one.

**AC (PR3):** no row stores `'Счёт компании'`; server writes `'COMPANY'`; non-privileged viewers still see `'CheekyCheeseIT'`, privileged see the localized company label in uk+en; masking specs green; migration idempotent & reviewed; E2E finance sweep green.

---

## Task PR4 — Null-name fallbacks + data-at-rest decisions

**Files (S4 — always):**

- Modify: `apps/api/src/legends/legends.service.ts` L176 (`?? 'Неизвестный'` → `null`), `apps/api/src/approvals/approvals.service.ts` L264 (`?? 'Сотрудник'` → `null`; verify consumer — if it feeds notification data, pass null/param), `apps/api/src/finance/transactions.service.ts` L4968 (`actorName ?? '— (пользователь удалён)'` → `null`)
- Modify: the web render sites for legend author, approval approver, and transaction actor/audit — render localized fallback (`«Невідомо»`, `«Користувача видалено»`) via catalog
- Modify: `packages/shared/src/i18n/locales/{uk,en}/messages.po`
- Test: respective api specs + web `__tests__` + `apps/e2e` where these surface

**Files (S5 — only if Decision Q2 accepts):**

- `teams/teams.service.ts` L1196, `users/users.service.ts` L1007/L3561 (auto team-name) + migration of `teams.name`
- transaction system-notes (`transactions.service.ts` L4442/L6215/L6308/L6358, `pending-settlement.service.ts` L1246–1247) — introduce a structured `noteKind` for server-generated notes OR leave as audit text

- [ ] **Step 1 (S4): Failing api tests** — each service returns `null` for an unknown name instead of the Russian placeholder.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** the three `?? null` changes; grep each field's consumers first (blast-radius).
- [ ] **Step 4: GREEN; wip push.**
- [ ] **Step 5: Failing web tests** — null name renders the localized fallback.
- [ ] **Step 6: RED → implement → GREEN** at each render site via catalog descriptors.
- [ ] **Step 7: Verify** typecheck/lint/letter-guard/assertInCatalog; push; CI E2E.
- [ ] **Step 8 (S5, conditional):** if accepted, apply the data-at-rest shape (code + `deploy.yml` migration, owner SSH count) per the S3 pattern; else record the deferral in the PR body and this plan's Decision Q2.
- [ ] **Step 9: Final commit** `feat(i18n): localized null-name fallbacks (+ data-at-rest residuals)` + `ac_verified`. Open PR; **security-reviewer** (actor/audit fields touch RBAC-masked identity — confirm no un-masking).

**AC (PR4):** no Russian null-name placeholder reaches the client; localized fallbacks render in uk+en; identity-masking unchanged; S5 either migrated or explicitly deferred with reason.

---

## Decisions for the owner (A2 — recommended answers; proceeding on recommendation unless told otherwise)

**Q1 — Raw-prose NestException error messages (the largest residual).** Dozens of `throw new NotFoundException('Вакансия не найдена')`-style Russian strings (vacancies, credentials, applications, …) reach the user **verbatim** via `extractBackendMessage` → toast. They are the un-migrated tail of the stage-4 API-error-code effort (same `apiError(code,…)` + registry mechanism), which you scoped as "api error codes … do not touch".
→ **Recommended:** keep them **out** of this plan; handle them as a dedicated **continuation of the stage-4 error-code migration** (one plan, module-by-module, mechanical). Reversible; cost of deferral = those toasts stay Russian for uk/en users a while longer.

**Q2 — Data-at-rest residuals (S5): auto team-names «Команда {name}» and server-written transaction `notes`.**
→ **Recommended:** (a) **team-names** — leave as data (the word «Команда» reads correctly in uk; names are user-editable; low value, one migration for marginal gain), revisit only if an en-only user complains; (b) **transaction notes** — the column is a **mixed free-text channel** (operators type into it via `AdminEditTransactionDialog`), so blanket migration is unsafe; for the handful of **server-generated** notes, introduce a structured `noteKind` only if you want them localized, otherwise accept them as ADMIN/ACCOUNTANT audit text. Lean **defer both**; fold into PR4 only if you want them now. Reversible.

**Q3 — PR count.** Plan proposes **4 PRs** (PR1 pending, PR2 documents, PR3 finance/data-migration, PR4 fallbacks[+optional S5]). If Q2 defers S5, PR4 is small; if Q1 is later accepted into scope, it becomes its own multi-PR plan, not an addition here.

---

## Self-Review

- **Spec coverage:** every IN-SCOPE source S1–S5 maps to a PR (S1→PR1, S2→PR2, S3→PR3, S4→PR4, S5→PR4-conditional). Notification residual verified closed except the S2 param. Error-prose + PDF + email + job-sourcing explicitly excluded with reasons.
- **Placeholder scan:** no "TBD"/"add validation"; each step names files and the concrete shape. Where a consumer must be confirmed (approvals L264), the step says "grep consumers first" — an action, not a placeholder.
- **Type consistency:** `PendingTitleKind`/`ContractNameKind` enums defined once and referenced consistently; `renderMessage` reused (not re-defined); `'COMPANY'` code matches the web's existing `TransactionRow.tsx` L144 branch.
- **Reuse-first:** registry pattern mirrors `notification-registry.ts`; `renderMessage` reused; S3 rides the pre-existing `'COMPANY'` render path. Blast-radius for the one shared symbol changed (`isInternalCompanySide`, 2 call-sites) is pinned before change (PR3 Step 2).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-03-crm-i18n-server-user-facing-text.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per PR, security-reviewer between PRs, fast iteration.
2. **Inline Execution** — execute PRs in this session via executing-plans with checkpoints.

Which approach?
