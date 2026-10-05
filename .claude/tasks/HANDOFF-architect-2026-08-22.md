# Handoff to the architect — 2026-08-22

The session closed bugs from `BACKLOG-followups.md` and drove the cascade of editing paid transactions.
During the day findings accumulated that **cannot be fixed with a patch** — they need an architectural answer.
That is the subject of the next session.

---

## Part 1. What requires an architectural decision

### 1.1. The verification gates on money paths do not prove what we expect of them

Four independent facts, each harmless on its own, together a hole:

1. `check-mutation-tally.mjs:101-110` goes red **only** on `Survived > 0`. `NoCoverage` passes silently.
2. Stryker has **no mutator for operators inside template strings** — logic in SQL fragments
   is structurally unprovable by this gate.
3. The mutation gate **does not see** `*.integration.spec.ts`. On #603 because of this the whole new endpoint gave
   "0 killed" with live integration coverage; it is cured by a unit duplicate per
   `mutation-gate-integration-specs.md`, but the problem can only be noticed by reading the log —
   **the gate's verdict is green meanwhile**.
4. `Integration Tests (Postgres)` **is not a required check** on `main` (verified against the API
   branch protection: `Typecheck · Lint · Unit Tests` and `E2E Tests` are required).

Composition: **on paths where the logic lives in SQL, a green mutation gate means nothing, and
the only check that means anything there does not block the merge.** Precedents of the day:
the mutant suppressions on #600 and #603 are justified by "caught by an integration spec" — that is, they rely
on a non-required check.

**Question to the architect:** which gate construction gives provability on money paths. Options
visible from below: make the integration ones required; turn the gate red on `NoCoverage` without
`integration-hint`; introduce a separate required money-path check. A choice with justification is needed, not
all three at once.

**The owner's decision is pending on the item "make `Integration Tests (Postgres)` a required check".**

### 1.2. An invariant that props up someone else's code is not recorded anywhere

`#603` HIGH-2-residual — the subtlest finding of the day. The resolver in `@crm/shared` compares the currency with
the literal `'USDT'`. This is correct today **only because** the immutability of the currency is held by BIZ-18 —
a guard that **task 3 of the same cascade** removes. No test will catch this: a unit on the `apps/api` side
will prove the existence of the literal, but not another package's dependence on it.

Next to it is an asymmetry worth thinking about: on the **write** side of the same database
(`pending-settlement.service.ts:806`) on an analogous invariant that is unreachable today they refuse
**loudly**. The write side chose fail-loud, the read side a silent assumption.

**Question to the architect:** a mechanism is needed by which "code A depends on an invariant held by code B"
is recorded so that the author of the next task sees it. A comment is not a mechanism (see 1.3).

### 1.3. "Keep the copies in sync" occurs in the code literally

