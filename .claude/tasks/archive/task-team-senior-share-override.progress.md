# Progress: task-team-senior-share-override

current_milestone: 5/5 — "Verification complete, ready for PR"
last_commit: 28682bb (pending finalize)
last_push: 28682bb

## Verification summary

- typecheck — all 4 packages green
- lint — green (existing warnings only, not added by this task)
- API tests — 414/414 passed (includes new senior-share-resolver.spec.ts with 11 cases)
- Web build — green
- Web tests — 129/129 passed
- E2E — 548 passed; 16 pre-existing flaky failures (verified failing on origin/main too — unrelated)
- Migration 0025 — applied cleanly, columns verified via postgres MCP
- Playwright (AC10) — ADMIN edits team override → 16 persisted in DB → /crm/finance shows «16% Команда» badge
- Playwright (AC10) — SENIOR_INCOME created via API → backend stamps seniorSharePercent=16 + seniorSharePercentSource=TEAM
- Playwright (AC11) — all 3 cases verified: PROJECT (40% Override), TEAM (16% Команда), USER_DEFAULT (26% по умолчанию)
- Playwright (AC11) — legacy SENIOR_INCOME rows (no source) still render «Доля: 26%» without a source badge — no regression

## Milestones

- M1: Shared schemas (teamSchema, updateTeamSchema, transactionSchema source field)
- M2: Drizzle schema + migration 0025
- M3: Backend services (resolver + propagation in createSeniorIncome/createDropIncome/validateTransaction + projects.service team_override surfacing)
- M4: Frontend (TeamDialog field + MyProjectShares badge + TransactionRow tooltip + TransactionDetailDialog + PayoutDialog)
- M5: Tests (UT senior-share-resolver) + Playwright visual regressions

files_done: []
files_pending: []

## Resolver hierarchy decision

- Resolver finds team via team_members where userId=project.seniorId (SENIOR-team membership) AND team.type='SENIOR' AND member.leftAt IS NULL.
- For drop-projects: resolver inspects the drop's drop-team (team.type='DROP' where dropId=project.dropId).
- If senior is member of multiple active teams → team-override NOT applied (fall back to user default).
- All resolution happens at snapshot time (createSeniorIncome / createDropIncome) — no on-read computation.

## Source enum

- `'PROJECT' | 'TEAM' | 'USER_DEFAULT'` stored in `transactions.senior_share_percent_source` (nullable for legacy rows).

## UI text

- MyProjectShares: badge "проект X%" (existing was "Override"), "команда X%", "по умолчанию X%" (existing).
- TransactionRow: small text "Доля: X% · Источник: проект/команда/default" под суммой.
