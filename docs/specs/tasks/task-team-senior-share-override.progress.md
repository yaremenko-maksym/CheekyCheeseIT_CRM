# Progress: task-team-senior-share-override

current_milestone: 0/5 — "Map done, starting shared schemas"
last_commit: -
last_push: -

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
