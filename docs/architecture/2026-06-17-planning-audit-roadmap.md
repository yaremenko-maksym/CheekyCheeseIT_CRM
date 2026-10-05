# ADR 2026-06-17 — Planning audit, process-debt enforcement matrix & prioritized roadmap

**Status:** Proposed (planning cycle — NOT execution; zero production code, zero merge)
**Type:** Planning / Process / Roadmap
**Author:** PM planning session
**Scope:** a read-only audit of the state + a written roadmap. Decisions on forks — with the owner (AskUserQuestion).

> This document is self-contained. Sources for each conclusion are given inline. Where I judge by
> artifacts (task-files, memory) rather than by a direct fact in the code — it is marked explicitly.

---

## Context

A review of the current state of the CRM before choosing the direction of the nearest iterations. Three questions:
(1) what is really done vs "in flight"; (2) are the recurring incidents from
ADR 2026-06-16 (FM-1..FM-7) structurally closed; (3) what Phase 8 should be and how to implement it safely.

---

## Decisions (resolved 2026-06-17 — owner)

Three Part 7 forks resolved by the owner — the plan is updated for them:

1. **Order: process-debt FIRST.** Close the FM-5 guard-test CI gate + the FM-2 worktree→main hook
   BEFORE Phase 8 (it is exactly the finance/RBAC class the gate is needed for).
2. **Phase 8 REDEFINED: smart contracts CANCELLED.** Instead of the on-chain PaymentSplitter —
   the **"Company account"** feature (USDT ERC-20): a single company wallet to which SENIORs and DROPs
   transfer money; the incoming payment is confirmed by a **link to the transaction** (Etherscan verification,
   `etherscan.service.ts` already exists); a pending-tx → a **block-resolution progress bar**; ADMIN withdraws
   funds as **dividends** (business logic on the Finance page); the 50/50 between ADMINs is preserved
   - a **common company account** appears for salaries/expenses. The design — top-notch.
     → No Solidity / Hardhat / mainnet deploy / external audit / multisig. **Risk H → M.** A real
     money/RBAC/crypto-custodian surface remains → Legal + the FM-5 gate are mandatory.
3. **Cut process weight — yes, per the Part 6 list** (archive the completed ECC playbook `architect.md`,
   remove the `reviewer.md` shim, archive 8 stale task-files).

---

## Part 1 — Reconciliation of the state (what is ACTUALLY in flight)

**Conclusion: there is NO genuinely in-flight work.** 0 open PRs (`gh pr list --state open` empty),
0 fresh unmerged feature branches (all unmerged-remote branches lag main by 70–210 commits —
old stuff: `assets/*`, `chore/dispatch-*`, `polish/platform-audit`).

8 task-files in `.claude/tasks/` — **stale artifacts of completed work**, not a backlog. Their branch SHAs
are not ancestors of `origin/main` precisely because the work was **squash-merged** (a squash creates a new
commit on main, the original branch SHA is orphaned). Reconciliation by merged PRs confirms:

| Task-file                         | Actually merged as        |
| --------------------------------- | ------------------------- |
| `task-admin-as-senior`            | #227 / #232               |
| `task-drop-phase3-frontend`       | #198                      |
| `task-fix-contract-real-pdf-size` | #195 / #196               |
| `task-fix-junior-ut-round5`       | #188 / #174 (junior cycle)|
| `task-fix-missed-pages-layout`    | #238                      |
| `task-hr-dashboard-tweaks`        | #239                      |
| `task-hr-rbac-teammate-access`    | #210 / #211 (HR RBAC)     |
| `task-senior-dashboard-enhance`   | #234 / #235 / #236        |

→ These 8 files need to be **archived** (`.claude/tasks/archive/` — there are already 123 records there, archiving
is the norm; these just slipped through). This is the first and cheapest piece of doc-debt. See Part 6.

