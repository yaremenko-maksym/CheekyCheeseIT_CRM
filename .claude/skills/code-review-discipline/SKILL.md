---
name: code-review-discipline
description: 'When the code-reviewer or security-reviewer agent prepares a PR review for the CRM. Contains a DELTA of patterns on top of ECC code-reviewer.md / security-reviewer.md — the owner==reviewer conflict (REQUEST_CHANGES forbidden, use COMMENT + Verdict: BLOCK first-line), write-then-post resilience (MCP hang recovery), zone-of-write violations → automatic BLOCK. Use before every posted review, especially when the conclusions are blocking.'
when_to_use: "Use when the code-reviewer or security-reviewer formulates a Verdict and posts a PR review for the CRM. Examples: 'posting a review on a PR', 'need Verdict BLOCK', 'owner==reviewer, how to review my own PR', 'zone-of-write violation in the diff', 'write-then-post so the review is not lost on an MCP hang'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - mcp__github__create_pull_request_review
  - mcp__github__get_pull_request_files
---

# Code Review Discipline (delta vs ECC)

Project-specific additions to the ECC `code-reviewer.md` Pre-Report Gate. **Does NOT duplicate** ECC — lifts only the delta not covered upstream.

## When to invoke

- Before `mcp__github__create_pull_request_review` (any review event)
- When formulating a Verdict for a PR (BLOCK / APPROVE)
- When the PR diff contains files outside the Coder's zone-of-write
- When investigating an MCP hang during a posted review
- If a previous review "hung" > 2× the expected duration without appearing on the PR

## Patterns

### 1. Verdict: BLOCK first-line (owner==reviewer constraint)

**Rule:** To block a PR use `event: COMMENT` + the first line of the body `Verdict: BLOCK`. Do **NOT** use `event: REQUEST_CHANGES`.

