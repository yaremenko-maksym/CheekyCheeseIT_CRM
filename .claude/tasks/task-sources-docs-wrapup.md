# Task sources-docs — wrap-up docs PR for the job-sources connect-all phase (2026-11-19 .. 2026-11-21)

Docs-only PR (no code). Branch `docs/sources-connect-wrapup` from `origin/main`. Read
`.claude/rules/common/doc-durability.md` first: long-lived records state behaviour and symbols, never line numbers.

Inputs (read-only, absolute paths):
- Ledger: `/Users/maksym/.claude/handoffs/sources-connect-2026-11-19/LEDGER.md` (+ `README.md` in the same folder).
- Pending list: `/Users/maksym/.claude/handoffs/sources-connect-2026-11-19/docs-pr-pending.md`.
- Task files to commit: `/Users/maksym/.t3/worktrees/CheekyCheeseIT_CRM/t3-e2d4e8c0-f9e0b534f5d3bb43/.claude/tasks/task-sources-*.md`.
- Patch for `.claude/tasks/task-vacancy-8-rollout.md` (owner answers block): `/tmp/vacancy8-rollout.patch`.
- PR bodies (`gh pr view <n> --json body`) of the merged sources PRs #1425-#1445: their "Follow-ups" sections.

## Do

1. **Research doc** `docs/superpowers/research/2026-11-20-html-sources.md`: per HTML site (JustJoin.it, No Fluff Jobs,
   Landing.jobs, Next Level Jobs, Dice, The Hub, Welcome to the Jungle) and per blocked source (DOU, The Muse, EU
   Remote Jobs): access path used (sitemap / listing payload / JSON-LD), terms status (PROHIBITED / UNCLEAR /
   silent), owner decision, technical block if any, final state on prod. Facts from the LEDGER only.
2. **Backlog** (`.claude/tasks/BACKLOG-followups.md` or wherever the repo's backlog lives on `origin/main`; rebase
   first, numbers collide with parallel sessions; take the next free numbers): every item in `docs-pr-pending.md`,
   plus every PR-body follow-up of #1425-#1445 NOT already in the backlog and NOT covered by the tasks in flight:
   `task-sources-15-throughput.md`, `task-sources-16-hardening.md` (robots/redirects in the sitemap core, NLJ
   apply-button regex, 410, double request report), salary field and cross-source dedup (owner ordered both
   2026-11-21; tasks sources-17 / sources-18 follow). Each item: behaviour, how to check, source PR.
3. **project-state** (`.claude/agents/project-state.md`): job-sources state on prod 2026-11-21 (all sources
   connected except EU Remote Jobs by owner decision; DOU / The Muse / WTTJ technical blocks under NO_EVASION;
   Djinni works), the interview-stage note from `docs-pr-pending.md`, and owner decisions 2026-11-21: HTML sources 4
   runs a day, SmartRecruiters 10 requests a minute, structured salary field (structured sources only, no
   free-text parsing), cross-source dedup by normalized title + company within 14 days with the ATS copy winning
   and Ashby keyed by job id; new sources keep seeding `enabled=false` (an ADMIN enables them with the admin
   switch).
4. **Runbook** `docs/runbooks/vacancy-sourcing.md`: availability reconciliation cron `'37 */6 * * *'` ->
   `'37 * * * *'` (hourly since #1426). Do NOT change the HTML cron line (sources-15 changes it).
5. **Task files**: copy every `task-sources-*.md` from the input path into your `.claude/tasks/` (they are
   gitignored: `git add -f` each by name). Apply `/tmp/vacancy8-rollout.patch`. Do not copy any `*.diff` file.

## Rules

Zone: `docs/**`, `.claude/tasks/**`, `.claude/agents/project-state.md`. Every Edit/Write path starts with your own
`git rev-parse --show-toplevel`. No secrets, emails or personal data (the ledger has none to copy; never copy a
command line that contains an address). Commit `docs(job-sourcing): connect-all wrap-up (research, backlog, state,
task files)` with `ac_verified: n/a (docs-only)`. Push with `DATABASE_URL= git push`. Draft PR with `Plan:` line,
`Skip-QA:` / `Skip-Design-Review:` (docs-only). No `--no-verify`, explicit `git add`. No second-opinion.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (verify `git ls-remote`), PR URL, backlog numbers added with
one-line titles, `Token-economy:` line.
