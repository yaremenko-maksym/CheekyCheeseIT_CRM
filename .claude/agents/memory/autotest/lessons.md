# AutoTest Lessons

Accumulated lessons from past AutoTest tasks. Format: `YYYY-MM-DD [task-id] lesson`.
See [`../README.md`](../README.md) for rules and examples.

---

2026-05-20 [P0] [task-fix-pr22-ui-round5] #commit-hygiene #worktree Do not commit debug screenshots into `apps/e2e/` — put them in `/tmp/autotest-<runid>/`. Other people's commits later sweep them up via `git add .`.
2026-05-19 [P0] [task-fix-e2e-team-selectors] #atomicity #ci When changing UI texts — update selectors in spec.ts IN THE SAME commit as the UI. A mismatch → flaky E2E on main.
2026-05-18 [P1] [task-fix-flaky-tests] #test-stability userEvent.setup({delay: null}) stabilizes tests — otherwise race conditions with act() warnings in RTL.
2026-05-23 [P2] [dev-flow-rca] #dispatch PM may skip AutoTest dispatch if Coder already added comprehensive E2E (see pm.md "AutoTest dispatch decision"). This is normal — it means coverage exists for **this PR**.
2026-05-30 [P1] [task-drop-phase1-e2e] #radix-radio #async-submit In mock-based E2E (apps/e2e/tests) the dialog submit button with Zod safeParse often silently fails into toast.error due to a race between the Radix RadioGroupItem click and the form.state update. The POST-body test JOIN_DROP_TEAM was flaky on CI — instead of `waitForRequest(POST)` it is better to test the UI contract: "selecting the radio surfaces the drop-team picker". The full shape check belongs to UT (Coder Vitest). If you really need the POST body — fill ALL fields before the radio, then click the label (not `radio.click()`), and do not set `waitForRequest` before the submit click.
2026-05-30 [P2] [task-drop-phase1-e2e] #ci-flaky #retries Under `CI=1` retries=2 — four tests (team-redirect, team-empty, finance-flow, tech-autocomplete) on the default local matrix failed because of a parallel race with my TEAMS fixtures extensions. After `CI=1` retry they all passed. For a local dev run the flake is acceptable — on GHA the shard hides it with retries.
2026-05-30 [P2] [task-drop-phase1-e2e] #archive-confirm-dialog #testids The archive dialog has TWO different components: `components/users/ArchiveConfirmDialog` (testid=`archive-confirm-dialog`) for archiving a user, and `components/archive/ArchiveConfirmDialog` (testids=`archive-confirm-input`/`archive-confirm-submit`, WITHOUT a wrapper testid) for archiving a team/project. Do not confuse them.
2026-07-12 [P1] [task-drop-attach-autotest] #subagent-lifecycle A sub-agent CANNOT "wait for notification" of a background run — the end of the turn kills the background, the work is lost (the spec stayed uncommitted). Long runs — only synchronously (foreground Bash, chunk by spec files if needed).
2026-07-12 [P1] [task-drop-attach-autotest] #stale-expectation A parallel review fix-round changes the UI contract: before pushing, resync with the PR branch HEAD (fetch+rebase, re-read the diff of changes after your commit) — the assertion "SENIOR sees the drop row" became stale after one review round (H1 mask). For elements that per RBAC do not render at all, assert `not.toBeAttached()`, not `not.toBeVisible()`.
2026-07-14 [P1] [task-drop-share-e2e] #zero-flaky-proof `--repeat-each=2..4` on new/changed specs — a cheap zero-flaky proof for the report. The isolated scratch stack = a separate `crm_scratch_*` DB (native PG :5432) + its own ports + `E2E_REAL_API_BASE`; tear down the DB and kill the processes afterwards.