**Role status (from memory `project-drop-accountant-2026-06-14` + merged PRs #234–245):**

| Role       | Status                                                                          |
| ---------- | ------------------------------------------------------------------------------- |
| ADMIN      | full (+ admin-as-senior #227/#232)                                              |
| JUNIOR     | done (#170/#172/#174 + UT rounds)                                               |
| DROP       | done (user confirmed after #208)                                                |
| ACCOUNTANT | **feature-complete** (#207–#230)                                                |
| SENIOR     | dashboard substantially built (#234/#235/#236/#243/#245) — only a QA audit needed |
| HR         | dashboard + RBAC exist (#210/#211/#212/#239); **the "build-out" scope is NOT defined** ⚠ |

**Main conclusion of Part 1:** the "HR/accountant-S2/senior finishings" from the brief are mostly **already in main**.
The only under-defined piece is what "HR build-out" means (the dashboard exists; beyond that — nothing without BA scoping).
The real work front = **Phase 8** + **process-debt** + **doc-entropy** + a handful of LOW bookmarks.

---

## Part 2 — Process-debt: enforcement matrix (FM-1..FM-7)

For each incident class from ADR 2026-06-16: is there an **enforcing** control (CI/hook),
or only a lesson-in-the-prompt? Verified by fact (`.github/workflows/`, `.claude/hooks/`, `.husky/pre-push`,
`vitest.config.mts` history).

| FM   | Class / real cost                                                             | Enforcing control today                                                                                                            | Status                                                      |
| ---- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| FM-1 | over-parallelism → 529-deaths at startup + CPU-starvation pre-push flakes      | `.husky/pre-push` now runs packages **sequentially** (ADR follow-up #3 ✅ done); concurrency-cap ≈3-4 — **only a lesson**        | **PARTIAL** (CPU side enforced; the cap is advisory by nature) |
| FM-2 | MAIN-contamination by a worktree agent (~5-6×/session; 1× switched the live :3000) | zone-hook `pre-edit-write-zone-of-write.sh` — but a **documented gap**: does NOT catch worktree→main `apps/**`; + a manual PM check | **UNCLOSED** (infra-gap, ADR follow-up #2)                  |
| FM-3 | flaky-E2E masked by `retries:2` (a green re-run hides instability)             | `playwright-patterns` skill — **only a lesson**                                                                                   | **NOT enforced**                                            |
| FM-4 | integration concurrency flake on shared CI-postgres                            | `fileParallelism:false` for integration (#216) + a `globalSetup` guard blocks the local `crm_db` (#233)                           | **CLOSED** ✅ (enforced)                                    |
| FM-5 | **mocked-E2E misses global guards → real PII/finance leaks**                   | security-reviewer mandatory + Manual QA — **only agent discipline**                                                              | **NOT enforced — the most expensive unclosed risk** ⚠      |
| FM-6 | "completed" ≠ done (agent cut off mid-flight)                                  | `pre-bash-coder-push-gate.sh` (ac_verified gate) ✅ partially; RULES §4.2 checklist — discipline                                   | **PARTIAL**                                                 |
| FM-7 | stacked-PR rebase after squash (closes, does not retarget the stack)           | a recipe in memory — **only a lesson**                                                                                            | **NOT enforced** (rare)                                     |

### Headline conclusion of Part 2

**The most recurring and most expensive class — FM-5 — has ZERO enforcing controls, only
discipline.** It produced real OWASP A01 holes 3× (#157 identity-leak JUNIOR→SENIOR, #158 finance-leak
to any logged-in user), and **both were on main** (shipped to prod). Front-only gating (`enabled: isAdmin`)
= UX, not security; a mocked-E2E is self-fulfilling green even without a guard. This is — priority #1 for a gate,
**especially before entering Phase 8** (money endpoints — exactly the same class of surface).

FM-2 — the second unclosed one: the hook exists, but has a precisely described gap, and hit ~5-6×/session.
FM-4 — a model of how it should be done: the class is closed by TWO enforced controls, incidents stopped.

---

## Part 3 — Prioritized roadmap

Format: {what · why · risk · dependencies · agent type · rough duration}. Split into 4 buckets.

### (d) Process-debt (CI/hook gates) — RECOMMEND FIRST

> Cheap, high leverage, and Phase 8 is dangerous to start without the FM-5 gate. Implementation details — Part 4.

| #   | What                                                                                            | Risk               | Dependencies       | Agent     | Dur.     |
| --- | ----------------------------------------------------------------------------------------------- | ------------------ | ------------------ | --------- | -------- |
| d1  | **FM-5 guard-test gate** (CI): a controller-diff on security paths requires a real-backend 403 test | — (removes H-risk)  | —                  | DevOps    | 0.5–1 it |
| d2  | **FM-2 worktree→main hardening** in the zone-hook (block a write to a main-abs path from a worktree) | —                  | —                  | Architect | 0.5 it   |
| d3  | Remove the `reviewer.md` shim (ADR follow-up #1) + prune the agent docs (see Part 6)            | L                  | owner's fork       | Architect | 0.5 it   |
| d4  | A `testing` rule: integration invariant (serially / uniquely-marked asserts, FM-4)             | L                  | —                  | Architect | 0.3 it   |
| d5  | Move the stacked-PR recovery recipe into `git-policy.md` (FM-7)                                 | L                  | —                  | Architect | 0.2 it   |

### (a) In-flight finishings — almost all in main; what remains:

| #   | What                                                                                                                                    | Risk | Dependencies         | Agent     | Dur.         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------- | --------- | ------------ |
| a1  | **HR build-out scoping** — define what "finish building HR" means (the dashboard exists)                                                | L    | BA brief             | BA → PM   | 0.5 it       |
| a2  | SENIOR QA audit (the dashboard is built #234–245; a manual-QA pass is needed)                                                           | L    | —                    | manual-qa | 0.3 it       |
| a3  | Accountant S3 — analytics/reports (deferred S2)                                                                                         | L–M  | an a-brief           | BA→Coder  | 1–2 it       |
| a4  | LOW bookmarks: a lint-rule on profile `<Link>` (#208) · DROP-banner hover-cosmetic · index tech-debt (composite index accountant-summary) | L    | —                    | Coder     | 0.5 it batch |
| a5  | crm_db residue cleanup (~118 stale DROP commands) — **destructive, on the USER's word**                                                 | M    | explicit "yes" from owner | DevOps    | 0.2 it       |

### (b) Phase 8 — "Company account" (USDT ERC-20) — REDEFINED (smart contracts cancelled)

**Risk M — real money is tracked, but there is no autonomous on-chain code / mainnet deploy.**
Not an on-chain split, but: contractors send USDT to the company wallet → verification of the tx by the link →
ADMIN distributes (dividends 50/50 + a common account for salaries/expenses). The safety gate — Part 5.

| #   | What                                                                                                                                                                                                                                                              | Risk | Dependencies                  | Agent                | Dur.   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------- | -------------------- | ------ |
| b0  | **Brainstorm + BA brief** of the feature (resolve the open questions below: thresholds, custodian, reconciliation, migration of the old finance model)                                                                                                           | M    | —                             | BA + brainstorming   | 0.5 it |
| b0b | **Legal pre-check**: company USDT custodian + ADMIN dividends (UA crypto/AML/taxes — `ua-crypto-compliance` + `ua-tax-compliance`)                                                                                                                               | M    | —                             | legal                | 0.5 it |
| b1  | DB model: `company_account` (balance/ledger) · inbound deposits (`txHash`+status+confirmations) · withdrawals/dividends · link with 50/50 + the common account. A revision of outdated fields (`payout_requests`/`pending_obligations`/`seniorSharePercent`/`dropSharePercent`) | M    | b0                            | architect + coder    | 1 it   |
| b2  | Backend: a submit-tx endpoint → Etherscan verification (confirmed/pending/N confirmations) · **idempotent** (one `txHash` ≠ a double credit) · RBAC · reconciliation of the address/amount                                                                       | M    | b1, **d1 (guard-gate ready)** | coder + security     | 1–2 it |
| b3  | Frontend: a "send a link to the transaction" form + a **block-resolution progress bar** (live confirmations) + a company account page. Design **Mode A before coding**                                                                                           | M    | b2                            | ui-ux + coder        | 1–2 it |
| b4  | Finance: ADMIN **dividend withdrawal** + a **common account** (salaries/expenses) + preservation of 50/50; separation-of-duties (withdrawal only by ADMIN, cf. #222)                                                                                             | M    | b1                            | coder + security     | 1–2 it |
| b5  | Manual QA on the live stack + security-review (finance/RBAC/money) + integration guard tests (403)                                                                                                                                                               | M    | b2,b3,b4                      | manual-qa + security | 1 it   |

**Open questions for brainstorm b0 (genuine ambiguities — do NOT resolve by default):**

- The company wallet address — one common one (the owner said "common account"); where does it come from (config / a separate table)?
- The confirmation threshold = "credited" (default candidate 12 ETH blocks). Confirm.
- Who confirms the incoming payment: auto on Etherscan-confirmed, or does ACCOUNTANT validate (the current `PENDING→VALIDATED` workflow)?
- Reconciliation: the tx goes to the company address + the amount == the expected one; a mismatch → manual validation, not an auto-credit?
- "Available for withdrawal" for dividends = the total balance − the reserve for salaries/expenses? How to compute it?
- The fate of the old finance model (`payout_requests`/`pending_obligations`/smart-contract fields) — what is reused, what becomes obsolete.
- The network for verification: USDT ERC-20 = Ethereum mainnet (we read others' transfers, we do NOT deploy the contract); Etherscan API mainnet.

### (c) Phase 9 — dashboard: **RECOMMEND REDEFINING**

Per-role dashboards already live at `/crm` (#223 consolidation). The original Phase 9 "dashboard = placeholder"
is partly **outdated**. Redefine as:

| #   | What                                                                                                        | Risk | Dependencies | Agent | Dur.   |
| --- | ----------------------------------------------------------------------------------------------------------- | ---- | ----------- | ----- | ------ |
| c1  | Finish the generic ADMIN/SENIOR dashboard (#231 MED-defer: header fixed-model + real KPIs instead of placeholder) | L    | —           | coder | 1 it   |
| c2  | Cross-role analytics/reporting (overlaps with a3 accountant S3)                                             | M    | a3          | coder | 1–2 it |

---

## Part 4 — Top 3 self-enforcing process improvements (specifics)

Not "improve the tests" — but: which check, on which paths, what it asserts.

### 1. FM-5 "guard-test gate" — a new CI job (priority #1)

- **Where:** a new job in `ci.yml` (or a separate workflow), trigger `pull_request: [main]`.
- **On which paths:** changed files `apps/api/src/{users,finance,transactions,auth,projects,teams,legends,documents}/**/*.controller.ts`.
- **What it asserts:** if the diff touches a route-handler in these paths — the PR diff MUST also contain
  a change to a `*.integration.spec.ts` (real backend, no mocks) with at least one assert
  "a caller without permissions → 403" (grep `.expect(403)` / `ForbiddenException` / `toBe(403)` / `status).toBe(403`).
- **Behavior:** no such test → label `needs-guard-test` + a reminder comment (soft block,
  the Reviewer resolves) OR hard-fail (a strictness fork). Opt-out: a marker `guard-test-na: <reason>`
  in the PR body, which the reviewer must justify.
- **Why exactly this:** the only class that shipped real vulnerabilities to prod 3× (#157/#158).
  The gate makes "a mocked-E2E on a security path" = an explicit failure, not silent false-confidence.

### 2. FM-2 worktree→main hardening — tighten the PreToolUse zone-hook

- **Where:** `.claude/hooks/pre-edit-write-zone-of-write.sh` (live PreToolUse).
- **What it asserts:** resolves the absolute path of the Edit/Write target; if it is under the MAIN-repo root
  (`…/CheekyCheeseIT_CRM/apps/**` | `…/packages/**`) AND the session cwd = a worktree (`…/.claude/worktrees/*`) →
  **BLOCK** with an explicit message "write inside your own worktree".
- **Why:** closes the precisely described infra-gap (ADR follow-up #2), which hit ~5-6×/session and
  once switched the user's live :3000 stack to a feature branch. For now — only a manual PM check.

### 3. Doc-entropy auto-trigger — forced archiving of stale artifacts

- **Where:** a scheduled workflow (weekly) OR a step in `auto-merge-on-label.yml` post-merge.
- **What it asserts:** greps `.claude/tasks/task-*.md` by `last_push:`/`last_commit:`; if the branch
  no longer exists on origin (squash-merged + auto-deleted) → the file is a candidate for the archive →
  a comment/issue with a list "archive N files". Opt.: flag agent docs of a completed phase
  (architect.md ECC playbook) when the phase is marked done in `project-state.md`.
- **Why:** the 8 stale task-files directly prove that consolidation is currently ad-hoc and slips through.
  The trigger makes the entropy visible and enforced.

---

## Part 5 — Phase 8 ("Company account"): the safety-gate set

Smart contracts cancelled → the mainnet/audit/multisig gates are **not applicable**. But real USDT moves
(incoming from contractors + ADMIN dividends) → money/RBAC/crypto-custodian discipline is mandatory.
Money-movement = **human + legal** (a hard rule of the brief). Not one item is bypassed by default.

1. **No auto-credit without a confirmed tx.** The backend credits an incoming payment to the company account ONLY when
   Etherscan returned confirmed (≥ the block threshold). Pending → only a UI block-resolution progress, NOT a balance.
2. **Idempotency.** One `txHash` = one incoming payment. Re-sending the same link does not duplicate the credit
   (UNIQUE on txHash + a check before recording).
3. **Verification on the real backend (FM-5).** The submit-tx + dividend-withdrawal + company-account endpoints —
   exactly the finance/RBAC class → MANDATORY integration guard tests (a caller without permissions → 403), NOT a mocked-E2E.
   This is the d1 gate in action (which is why d1 goes BEFORE Phase 8).
4. **RBAC + separation-of-duties.** Withdrawal/dividends from the company account = only ADMIN; ACCOUNTANT sees/
   validates, but does not withdraw (cf. security MED #222 SALARY self-pay). Explicitly record the initiator of the withdrawal.
5. **Reconciliation of the address/amount.** The tx must go TO the company account address + the amount is reconciled with the expected;
   a mismatch → flag for manual validation (ACCOUNTANT), not an auto-credit.
6. **Etherscan reliability.** Rate-limit/timeout/API error → graceful (the progress bar does not "hang");
   polling with backoff; an explicit status "failed to verify — retry".
7. **Legal sign-off (crypto custodian).** The company accepts USDT from contractors + ADMIN withdraws as
   dividends → UA crypto/VASP/AML + the tax qualification of the dividends (`ua-crypto-compliance` +
   `ua-tax-compliance`, law 2074-IX not enacted, the tax-service ban on crypto under the single tax). Legal review before release (b0b/b5).
8. **Release = an explicit human decision** (owner + legal) for the money-flow. PM does not approach releasing
   the feature without a Legal review and Manual QA on the live stack.

---

## Part 6 — Doc-entropy & process weight

**Fact:** ~5816 lines of agent docs. The largest: `pm-snippets.md` 1044, `architect.md` 705, `pm.md` 637.

**Concrete candidates for abolition/archive (not slogans):**

- **`architect.md` (705 lines)** — this is entirely a **playbook of the completed ECC migration** ("Migration to ECC",
  phases 0–6). The migration is done (memory `project_ecc_migration_done`). → **Archive** it in
  `docs/architecture/archive/` and replace it with a thin `architect.md` (the role for ADR/refactors, ~80 lines).
  Minus ~620 lines without loss of control.
- **`reviewer.md` (45 lines)** — a deprecated shim, ADR follow-up #1 directly prescribes removal. → Remove.
- **8 stale task-files** → archive (Part 1).
- **`pm-snippets.md` (1044)** — the heaviest; **do NOT cut blindly** (loaded on-demand via the
  `pm-dispatching` skill, not in PM's system prompt). A candidate for a revision-dedup, but low priority.

**A forced consolidation trigger** — see Part 4 #3 (instead of ad-hoc).

---

## Part 7 — Forks for the owner — RESOLVED 2026-06-17

1. **What to plan first** → **process-debt first** (d1 FM-5 gate + d2 FM-2 hook), then Phase 8.
2. **Phase 8** → **smart contracts cancelled**; instead — the "Company account" feature (USDT, verification of the tx by the
   link + ADMIN dividends + a common account). An external audit is no longer needed (no on-chain code). See Decisions §2.
3. **Cut process weight** → **yes, per the Part 6 list** (archive the `architect.md` ECC playbook + remove the
   `reviewer.md` shim + archive 8 stale task-files).

### Recommended execution sequence (after this plan)

1. **Doc-cut** (Q3, docs-only light-track, owner approved) — the cheapest, can be done immediately: d3 + Part 6.
2. **Process gates** d1 (FM-5 guard-test CI) + d2 (FM-2 worktree-hook) — a DevOps/Architect dispatch.
3. **Phase 8 "Company account"** — start with b0 brainstorm + b0b Legal pre-check (resolve the open questions),
   then b1→b5 per the roadmap. Full pipeline (security-reviewer mandatory — finance/RBAC/money).
4. In parallel if desired: a1 HR-scoping (BA), a2 SENIOR QA, a4 LOW bookmarks batch.

---

## Consequences

- A clear picture: in-flight ≈ empty, the front = Phase 8 + process-debt + doc-entropy.
- FM-5 identified as the most expensive unclosed risk (0 enforcement, 3× prod leaks) → priority #1.
- Phase 8 got a minimal gate set with explicit human+legal points.
- The roadmap — a single prioritized source with risk tags (this file = a candidate for a "living roadmap").

## Follow-ups (depend on the answers to Part 7)

- Implement the chosen first bucket.
- If "cut process" = yes → a separate Architect dispatch for archiving (docs-only, light-track).
- Phase 8 — only after an explicit start + a Legal pre-check.

## Sources

- `gh pr list` (open=0, merged #232–246), `git branch -r --no-merged`, `.claude/tasks/*` SHA reconciliation.
- ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` (FM-1..FM-7).
- `.github/workflows/*`, `.claude/hooks/*`, `.husky/pre-push`, `vitest.config.mts` (#216/#233) — the enforcement fact.
- `.claude/agents/project-state.md` §1/§1.1 (phases, the Phase 8 plan).
- Memory: `project-drop-accountant-2026-06-14`, `session-ops-lessons-2026-06-15`,
  `feedback-mocked-e2e-guards`, `feedback-agent-completion-verification`, `project-push-and-stacked-pr-gotchas`.