**Source of the problem:** The GitHub API forbids, when the reviewer account == author, **both** blocking/approving events: `REQUEST_CHANGES` and `APPROVE`. In the CRM ALL AI agents work under a single owner — so both will always return 422 (`APPROVE` → `"Can not approve your own pull request"`, verified on PR #536 2026-08-17). There is exactly one working option: `event: COMMENT` + the verdict on the first line.

**Implementation:**

```ts
mcp__github__create_pull_request_review({
  pull_number: N,
  event: 'COMMENT',
  body: `Verdict: BLOCK\n\n<rationale + HIGH findings>`,
})
```

**Decision rule for Master:**

- Master parses `Verdict: BLOCK` in the first line → removes `awaiting-pm-review` → puts `do-not-merge` → creates a fix-task for the Coder.
- `Verdict: APPROVE` (or the absence of a BLOCK marker) → continues the Mode 2 aggregate verdict logic.

### 2. Write-then-post pattern (MCP hang recovery)

**Rule:** Save the review body to `/tmp/<role>-output/pr-<N>-<TS>.md` **BEFORE** `mcp__github__create_pull_request_review`. MCP can hang > 10 min (real incident 2026-05-23) → watchdog crash → the review is lost. The file survives the crash, is available for manual recovery.

**Implementation order:**

1. Formed the body string.
2. `Write` the file `/tmp/reviewer-output/pr-<N>-<TS>.md` with the body.
3. `mcp__github__create_pull_request_review` — Attempt #1.
4. If MCP hangs / fails → `gh api repos/.../pulls/<N>/reviews -X POST -F event=COMMENT -F body=@/tmp/reviewer-output/pr-<N>-<TS>.md` — Attempt #2 (Bash fallback).
5. If both failed → Master recovery: Master reads the file and posts it manually.

**For security-reviewer:** Similarly, the path `/tmp/security-reviewer-output/pr-<N>-<TS>.md`.

### 3. Zone-of-write violation → automatic BLOCK

**Rule:** If the PR diff contains changes outside the Coder's zone-of-write — Verdict: BLOCK with the specific file named.

**Coder forbidden zones (from the 2026-05-23 D1-D4 RCA):**

- `scripts/pm/**` (Master-only)
- `scripts/devops/**` (DevOps-only)
- `.claude/agents/**` (Architect-only)
- `docs/business/**` (BA-only)
- `.github/workflows/**` (DevOps-only)
- `.claude/hooks/**` (DevOps + Architect)
- Others' task files

**Implementation:**

```bash
gh pr view <N> --json files --jq '.files[].path' | grep -E '^(scripts/pm/|scripts/devops/|.claude/agents/|docs/business/|\.github/workflows/|\.claude/hooks/)'
```

If there is a match → Verdict: BLOCK + the body contains the specific file paths and a link to the `coder.md` "Zone-of-write" section.

### 4. Confidence-tagged findings (cross-reference ECC)

**Already in ECC code-reviewer.md** — this skill **does NOT duplicate** the HIGH/MED/LOW gate. Reference: `.claude/agents/code-reviewer.md` §"Confidence policy (Pre-Report Gate)".

**Delta on top of ECC:**

- HIGH with a zone-of-write violation = automatic BLOCK (this file §3).
- A MED finding on a `--no-verify` push (Coder bypassed the pre-push hook) = BLOCK (this is a P0 invariant for the CRM, see coder/lessons.md 2026-06-02).
- A LOW finding on a "pre-existing flake" rationalization (Coder wrote off an E2E as a flake without isolated rerun proof) = MED escalation (see coder/lessons.md 2026-06-02).

### 5. Owner==reviewer also affects approve flow

**Rule:** In the CRM there is a single AI owner — this means `event: APPROVE` also cannot come from the same account as the author. When code-reviewer/security-reviewer wants APPROVE — use `event: COMMENT` + the first line `Verdict: APPROVE`. Master parses it the same way as BLOCK.

**Real impact:** The GitHub UI on the PR will show the review as a "comment" with an emoji, but Master's aggregate verdict logic works correctly (parses the Verdict: line, not the event type).

### 6. Your own checkout — and proof that it matches the reviewed commit

**Rule:** the reviewer by default **does not take a worktree** — he reads the diff via
`gh pr diff` / GitHub MCP. But as soon as he needs to **run, measure or roll back**
code (checking redness, reproducing, measuring) — the reviewer makes **HIS OWN**
checkout, whose path is derived from **his own** identifier, and works
only in it.

**Source of the problem (two incidents, both cost cycles):**

- **PR #493, 2026-08-07.** Two reviewers got the same working directory
  (`/tmp/rev<PR>` — the path from the PR number is the same for everyone reviewing this PR).
  Mid-check, someone else's changes appeared in the security reviewer's directory:
  an injected min-width and an extraneous test file — the trace of a parallel
  code reviewer. He noticed and re-ran the measurements, but he might not have: then
  one agent's mutation would have gotten into another's conclusions **as a property of the code**. In the same
  PR this already happened: "858 px" went into the report as a measurement of a live component,
  being a consequence of his own injection.
- **PR #551, 2026-08-17.** A reviewer was checking redness — rolling a file back to
  the previous version — **in the live worktree of a coder working at that moment**.
  Had the timing been different: either the coder's work would be spoiled, or the review read
  mutated code and rendered a verdict on it.

**Implementation:**

```bash
# 1. the directory from YOUR OWN identifier, not from the PR number.
#    $SCRATCH — the session scratchpad the harness gives you personally;
#    if you are in a worktree — `git rev-parse --show-toplevel` works too.
CHECKOUT="$SCRATCH/checkout"

# 2. the real head commit of the PR, not the "latest main"
SHA=$(gh pr view <N> --json headRefOid --jq .headRefOid)
git worktree add --detach "$CHECKOUT" "$SHA"

# 3. MANDATORY before any measurement: the tree == the reviewed commit and clean.
#    One command — this exact step saved #493.
git -C "$CHECKOUT" status --porcelain && git -C "$CHECKOUT" rev-parse HEAD
#    empty + SHA matched → measuring is allowed. Non-empty → this is NOT the code in the PR:
#    stop, rather than "probably unimportant".

# 4. finished — clean up YOUR OWN checkout (do not touch others'):
git worktree remove "$CHECKOUT"
```

**A mandatory line in the review body** (without it the measurements are unverifiable):

```
Checkout: <abs path> @ <sha> (clean)
```

Two reviewers with the same `Checkout:` = a directory collision, visible to Master in the aggregate.

**Red lines:**

- Do not mutate someone else's tree — never. Mutation for a redness check is done in your own checkout.
- Do not work in the shared checkout (the orchestrator's directory). `pre:bash:cross-agent-blast` refuses, but relying on the hook — the second echelon, not the first.
- Do not delete someone else's worktree; your own — clean up after yourself.

### 7. Numbering the findings (so they can be transferred one by one)

**Rule:** each finding gets a stable identifier `<ROLE>-<SEV>-<N>`
(`CR-H-1`, `SR-M-2`, …) **at the moment the review is written**, and at the end of the body —
a control line:

```
Findings: CR-H-1, CR-H-2, CR-M-1 (3)
```

**Why:** on PR #504 (2026-08-11) the orchestrator, when compiling the "what to
finish" list, **lost a security finding** — a bypass of the glyph check. He did not reject it,
he simply did not transfer it; the coder predictably did not do it. It was caught only by comparing
the report with the original review. Numbering + a control line turn this comparison into a
comparison of two numbers.

The full rule (who transfers, who reports, why not a CI gate) —
`.claude/rules/common/review-findings-transfer.md`.

## Anti-patterns

| ❌ Don't                                                                   | ✅ Do                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `event: REQUEST_CHANGES` to block OR `event: APPROVE` to approve           | `event: COMMENT` + the first line `Verdict: BLOCK` \| `Verdict: APPROVE`      |
| `mcp__github__create_pull_request_review` without a prior `Write`          | Write file → MCP → gh fallback → Master recovery (chain)                      |
| Ignoring diff trojan-changes in `scripts/pm/**` / `.github/workflows/**`   | Auto-BLOCK + specific file paths in the body                                  |
| Posting a review with a LOW finding in the body                            | LOW only in the summary for Master, NOT in the PR body (see ECC Pre-Report Gate) |
| BLOCK without naming the specific line of code / link to a rule            | Each HIGH finding with file:line + a reference to `.clauderules` / coder.md zone |
| Working in a directory from the PR number (`/tmp/rev<PR>`) or in someone else's worktree | Your own checkout from your own identifier + the line `Checkout: <path> @ <sha>` (§6) |
| Rolling a file back for a redness check in the live tree of a working agent | The same rollback in YOUR OWN checkout of the needed commit (§6)             |
| Measuring/running without checking that the tree == the reviewed commit    | `git status --porcelain` + `rev-parse HEAD` before measuring (§6, saved #493) |
| Findings without identifiers — they cannot be transferred one by one       | `CR-H-1` … + the control line `Findings: … (N)` (§7)                          |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/reviewer/lessons.md` (2026-05-21, 2026-05-23 — 3 substantive items)
- ECC equivalent (parent, NOT duplicated here):
  - `.claude/agents/code-reviewer.md` §"Confidence policy (Pre-Report Gate)" — HIGH/MED/LOW levels
  - `.claude/agents/security-reviewer.md` §"Confidence policy" — OWASP-tagged HIGH
- Related agent docs:
  - `.claude/agents/contracts.md` §4 (aggregate verdict logic + review-timeout recovery)
  - `.claude/agents/coder.md` §"Zone-of-write" (full forbidden list)
- Related rules (§6–§7, added 2026-08-17):
  - `.claude/rules/common/agent-isolation.md` — why the directory is derived from one's own identifier; what the harness already gates, and what the hooks do
  - `.claude/rules/common/review-findings-transfer.md` — transferring findings by identifier, a report on each
  - `docs/architecture/2026-08-17-agent-collision-mechanics.md` — the analysis of incidents #493 / #551 / #504
- Related skills:
  - `dev-flow-resilience` (write-then-post — same pattern, applied to Coder/Master)
  - `superpowers:requesting-code-review`
