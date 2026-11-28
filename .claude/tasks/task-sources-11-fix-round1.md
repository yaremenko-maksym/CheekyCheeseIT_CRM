# Task sources-11 fix round 1 — PR #1442 (branch `feat/admin-sources-ui-1`, head af3c5cf3c)

Original task: `task-sources-11-admin-sources-ui.md` (same directory). Reviews on the PR: code+security+spec
(BLOCK, M=2 L=5), copy (BLOCK, M=2 L=1), second-opinion (4 reviewers, the switch bug confirmed by all).

## Findings to resolve (all)

| ID | Sev | Where | Decision |
| --- | --- | --- | --- |
| CR-M-1 | M | `SourceAdminControls.tsx` `SourceEnableSwitch` | Switch is disabled for every BLOCKED source, so an enabled BLOCKED source cannot be switched OFF (server refuses only enabling: `enableRefusal`). Disable only when `blocked && !source.enabled`; show the "cannot enable" hint only when the source is off. Replace the test that codifies the bug with: enabled+BLOCKED source -> toggle sends `{enabled:false}`; disabled+BLOCKED -> switch inert + hint |
| CR-M-2 | M | same, Switch className / native `disabled` | Copy the `SourceSwitchCard.tsx` pattern (44 px `::after` hit area without stretching the track, `aria-disabled` while pending so focus stays, higher-contrast off track) |
| CR-L-1 | L | `SourceEnableSwitch` `aria-label` | Accessible name names the source (its display name/type), state comes from `aria-checked` |
| CR-L-2 | L | `SourceResetFailures` trigger + `DialogTitle` | Trigger accessible name and dialog title name the source |
| CR-L-3 | L | `SourceAdminControls.test.tsx` | Assert `aria-checked` unchanged while the request is pending (never optimistic); mock `{code:'JOB_SOURCE_NOT_READY'}` and assert the exact `en` catalog text |
| CR-L-4 | L | `sources.index.test.tsx` runtime stamps | Distinct ages for `lastAttemptAt` / `lastSuccessAt`; assert the time beside each label |
| CR-L-5 + Copy L1 | L | uk/en "Остання вдала:" / "Last success:" (+ the `{lastSuccess}` variants) | `Остання успішна спроба:` / `Last successful attempt:` (pairs with `Остання спроба:` / `Last attempt:`) |
| Copy M1 | M | uk reset dialog description | `Лічильник помилок і охолодження буде скинуто. Збір піде за розкладом. Вкажіть причину: вона записується в журнал.` (en: keep meaning, two sentences) |
| Copy M2 | M | switch state text `Збір увімкнено/вимкнено` / `Collection on/off` | Reuse the sibling `SourceSwitchCard` keys: on `Працює` / `Running`, off `Вимкнено` / `Disabled` (same msgids, no new strings) |

## Do

TDD (failing tests first), then the fixes. `pnpm --filter @crm/shared i18n:extract` (or the repo's extract
command) after string changes; both catalogs filled. Run the changed web suites, typecheck, eslint, prettier, the
E2E `job-source-admin-responsive.spec.ts` locally, mutation gate `node scripts/devops/mutation-gate.mjs --changed`.
Screenshots at 375 px of the list (enabled+BLOCKED row) and the reset dialog to /tmp.

Commit `fix(web): admin sources switch can disable a blocked source; a11y and copy` with
`ac_verified: CR-M-1,CR-M-2,CR-L-1,CR-L-2,CR-L-3,CR-L-4,CR-L-5,Copy-M1,Copy-M2,Copy-L1`; push
`DATABASE_URL= git push`. Report `Worktree:`, `Pushed: <branch> @ <sha>`, test counts (non-zero), mutation result,
`Findings resolved (10)`.

## Rules

Zone `apps/web/**` + `packages/shared/src/i18n/**` only (no API change). No `--no-verify`, explicit `git add`. No
second-opinion. Notes server: `notes.search` before reading code, `notes.add` facts with file:line.
