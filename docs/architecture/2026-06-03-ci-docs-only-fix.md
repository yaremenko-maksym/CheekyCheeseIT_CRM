# CI Docs-Only PR Fix: Always-Run + Early-Exit

**Date:** 2026-06-03
**Author:** Architect (Claude)
**Status:** Active
**Branch:** `devops/ci-always-run-for-docs`
**Related:** PR #87 (Phase 3a YAML frontmatter — first pure docs-only PR that exposed the gap)

---

## Problem

Branch protection on `main` requires two status check contexts:

- `Typecheck · Lint · Unit Tests`
- `E2E Tests`

The CI workflow (`.github/workflows/ci.yml`) was configured with `paths-ignore`:

```yaml
on:
  pull_request:
    paths-ignore:
      - 'docs/**'
      - '**.md'
      - '.github/CODEOWNERS'
  push:
    branches: [main]
    paths-ignore: [...]
```

GitHub Actions semantics for `paths-ignore`: if a PR's diff touches **only** ignored paths, the workflow is **not scheduled at all**. No jobs run. No status contexts get reported. The required checks (`Typecheck · Lint · Unit Tests`, `E2E Tests`) never appear on the PR.

Branch protection then sees missing required contexts and reports `mergeStateStatus: BLOCKED`. The PR is permanently un-mergeable through normal flow.

### Why this only surfaced now

