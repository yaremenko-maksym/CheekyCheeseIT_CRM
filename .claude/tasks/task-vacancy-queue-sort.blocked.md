# BLOCKER: task-vacancy-queue-sort — push refused by pre-push tooling on Windows

## Agent: coder

## Task: .claude/tasks/task-vacancy-queue-sort.md

## Problem

The implementation is complete and committed on `feature/vacancy-queue-sort`, but `git push` cannot pass the
pre-push gates from this Windows machine. Both defects are outside the coder zone; no hook was bypassed.

1. **`pre:bash:mutation-gate` turns a budget timeout into a false BLOCK.** The hook runs
   `scripts/devops/mutation-gate.mjs --changed` with a 120 s budget. This diff needs about 10 min (the web
   dry run alone is 5 min 10 s). On timeout the gate SIGKILLs Stryker and calls
   `rmSync(<pkg>/.stryker-tmp, { recursive: true, force: true })` unguarded inside the child `close`
   handler. On Windows the killed workers still hold the sandbox, so `rmSync` throws `EBUSY`. The uncaught
   throw exits the process with 1, and the hook reads exit 1 as "a real finding" (BLOCK), not as exit 2
   (SKIP). Evidence that no real survivor exists, from full-budget runs on the current head:
   `@crm/shared` 4/4 killed, `@crm/api` 21/21 killed, `@crm/web` 18/18 killed (100% on each leg).
   Suggested fix (DevOps): wrap that `rmSync` in try/catch and log, so a timeout still ends as exit 2.
2. **Husky pre-push API suite is red on `origin/main` on Windows**: 69 failures across 11 files on
   origin/main itself under Node 22.23.4 (app.module.container, deploy-ddl-preconditions — path
   separator, dirty-work.retention-guard, manifest, fixture-provenance, ledger-catalog.snapshot.drift,
   resume-ats-checker, resume-offload-structure, resume-text-extraction, resume-typst,
   timing-spec-registry). None of them is touched by this branch.

## Affected code

`scripts/devops/mutation-gate.mjs` — the timeout branch of the Stryker child `close` handler.

## Question to Master

Push the branch from an environment where the gates run (macOS / CI-equivalent), or have DevOps land the
`rmSync` guard first. Recommendation: push from a working environment now; the DevOps fix is
independent.

## What was done before the blocker

All AC implemented and verified locally; see the commits on `feature/vacancy-queue-sort` after
`c90d6df68` (the last pushed commit).
