# Task sources-11 fix round 2 — PR #1442 (branch `feat/admin-sources-ui-1`, head e54fcd0be)

Manual QA PASS with 4 lows on this PR's code (QA comment on the PR). Resolve them. Earlier rounds:
`task-sources-11-admin-sources-ui.md`, `task-sources-11-fix-round1.md` (same directory).

| ID | Sev | Where | Decision |
| --- | --- | --- | --- |
| QA-LOW-1 | L | `SourceEnableSwitch` accessible name | Rows of the same source type share one name (three switches "Remotive"). Make the name unique per row with data the row already shows (e.g. type label + the source's own name/host/id as rendered in the row). No new API field |
| QA-LOW-2 | L | off+BLOCKED row hint | At 768 px the hint squeezes the text column (~107 px) and uk badge/timestamps wrap; at 1440 the row's switch is out of line. Lay the hint out so it does not narrow the text column (e.g. under the row content, full width) and the switch column stays aligned across rows |
| QA-LOW-3 | L | `useSetJobSourceEnabled` | After a refused enable (409 `JOB_SOURCE_NOT_READY`) invalidate/refetch the sources list so the row reflects the server state without reload |
| QA-LOW-4 | L | "Reset failures" trigger | 36 px tall at >=640 px; keep a 44 px hit area at every width (same `::after` technique as the switch, or min-h) without changing the visual size if the design keeps it |

Out of scope: the shared dialog close button (QA-LOW-5, existing component) -> backlog by Master.

## Do

TDD (failing tests first). Run the changed web suites, typecheck, eslint, prettier, E2E
`job-source-admin-responsive.spec.ts`, mutation gate `node scripts/devops/mutation-gate.mjs --changed`. Screenshots
at 768 and 1440 px of a list with an off+BLOCKED row to /tmp/r2-*.png. If strings change: i18n extract, both catalogs.

Work on local branch `fix/admin-sources-ui-r2` from `origin/feat/admin-sources-ui-1`; push fast-forward
`DATABASE_URL= git push origin HEAD:feat/admin-sources-ui-1` (pre-push runs the suites; commit tests + fix together).
Commit `fix(web): admin sources unique switch names, hint layout, refresh after refusal` with
`ac_verified: QA-LOW-1,QA-LOW-2,QA-LOW-3,QA-LOW-4`. Report `Worktree:`, `Pushed: <branch> @ <sha>`, test counts
(non-zero), mutation result, `Findings resolved (4)`.

## Rules

Zone `apps/web/**` + `packages/shared/src/i18n/**`. Every Edit/Write path starts with your own
`git rev-parse --show-toplevel`. No `--no-verify`, explicit `git add`, never create `.claude/.allow-direct-edits`.
No second-opinion. Notes server: `notes.search` / `notes.add`.