Recent PRs (#84, #85, #86) all happened to include at least one non-docs file:

- `.prettierignore`
- `.claude/hooks-ecc/*`
- `.github/labels.yml`

These accidentally triggered the workflow and produced the required statuses. **PR #87** is the first truly docs-only change (`docs/agents/*.md` YAML frontmatter migration) — and it exposed the latent infrastructure gap.

### Why workarounds were rejected

| Workaround                                        | Why rejected                                                    |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Admin merge override                              | Forbidden by user policy.                                       |
| Branch protection bypass                          | Forbidden — every merge to `main` must satisfy required checks. |
| Add a fake non-docs file change                   | Anti-pattern; pollutes diff; doesn't solve underlying problem.  |
| Remove the required checks from branch protection | Weakens guardrails; future code PRs would lose protection.      |

---

## Solution

**Pattern: always-run skeleton + `dorny/paths-filter` early-exit.**

Remove `paths-ignore` so the workflow always triggers. Inside each job, the first non-checkout step uses `dorny/paths-filter@v3` to detect whether any non-docs file changed. Every subsequent work-step is gated by `if: steps.filter.outputs.code == 'true'`. A no-op `echo` step gated by `if: steps.filter.outputs.code != 'true'` provides the docs-only success path.

Result:

- Docs-only PR → workflow runs → filter detects no code changes → all work-steps skip → echo step succeeds → job reports `success` → required status check appears with green.
- Code PR → workflow runs → filter detects code changes → all work-steps execute as before → echo step skips → existing behavior preserved.

This is idiomatic GitHub Actions practice for required-context flows (documented in GHA community discussions, used by Buildkite, CircleCI under similar semantics).

### Job names — byte-identical preservation

Branch protection matches required contexts by **exact string**. Any change to a job's `name:` field creates a _new_ status context and the old required one stays missing → still BLOCKED.

| Branch protection context       | Job in workflow    | Status                                                                                                                                  |
| ------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Typecheck · Lint · Unit Tests` | `quality.name`     | Unchanged. UTF-8 bytes `74 79 70 65 ... 73 74 73`, includes middle dot `U+00B7` = `0xc2 0xb7`. Verified byte-for-byte vs `origin/main`. |
| `E2E Tests`                     | `e2e_summary.name` | Unchanged. Aggregator of 5 matrix shards.                                                                                               |

Matrix shard names (`E2E (auth-nav)`, `E2E (team-users)`, etc.) are _not_ required — only the aggregator `E2E Tests` is. Each shard still uses the filter pattern so docs-only PRs don't waste CI minutes spinning up postgres/redis/minio/playwright.

---

## Verification

### Smoke test 1 — this PR itself

This PR modifies `.github/workflows/ci.yml` (non-docs). Therefore:

- Workflow triggers.
- `paths-filter` detects code change (workflow file ≠ docs).
- All work-steps run as before.
- Both required statuses appear with full execution.

If this PR's CI is green, the always-run skeleton hasn't broken anything for the normal code-change path.

### Smoke test 2 — post-merge, docs-only PR

After merging this fix, the next docs-only PR (e.g. rebased PR #87) should:

1. Trigger CI workflow.
2. `quality` job: filter outputs `code=false` → all work-steps skip → "Docs-only short-circuit" echo runs → job exits 0 → `Typecheck · Lint · Unit Tests` reports **success**.
3. Each `e2e` shard: filter outputs `code=false` → all work-steps skip → "Docs-only short-circuit" echo runs → shard exits 0.
4. `e2e_summary`: `needs.e2e.result == 'success'` → aggregator passes → `E2E Tests` reports **success**.
5. PR `mergeStateStatus: CLEAN` (assuming other gates like `merge-approved` label are satisfied).

### Manual verification commands

```bash
# After this PR is merged, check a docs-only PR:
gh pr checks <PR_NUMBER>
# Expected: both "Typecheck · Lint · Unit Tests" and "E2E Tests" = success

# Inspect job run to confirm short-circuit path executed:
gh run view <RUN_ID> --log | grep "Docs-only short-circuit"
# Expected: visible in both quality job and all 5 e2e shards
```

---

## Edge cases considered

| Edge case                                        | Handling                                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed PR (docs + one code file)                  | `paths-filter` detects code change → full run. Correct behavior.                                                                                    |
| Workflow file itself changed                     | `.github/workflows/ci.yml` does not match `!docs/**` exclusion → counted as code → full run. Correct.                                               |
| `.github/CODEOWNERS` only                        | Excluded explicitly → docs-only path. Same as original `paths-ignore`.                                                                              |
| `.github/labels.yml` only                        | NOT excluded → counted as code → full run. Same as original behavior (labels.yml triggered CI before too).                                          |
| Push to main (not PR)                            | Filter still works for push events with `fetch-depth: 2` (compares HEAD vs HEAD~1).                                                                 |
| Force-push to PR branch                          | `paths-filter` re-runs on each `synchronize` event with up-to-date diff.                                                                            |
| `auto_merge` job for docs-only PR                | Depends on `quality` and `e2e_summary` both = `success`. Docs-only PRs satisfy both → auto-merge works normally if `merge-approved` label set.      |
| `notify_e2e` job (main push, opens/closes issue) | Unchanged; only runs on push to main. If a docs-only commit lands on main, all shards short-circuit `success` → no false "E2E broken" issue opened. |

---

## Costs

- **Per docs-only PR:** ~5 short jobs spin up (1 quality + 5 e2e shards + 1 aggregator), each does only `checkout` + `paths-filter` + `echo` ≈ 30 seconds × 7 jobs ≈ ~3.5 GHA minutes. Negligible vs the alternative (BLOCKED PR requiring manual unblock).
- **Per code PR:** zero additional cost — `paths-filter` adds ~2 seconds, all other steps run exactly as before.
- **MinIO/postgres/redis spin-up on docs-only PRs:** services are declared at job level, so they start regardless of `if:` on steps. ~30 seconds of wasted setup per shard × 5 shards. Acceptable tradeoff; eliminating this would require splitting `e2e` into two jobs (one shell-only filter check, one full job gated on its output), which adds complexity disproportionate to the savings.

---

## Rollback

Single-commit revert restores prior behavior:

```bash
git revert <merge-commit-sha>
git push origin main
```

This re-introduces `paths-ignore` and removes the filter steps. Docs-only PRs will again be BLOCKED — but normal code PRs work unchanged. Use only if the always-run pattern itself misbehaves (no observed risks; the pattern is well-established).

---

## Future work (not in scope)

- Consider extracting the `paths-filter` step into a reusable composite action under `.github/actions/detect-non-docs/` if more workflows need the same pattern.
- If GHA adds first-class "always-report-status-but-skip-work" semantics, migrate to that instead of the filter trick.
- The `ai-review.yml` workflow may have the same latent issue for docs-only PRs (Reviewer + AutoTest + PM gate). Audit separately if it surfaces.