`autoCreateForPayout` counted the invoice amount as a third independent copy of the rule, and its comment
**directly asked the reader to sync the copies by hand** ("signInvoice PAYOUT branch mirrors this
exactly"). The copies diverged. Eliminated in #600 by reducing to a single helper.

**Practical conclusion for the audit:** the wording "mirrors X exactly" in a comment is almost always
a marker of a third copy. Worth running across the repository.

### 1.4. The currency lies next to the value but does not enter the arithmetic

The same structural defect was found twice during the day **in unrelated places**:

- **Invoices (#600):** an act for 1000 USD against a verification response of 740 USDT.
- **Cascade (#603):** the USDT share minus an accumulator stored in the payment currency. An obligation
  closed in hryvnia puts ≈2000 into the accumulator — and almost any edit declares the drop
  overpaid, depriving them of the top-up.

The shared form: the `amount` + `currency` pair exists, but subtraction/comparison ignores the currency, and
the currency warning is hung **on top of** the already computed number.

**Question to the architect:** should a money type be introduced (value + currency as one quantity) at least
in `@crm/shared`, and if so — where is the boundary of adoption. Plus: a sweep of the other money paths is needed for
the same form (`codebase-audit`, read-only fan-out).

### 1.5. The act for a mixed batch prints a meaningless number (product-legal)

A batch of rows in different currencies is converted to USDT at NBU rates, the result lies in
`transactions.amount`. Whereas the PDF carries a **blind sum of the raw numbers** with the currency of an arbitrary row.
A person ends up with a legal document with a number that means nothing.

Important: "just forbid mixed currencies" is **not an option**, such a guard already existed and was removed
**as a bug** (`transactions.service.ts:4208-4214`, it blocked legitimate batches).

**The owner's verdict is needed** (possibly with a lawyer): the blind sum, the converted total, or a breakdown
by currency. For the architect — to formulate the options with consequences. Backlog items 83/84.

---

## Part 2. State of the paid-transaction-edit cascade

ADR: `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md` (884 lines, AC1–AC6 +
decomposition into 6 tasks). The order is dictated by dependencies.

| #   | Task                                               | State                   |
| --- | -------------------------------------------------- | ----------------------- |
| 0   | Fix L3 (both copies of the amount)                 | ✅ merged, #598         |
| 1   | Snapshot infrastructure (`settled_amount` and co.) | ✅ merged, #599         |
| 2   | Resolver + preview (read-only)                     | 🔄 PR #603, fix round 2 |
| 3   | **Applying the cascade** (core, writes money)      | ⬜ not started          |
| 4   | Invoice: voiding on edit                           | 🔄 PR #600, round 7     |
| 5   | UI: preview, `PENDING` with "already paid"         | ⬜ not started          |

### What is critical not to lose in task 3

- **The ledger term — "the most important thing in AC3".** The company account debit rests on `status='PAID'`.
  Rolling back `PAID → PENDING_PAYMENT` **removes the debit**, and the balance grows by exactly the already paid
  amount — while the money has physically gone. An inflated balance is the input to the money gate
  `if (amount > balance) throw`: the system will allow spending what does not exist. **A variant without
  compensation in the ledger is not an acceptable solution.**
- **Guard 2 (`payoutRequestId`) must not be removed** — it is the only one that mechanically keeps the cascade
  single-level (proof in AC3).
- **BIZ-18 is removed surgically — only for `amount`.** This is **one** condition on
  `amount || currency || salaryMonth`. A broad removal ("a PAID row became editable") hits
  twice at once: it will open the live `data.currency` branch (a mirror defect of 1.2/1.4) **and** activate
  SR-M-1 — `oldAmount` is taken from rows with the literal `currency: 'USDT'`, but is labeled
  `sourceCurrency`, so the admin will see a USDT number labeled EUR. Both defects are today
  unreachable and both wait for exactly one wrong move in task 3. Backlog item 95.

---

## Part 3. Where we stopped

**Everything that was in progress is merged.** Branch `main` at the time of handoff:

| PR   | What                                          | Outcome                  |
| ---- | --------------------------------------------- | ------------------------ |
| #598 | Task 0 — both copies of the obligation amount | merged                   |
| #599 | Task 1 — snapshot infrastructure              | merged                   |
| #601 | Sorting finances by visible date + table jump | merged                   |
| #603 | **Task 2 — resolver + preview**               | merged (3 review rounds) |
| #604 | Stack overflow in render measurements         | merged                   |
| #600 | **Task 4 — invoice voiding**                  | merged (7 review rounds) |
| #605 | `.claude/tasks/` hygiene + this handoff       | merged                   |

`#602` (`infra/afk-pipeline-migration`) is run by a **parallel session** — do not touch.

### Next step — task 3

This is the core of the cascade: the first thing that actually writes money. Requires tasks 1 and 2 (both in `main`).
**`security-review` is mandatory.** What is critical — the section above; in short: the ledger term, guard 2,
the surgical removal of BIZ-18.

Task 5 (preview UI) — after 3. Task 4 is closed.

## Part 4. Hygiene found along the way

- **The documentation references 9 task files that are not in the repository** (`.claude/tasks/*.md`
  is in `.gitignore`, but 39 files were committed before the rule). For a fresh clone the links are broken.
  Also: 29 committed `*.progress.md` / `*.blocked.md` — working scraps from June–August, all
  the work is merged; they contradict the project's own `.gitignore`. **Removed in PR
  `chore/tasks-hygiene`**, an exception for `BACKLOG-*` and `HANDOFF-*` was added there too: until then
  the cumulative backlog (113 KB of findings) existed **only locally** and would not have survived the loss of the
  machine.
- **`WORKING-CONTEXT.md` in the root has not been updated since 2026-06-03**, while it claims to track
  "active sprint, blockers, queues". There are 5 references to it. Either update it or withdraw the claim.
- **The label `security-noted` does not exist in the repository**, although `.claude/agents/security-reviewer.md`
  prescribes setting it. Reviewers run into this every time.
- **A manual cleanup of `payout_requests` will break signing of acts** (FK `ON DELETE SET NULL` will null
  `payoutRequestId` → `signInvoice` will start failing with 409). Currently unreachable, but the schema **itself**
  calls such a cleanup realistic. Backlog item 90.

---

## Part 5. What to read before starting

1. `.claude/tasks/BACKLOG-followups.md` — items **70–92** were written by this session, this is the concentrate
   of findings. Especially 70 (emptiness as information), 86 (incomparable quantities), 87 (a blind
   property test), 91 (an invariant removed by the next task).
2. `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md` — AC3 and AC4 in full.
3. `.claude/tasks/task-invoice-signature-integrity.md` and `task-cascade-resolver-preview.md` —
   the protocols of all review rounds with the justifications of the decisions.

## Appendix. The recurring motif of the day

Five of the eight findings of the day have one form: **a confident answer where there is no answer.**
A column fill that erases the "unknown" marker (item 70). A flag asserting `false` instead of
"not determined" (item 89). A mock making a branch unreachable while the gate is green (3 cases).
A property test whose generator does not produce the disputed case (item 87). Substituting someone else's number instead of
a refusal (#600 HIGH-4).

In all cases the system was **not wrong, but confidently wrong** — and it was the confidence that prevented
noticing. This is worth keeping as a working hypothesis in the next audit.
