# BACKLOG — accumulated follow-ups from the 2026-07-27 reviews

Not blockers. Collected from verdicts so they don't get lost between PRs. Dispatch as a batch once
the main security batch ships.

---

## AUDIT 2026-08-16 — all 59 items checked against `origin/main` (6fa735f1)

Three read-only agents, non-overlapping slices, a verdict on each item with evidence
(`file:line` or command output). A verdict without evidence was not accepted.

**Result: 17 already closed · 39 alive · 3 unclear (need prod, agents have no access).**

**Closed by our own PRs, but nobody marked them** — 1, 5, 9, 10, 11, 17, 18, 21, 26, 28, 31, 33,
34, 35, 42, 48 (seam), 57-b. No need to re-check them.

**The audit corrected three entries, including mine:**

- item 5 exists (I claimed it did not);
- item 41 is **alive** (I assumed it was closed) — and it duplicates item 49;
- items 7 and 56 are **the same defect**, recorded twice two weeks apart.

**Diagnoses changed by the audit:**

- **20** — the cause is not "floating harness behavior" but a deterministic allowlist in
  frontmatter: `Skill` was missing for **eleven** agents (not nine). Closed by PR #530.
- **59** — established by measurement: a race **in the check**, not in the cleanup. The cleanup is airtight
  (`mkdtemp` → `try` → `finally rm`, the child process is dead by the time of removal). The test counted
  directories across the whole system `/tmp` and saw other processes' renders: presence in 1996 of 1996 measurements,
  counter change within 2 s in 18% of cases. **The concern "prod leaves garbage behind" is withdrawn.**
- **38** — the remedy falls short: bodies with the name loophole number **24 in `apps/e2e` versus 3 in `apps/api`**,
  and `apps/e2e` is excluded from the mutation gate deliberately and permanently. About 3 of 27 closed.

**Owner decisions 2026-08-16:**

- **43 (no light theme)** → explicitly deferred; the ECC requirement "check both" is overridden
  by the project rule, see `rules/common/design-gate.md`.
- **52, 53, 55** (listed as "conscious trade-offs") → **fix**, do not close.
- **57-a** (`mcp__postgres__query` pointed at the live `crm_db`) → switched to `crm_qa`
  in `~/.claude.json`, a copy of the config alongside. Picked up on the next MCP start.

## RECONCILIATION 2026-08-16/17 — audit re-checked against `main` via the GitHub API

20 items re-checked, one by one. The morning audit turned out more accurate than the first
reconciliation suggested: of seventeen "closed", **sixteen** were confirmed. One entry is wrong — item 42.
The second discrepancy (item 28) turned out to be **my** misreading, see the correction below.

### The audit marked these closed, but they are ALIVE — of two, ONE was confirmed

> **CORRECTION 2026-08-17 (my mistake, not the audit's).** Two items stood here, 28 and 42.
> **28 is closed, the audit was right.** I declared it alive because I grepped out the line
> `wired = {f for f in all_files if f in deploy_yml_content}` in `check-prod-ddl-wiring.py`
> and took it for the implementation. It sits **inside the module docstring** describing how the guard
> worked BEFORE and why that was bad. The real implementation parses steps
> (`parse_steps`, `source_values`) and in the comment on line 238 explicitly calls
> "name mentioned, therefore wired" the naive approach it avoids.
> Verified by execution: a devops agent built a fake `deploy.yml` in which the file name
> appears three times in prose and never in the real steps — the guard returned FAIL.
>
> **I did exactly what I criticized the audit for:** I judged a mechanism by a superficial
> match instead of by what it does. The audit read the file by name, I read it by a line
> from its documentation. The rule stays the same and is now reinforced twice over:
> **a guard is verified by running it, not by reading it.**

- **42 — alive, confirmed on `origin/main`.** `apps/api/src/app.module.spec.ts` (from #532)
  looks by name like it closes the item, but its own docstring (line 33) says it
  **deliberately does not call** `Test.createTestingModule(...).compile()`: it reads the `@Module` metadata
  via `Reflect.getMetadata`. It checks the registration order of the three `APP_GUARD`s —
  useful, but the item asked for something else: build the DI container so that the class
  "everything is green, the app doesn't start" gets caught.

### The audit marked these alive, but they are CLOSED

- **15 — closed.** `@Get(':id/audit-log')` `@Roles('ADMIN')` in `transactions.controller.ts`
  plus `transaction-audit-log-read.integration.spec.ts`. Shipped with PR #456 on 03.08.
  **Remainder** (a small delta, not a feature): read access for ADMIN only, no accountant; no screen.
  `task-soft-delete-and-money-audit.md` should be trimmed to this, not launched in full.

### Confirmed alive — with evidence

- **14** — `apps/api/tsconfig.json`: `"exclude": [… "**/*.spec.ts", "**/*.test.ts"]`.
- **16** — `project_members`: the primary key is `id` only, there is no unique index on the (project, member) pair;
  two parallel inserts will both go through.
- **19** — the ban on raw access to `transactions` covers exactly three paths:
  `src/documents/**`, `src/admin/**`, `src/projects/**`. A fourth module is not banned by default.
  The configuration itself is well written (it also closes the relational bypass `with: { transactions }`) —
  the problem is that it is an allowlist where a denylist is needed.
- **39** — measured live: the vacancy page declares `hreflang` for `en`, `uk`, `x-default`;
  `sitemap.xml` additionally has `ru`, `es`, `pt`. Six addresses outside the language clusters.
- **40** — auto-merge is still `gh pr checks --watch --required`, with no check that both
  required contexts appeared at all.
- **41 + 49** — dead steps about `2026-08-07_senior_resume.sql` in `deploy.yml`:
  the copy (1037–1055) and the apply (2232–2256).
- **47** — `describeLimits` is exported (`resume-typst.service.ts:438`), zero callers.
- **60** — `mutation-gate.mjs:154` still excludes `src/**/*.module.ts`.

### Confirmed closed (no need to re-check)

**5** (RBAC is deliberately delegated to callers and this is recorded in the docstring; the remainder is a test that
every caller checks permissions, also in `task-authz-followups.md`) · **10**
(`deploy-alert.yml`) · **11** (`ci.yml:821` seeds vacancies, `:833` builds the landing —
the build runs against a non-empty set) · **17** (`vitest.config.mts` prints an explicit banner
about skipping integration specs with the command to run them) · **21** · **26** · **31** · **33**
(`not.toBeNull()` + a written explanation of why the previous form could not fail) ·
**34** · **35**.

### Rule derived from this reconciliation

**Before dispatching on a backlog item — check against `main`, don't trust the entry.**
An entry goes stale silently, and today this twice nearly cost an agent launched to fix
the already fixed. The existence of a file with a suitable name is not proof — read what the
file does.

---

**A note on the file itself:** `.claude/tasks/*.md` is in `.gitignore` — this list is not versioned
anywhere and lives only on the owner's machine. 59 findings rest on a single disk.

---

## Money / finance

1. ~~**The DROP payment form shows an empty list.**~~ — **CLOSED, verified 2026-08-31.**
   The filter was long ago replaced by a shared predicate that, via a type guard, narrows to senior income
   **and drop income**; there are tests for drop income. The entry is stale, there is no defect.
   Previous text: `PayoutPaymentForm.tsx` filters only
   senior income, so in a drop's payout the transaction list is always empty. Pre-existing,
   found while reviewing PR #445. Fix together with the income type (`resolveSharePercent` can already
   branch — use the same approach).
2. ~~**Self-referencing drop share records**~~ — **CLOSED, verified 2026-08-31.**
   The owner's decision was made ("bad/legacy data"), parity with the drop aggregate is established:
   a self-referencing row nets to zero in both views, there is a "red before the fix,
   green after" test. Previous text: (`sender_id = receiver_id`) count as `+amount` in the
   profile balance but net to zero in the drop summary — the two views diverge. Deliberately
   moved out of PR #443. A separate defect, needs a decision: which view is correct.
3. ~~**Dead `verifyTransaction`**~~ — **CLOSED, verified 2026-08-31.**
   The symbol is not in the repository at all — zero matches across all packages. Already removed.
   Previous text: (MED-5 from review #438) — no prod callers, delete.
4. **Check on prod the company-share amounts for drops.** The old dialog computed the share by the SENIOR's
   percent even for drop income (confirmed from the code during review #445). If drops paid
   through it, the amounts diverge.

   **The only unclosed one of the five product items (verified 2026-08-31).** Cannot be fixed by code:
   needs a look at real data, and the prod database is available only to the owner — there is no SSH to the server,
   the MCP looks at the local QA database.

   The query is ready, read-only, changes nothing:

   ```sql
   SELECT id, created_at, amount, currency,
          senior_share_percent, drop_share_percent
     FROM transactions
    WHERE type = 'DROP_INCOME'
      AND deleted_at IS NULL
    ORDER BY created_at;
   ```

   **How to read it.** The standard drop share is 5, the senior's is 26 (default values). Sign of the defect:
   in a **drop**-income row the share was computed by the senior's percent, i.e. `drop_share_percent`
   is empty or equals the senior's percent. Empty rows are legitimate for old records — a gap
   by itself does not prove an error, so look at the **amount**: does the actually
   withheld share match 5% or 26%.

   If discrepancies are found — fix the data as a separate task, via verified SQL in the deploy
   pipeline (there is no direct access to the server).

## Access rights

5. ~~`rejoinTeam` — a second entry without a scope check~~ — **CLOSED, verified 2026-08-31.**
   The check exists, is called from `rejoinTeam` and is covered by two integration specs.
   It went through four review rounds: the first version relied on negative evidence
   (absence of a disqualifying record), which was refuted and redone to positive evidence.
   Previous text: `rejoinTeam` — a second entry into `addSeniorToDropTeam` without a scope check; `actorRole`/`actorId`
   are optional (fail-open by shape); LOW tails. **The task is already written:**
   `.claude/tasks/task-authz-followups.md`.

## Hygiene

6. **Docs drift** (BA zone): `docs/business/modules/auth.md:30` and `docs/business/user-flows.md:27`
   describe the removed `GET /api/auth/logout`.
7. **`dotenv@17.4.2` prints advertising lines to stdout**, including a link to a third-party service.
   Baked into the package itself, not a compromise. Take into account when updating dependencies; check as
   part of the second audit wave (supply chain).
8. **Stale comments** in money code — cleaned up point by point in each round, worth a sweep
   across the whole code after the batch merges.

## Systemic — found 2026-08-05

25. **The `* { border-color }` reset in `globals.css` eats ALL colored borders on the landing.**
    The rule is not wrapped in a layer, and unlayered rules always beat `@layer utilities`
    regardless of order in the file. Consequence: the colored borders of the domain labels
    (`ai`/`edtech`/`ecommerce`) **were never rendered** — the design was conceived, written
    and does not work. Found while working on #492, confirmed twice: by reading the computed
    styles and by temporarily removing the rule in the live DOM.
    Probably affects not only labels: card hover highlighting and the focus outline color
    go through the same rule. Blast radius is the whole landing, so in #492 it was
    deliberately not fixed — it was worked around there via `border-dashed` (a border style that the reset
    does not affect).
    Fix as a separate task: wrap the reset in a layer or narrow it. **Be sure to
    look with your own eyes at what changes** — part of the current look may implicitly depend on
    colored borders not being visible, and the "fix" could change the page more
    than expected.

26. **Running the landing shard right after `build:prerender` gives 429 and looks like a layout defect.**
    The prerender exhausts the global request limiter, and the next run gets
    rejections: `responsive.spec.ts` fails on `vacancies[0].slug` against an empty list, which
    reads as broken markup and is not. CI works around this via `THROTTLER_LIMIT=2000`,
    locally it does not, and time goes into diagnosis (confirmed twice: the prod-rollout incident
    27–31.07 and a local run on 2026-08-05 while working on #489).
    Either set the same limit in the local run recipe, or make the 429 in this
    place distinguishable from an empty response by a message. DevOps zone.

27. **About 10 schemas have no lower bound on the amount, except the fixed one.** PR #485 introduced
    `transactionAmountError` (floor `0.000001` = one unit at scale 6 + a ban on extra digits)
    and applied it to `paidAmount`. The neighboring fields — `createSalarySchema.amount` and about
    ten more schemas in `packages/shared/src/schemas/finance.ts` — remained on
    `.positive().max(MAX_TRANSACTION_AMOUNT)` without a floor: `createSalary(amount: 1e-7)` will still
    land in the column as `0.000000`, i.e. an obligation of zero. Pre-existing,
    ADMIN only, not a regression of #485. The helper already exists, the fix is a one-liner.
    **But it can't be applied blindly** (note from the author of #485): where the amount comes from
    floating-point computations (`income * 0.5` gives `333.33333333333337`), a ban on
    > 6 digits would break a legitimate path. Need to separate: a minimum where the amount is entered
    > by hand, rounding on input where it is computed.
28. **A test comment promises more than the test does.** `salary-paid-amount.integration.spec.ts`
    — the premise test `SELECT (0.0000001::numeric(18,6))` casts a **literal**, not the column,
    so it does NOT catch a column type change, although the comment claims "so a future
    column-type change is caught". Verified empirically by the reviewer: when the column is narrowed
    the premise stays green, the regression is caught by the round-trip test. Fix the text on the next
    touch of the file (the test itself is useful — it honestly pins the Postgres rounding semantics).

29. **Inherited environment variables send the agent's API to the owner's LIVE database.**
    Incident 2026-08-05 (PR #485): an agent's `API_PORT=3000` and `DATABASE_URL=…/crm_db`
    from the environment overrode its own `.env`, and the API listened on :3000 for about two minutes
    against the live `crm_db`. It turned out fine (the agent noticed, checked and reported: no writes,
    no new columns, only 404s were served), but it turned out fine **by accident**.
    The warning "set `API_PORT`/`DATABASE_URL` EXPLICITLY inline" is in **every**
    dispatch — and still did not work. So discipline is not enough, a mechanism is needed:
    a hook that refuses to start the API/migrations from `.claude/worktrees/agent-*`
    if `DATABASE_URL` points at `crm_db` or the port is in the live pair 3000/3001.
    A nearby precedent: `pre-bash-devserver-ttl-gate.sh` already blocks bare dev servers
    in a worktree — extend it or add a neighboring one. DevOps zone.
    **Clarification on scale (verified by the reviewer 2026-08-05):** `crm_db` is the owner's LOCAL
    database, not prod (it has 0 transactions, seed state; prod lives on the VPS and is unreachable
    to agents). The cost of an error is damage to the owner's working environment, not real finances.
    The first wording of this item overstated the severity — corrected so that priority
    is not set by an exaggerated cost.

## Systemic — found 2026-08-04

20. **The skill-invocation tool is NOT always available to subagents — and what it depends on
    is unknown.** Within one session four agents in a row (the landing coder, both copy reviewers,
    the security-reviewer on its first pass) reported that the `Skill` tool is absent from their environment
    entirely, and read `SKILL.md` directly. Yet **the same security-reviewer on its second
    pass did invoke skills** and listed them by name. So this is not "subagents can't", but
    floating behavior — which is worse: the rule is sometimes followed and sometimes not, and this can be noticed
    only by the agent's voluntary admission in its report.
    This is exactly the drift described below in `skills-invocation.md` ("a skill may
    exist but not be invoked"), only in a broader form: there individual links broke, here
    the whole channel does not work. The rule "trigger applies → the agent MUST invoke
    the skill" is currently unexecutable for any subagent, which means it is formally violated by all.
    Find out why `Skill` is not passed through into the subagent environment; if this is
    a harness limitation and not our configuration — rewrite the rule to fit reality
    (for example "read `SKILL.md` if the tool is unavailable"), rather than leaving
    a prescription that cannot be executed.

## Systemic — found 2026-08-03

17. **A test run without a filter structurally excludes integration tests.** `vitest run` without
    `integration.spec` does not run `*.integration.spec.ts` — so a report "2019 tests green"
    speaks only of unit tests checked against stubs. Discovered by a reviewer firsthand: a mutation
    of a view definition "passed green" on the full unit suite. Rule: **the number of tests
    means nothing until it is said which suites were run.** Evaluate whether to make
    running both suites the default or to print an explicit warning about the skipped ones.
18. ~~**The `non_deleted_transactions` view filter is defined in two places** with no consistency
    test.~~ **CLOSED in #456**: the predicate was moved to one place, a check was added
    that compares the schema description with the migration text; proven by mutation.
19. **The ban on raw access to the table covers three modules**, a new module will be unbanned
    by default. Plus the database-level view permits writes — the protection is purely type-level.

## Systemic — found 2026-08-01

14. **Test files are excluded from type checking** (`apps/api/tsconfig.json`). Consequence: a spec
    constructing a service without a required dependency is NOT caught by the compiler — discovered
    in review of #455, where `teams.archive.spec.ts:159` creates a service without the audit dependency.
    The test is "green" but checks not the configuration that runs in prod. Evaluate
    including specs in type checking: how many places would need fixing and whether it's worth doing once.
15. **The money-operations log is write-only.** Across the whole API there is not a single read
    of `transaction_audit_log` — we write what cannot be viewed from the interface. The data accumulates
    and is pulled by a database query during an investigation, but a protection that can't be accessed does not
    work in practice: nobody will go write SQL for a routine reconciliation. A view is needed at least for ADMIN.
16. **A theoretical race on rejoining a team**: no unique index on the (team, member)
    pair, and the checks run outside a transaction — two ex-seniors of the SAME team
    can both insert in parallel. Grants no privileges beyond those already held, pre-existing.

## BEFORE switching the source filter to blocking mode (mandatory)

The filter is merged (#451) in observation mode — right now it blocks nothing. Three review findings
4831276136 relate precisely to the moment of the switch; close them BEFORE the mode changes.

- **A. False-success log entry.** A default route of the on-link type (gateway `0.0.0.0`)
  passes both checks and writes «доверяю шлюзу 0.0.0.0». It is not exploitable (nginx treats it
  as a single address), but it is exactly the log line the runbook tells the operator to read
  when deciding on the switch. Filter out the degenerate case.
- **B. The gate may silently become a dummy.** If the published port goes through Docker's userland
  proxy rather than kernel redirection (including IPv6 without the corresponding rules),
  all external traffic arrives from the bridge gateway address — and the filter stops telling anyone apart.
  Not a regression of this PR, but there is no such check among the switch preconditions. Add it.
- **C. The range freshness check is mandatory procedurally, but not mechanically.** Introduce a guard
  that fires only on a change that moves the mode to blocking.

## From the final review rounds (not blockers, but real gaps)

12. **The fix for the duplicated hash parameter is not covered by a test** (#438, round 8 MED-1). There are no controller
    specs in the module at all — all view specs call the service directly and never reach request
    parameter parsing. One HTTP case is needed: `?txHash=a&txHash=b` → 400.
13. **The assertion in the MED-R test is negative** (`not.toMatch`): it proves that the message is not about the hash,
    but not that execution reached the right block. A future early exit will leave the test green
    while coverage is lost. Stronger: assert the specific name of the violated constraint.

## Infrastructure — found 2026-07-31 during the merge session

9. **The merge automation cannot merge PRs that touch `.github/workflows/**`.** The token has no
   permission to modify pipeline files: `GraphQL: refusing to allow a GitHub App to create or
update workflow .github/workflows/ci.yml without workflows permission`. Two PRs (#437, #449)
   hung silently — the label is set, the merge step fails, and it looks like "CI is red".
   They had to be merged manually. Fix: either grant the permission or explicitly separate such PRs with a clear
   message so it does not look like a check failure.
   **CLOSED.** The second path was chosen. Verified on PR #498 (2026-08-07): the automation detects
   such PRs, leaves a comment in the PR with an explanation («это НЕ сбой проверок, нужен ручной
   мерж») and finishes successfully rather than silently. The `workflow` permission is intentionally not granted to auto-merge:
   it is GitHub's built-in protection against uncontrolled pipeline changes by automation, and a bypass
   for convenience would be a security downgrade. Manually merging such PRs is an ordinary `gh pr merge --squash`, without `--admin`.
10. **A deploy failure does not raise an alert.** The deploy failed 2026-07-27 21:22 and stayed red for
    **four days** — nobody found out, prod quietly ran on old code. We set up a notification about a red
    main branch (#441/#446), but not on `Deploy → failure`. Set it up.
11. **The structured-data check is enabled only when vacancies exist.** While there were
    zero, the build passed and pages went to prod without markup for search engines. This is already
    the second case of this class in the same file (see the comment `prerender.mjs:481-484`).
    A CI build run against a non-empty set of vacancies is needed, otherwise the class will reproduce a third time.

12. **ESLint does not run in `packages/shared` and `apps/e2e` — neither locally nor in CI.**
    Verified 2026-08-07: both packages have neither `eslint.config.*` nor a `lint` script in
    `package.json`, so the shared run simply skips them. `apps/api`, `apps/web`,
    `apps/landing` are configured (`eslint src` / `eslint app`).
    Cost: `packages/shared` is the single source of Zod schemas and shared utilities, i.e. the contract
    between front and back is **not linted at all**; `apps/e2e` holds all the Playwright specs, where our
    recurring defects live (selector strict mode, a forgotten `await`). Found in passing
    by the code-reviewer on PR #493. DevOps zone: add configs and include them in the shared run, then
    clear the accumulated backlog in a separate PR, so as not to mix enabling the gate with a mass fix.

13. **Parallel reviewers write to a shared working directory and corrupt each other's measurements.**
    2026-08-07, PR #493: the security reviewer discovered that foreign changes appeared in its directory
    mid-check (an injected minimum width in a component + a stray
    test file) — the trace of a code-reviewer working in parallel that mutated the same code.
    At start the directory was clean. The reviewer noticed and re-ran the measurements on a byte-for-byte verified
    tree, but might not have noticed: then one agent's mutation would have ended up in another's conclusions
    as a property of the code. In the same PR something similar already cost two extra cycles — the number «858 px» went
    into the report as a measurement of a live component, being the result of the author's own injection.
    Fix with mechanics, not discipline: each reviewer gets its own directory, the name derived from
    its identifier. Check where the shared path `scratchpad/rev<PR>` comes from —
    probably from a template in the prompt or from a skill.

14. **The prod-migration wiring guard is satisfied by a comment.** `check-prod-ddl-wiring.py:103`:
    `wired = {f for f in all_files if f in deploy_yml_content}` — a substring search over the whole
    content of `deploy.yml`. It proves that the file name is mentioned somewhere, not that the migration
    is copied to the server and applied. A comment or a step name containing that name is enough.
    Found 2026-08-07 by the DevOps agent in passing on PR #498: it noted that the guard turns green
    "because my comments and step names themselves contain the needed string".
    Cost: the guard was introduced after a real incident (the code asked for columns that did not exist
    on prod) — i.e. protection against a repeat of that incident is currently formal.
    Fix: check that the name occurs both in the copy step and in the apply step,
    not just somewhere in the file. Write the guard's own check so that it goes red on a
    comment forgery — otherwise we reproduce the same class one level up.

15. **The shared profile-card shell: three responsive defects unrelated to any specific feature.**
    Found by the designer 2026-08-07 while auditing PR #497, reproduced on other tabs too, i.e.
    this is the behavior of `UserProfileShell.tsx`, not a resume regression: (a) the profile header collides
    at 768; (b) there is no content width limit at 1440/1920 — lines stretch across the whole
    ultra-wide width; (c) the tab strip scrolls without a visual hint that there are more tabs to the right.
    A separate task for the designer: fixed in one place and immediately for all tabs.

16. **The turbo cache returns a green check that did not run — and someone else's.** 2026-08-08, PR #493:
    the code-reviewer ran `pnpm typecheck`, got `FULL TURBO` and saw in the output a log **from another
    working directory** (`agent-a88aab8f5…`). It did not count the result and ran `tsc --noEmit`
    directly. This is the same class as the other findings of the session, but more dangerous: the check is not merely
    toothless, it **reports success without having run**, and substitutes the result of another tree.
    With parallel agents on the same commit the cache key matches, while the tree contents do not.
    Find out why the key does not distinguish trees (probably the path/branch is not part of it),
    and either separate the keys or disable the cache for agent runs. Until fixed: do not treat a
    `FULL TURBO` result in an agent report as proof — require a direct run.

17. **`@crm/e2e` has no type-check script, and the spec contains two real errors.**
    2026-08-08: `pnpm --filter @crm/e2e exec tsc --noEmit` gives 2 errors in
    `tests/senior-payout-no-dup.spec.ts`; no gate runs this. The same package as in
    item 26 (no ESLint) — close in one task together with it.

18. **TRIAGED 2026-08-08: there is NO hole in permissions, but the hiding rule is not enforced by anything.**
    The initial suspicion — "5 red access tests in `rbac-senior-junior.spec.ts` on `main`" —
    **was not confirmed**: the run went without `VITE_API_URL`, which CI sets, so the app
    went through a relative path, while the stubs in the specs listened on an absolute one and did not intercept.
    With correct setup: 1 failed, 1 skipped, 10 passed.
    What turned out to be real:
    - `:203` dies on a **positive** assertion (strict mode, 2 matches — the viewer
      is itself "Senior Dev"), so its "junior is hidden" checks are never executed;
    - `:249` **was never executed**: both preconditions are under `if (isVisible)`, and the needed
      card is not rendered in this flow. It now honestly reports a skip.
    - **MAIN POINT, needs a task:** the hiding lives on the server (`ProjectsService.mapProject`:
      `viewerRole === 'SENIOR' && isJuniorMember` → empty `displayName`, `userId: '[redacted]'`)
      and is **not covered by any test in `apps/api`**. The only nominal guard is an E2E with
      stubbed responses, which physically cannot check this: the fixture hard-codes the junior's name
      in `members`, i.e. exactly the response the server refuses to give.
      A server unit test for `mapProject` is needed.
      The fourth recurrence of the pattern [[feedback_mocked_e2e_guards]].
      Related: 20 other E2E failures, each confirmed by running the same spec from `origin/main`.

19. **`projects.spec.ts`: the selectors never matched anything — a test defect, not a product one.**
    Triaged 2026-08-08. The create dialog **renders** all six metadata fields
    (`index.tsx:775` — a loop over the key list), there is no product defect. But the fields render without
    a `name` attribute, while the spec looks them up via `getByPlaceholder(/стек технологий/i)` and
    `input[name*="tech"]` — these selectors never matched. This was hidden by two conditions:
    `if (isVisible)` on the fill and `if (body.techStack)` on the check. The fix requires tying the label to the field
    or adding `data-testid` — that is a product edit, which is why it is raised here.

20. **A check that cannot fail in the payouts spec.**
    `apps/e2e/tests/drop-confirm-payout-rbac.spec.ts:155` —
    `expect(confirmed?.recipientId ?? MAKSYM_ID).toBe(MAKSYM_ID)`. When `confirmed` is `null`
    (the comment one line above itself allows this), the expression reduces to comparing a value with
    itself. Found by the code-reviewer on #500. The degradation versus `main` is not in behavior but in
    **detectability**: before, there was an `if` there that a new lint rule would have seen, now the skip
    is invisible. The honest form is `expect(confirmed).not.toBeNull()` followed by an unconditional check.
    In the same PR the correct form was applied in four other places, i.e. this is
    an inconsistency, not a position.

21. **`scripts/check-package-gates.mjs` is not run anywhere** (#500, MED-5). Until it is wired
    into CI in a separate PR in the DevOps zone, the claim "a new package cannot drift away from the gates" is false.
    Related (MED-1, same place): the detector's self-check does not cover its own parsing of
    `pnpm-workspace.yaml` — globs are passed explicitly, so a partially rotted parser yields
    "all good" and exit code 0. The fix is one line (drop the second argument in the self-check).

22. **The shape of an empty test: the expected value is derived from the actual one.** Three cases on 2026-08-07/08,
    and an ordinary lint rule does NOT catch it — the syntax is flawless:
    - `expect(observedPeak).toBeLessThanOrEqual(MAX_CONCURRENT_EXTRACTIONS)` (#497) — the assert
      references the very constant it is supposed to pin, so replacing two with
      a million does not fail it. Candidate for a rule: **compare against a literal, not against the constant
      under test**;
    - `expect([...ids]).toEqual(ids.size === 0 ? [] : [id])` (#500 MED-3) — the expected value is derived
      from the actual one, the empty branch is self-fulfilling;
    - `expect(confirmed?.recipientId ?? MAKSYM_ID).toBe(MAKSYM_ID)` (#500 MED-2) — with `null`
      it reduces to comparing a value with itself; worse, this form is **invisible** to
      `no-conditional-expect`, whereas the original `if` was visible.
      The mutation gate kills all three instantly; lint kills none. An argument in favor of the fact that the
      gate from `task-mutation-gate.md` does not duplicate #500, but closes what that one cannot.

23. **An agent launched without isolation works in the orchestrator's directory.** 2026-08-08: rounds 2–3
    on #497 were dispatched without `isolation=worktree`, so the coder wrote into the session's working directory
    (`strange-cerf-c5eb99`) and ended up switching it to `feature/resume-base`. The write-zone hook
    noticed and warned; the agent behaved correctly — it moved the branch rather than bypassing the hook.
    No damage (the main checkout stayed clean), but this is the third case in the session of agents crossing
    over directories. A dispatcher error, not an agent one: **launch any writing agent only with
    `isolation=worktree`**. Worth raising to the level of mechanics — a refusal at the start of a writing agent
    without isolation is better than discipline.

24. **The "test without assertions" rule is bypassed by a function name — measured, 24 places rely on it.**
    2026-08-08, #500: `assertFunctionPatterns` (`^assert`, `^verify`, `^expect`) matches
    **only the name** of the called helper, the body is not analyzed. The reviewer proved it with two mutations:
    rename `assertNavigatedTo` → `navigateTo` without touching the body — 4 errors; keep the name
    and **gut the body** — 0 errors, exit code 0. The scale was measured by removing the option: the loophole
    is relied on by **20 test bodies in `apps/e2e` + 4 in `apps/api`** (in web/landing/shared — 0).
    This is not a defect of #500 — both plugins work this way. But it means: "assertions inside a helper" is a
    property checked by a human, not by the linter. **Closed by the mutation gate**
    (`task-mutation-gate.md`): an empty `assert*` helper will not kill a single mutant.
    Another argument that wave 2 does not duplicate wave 1b.

25. **Six sitemap addresses are not part of any language cluster.** Found by the code-reviewer
    on #502 (outside the diff). Vacancy pages advertise `hreflang` only for `en` and `uk`, whereas
    `sitemap.xml` has the same vacancies in `ru`, `es`, `pt`. Google gets the addresses from the sitemap,
    but does not see their relation to the other language versions — probably part of the second line of the
    Search Console report of 2026-08-08 ("discovered, not indexed", 15 addresses).
    The `INDEX-4` sweep from #502 **by design will not catch** this: it checks the reachability
    of what is advertised, not the completeness of the advertising. So a separate check is needed: "every sitemap
    address belongs to at least one cluster and the cluster is symmetric". Lives in `apps/landing`.

26. **Auto-merge declares "CI green" after waiting for ONE required check out of two.**
    2026-08-08, PR #503: the workflow waited for `Typecheck · Lint · Unit Tests`, called
    `gh pr merge --squash` and got `the base branch policy prohibits the merge` — because
    `E2E Tests` (the second one required in the branch protection) was still running at that moment. A PR with the label
    `merge-approved` **sat unmerged for two days**: a failed auto-merge step looks like
    yet another red check, there is no separate signal.
    The same class as the #437/#449 incident (item 9): the gate checks **more narrowly** than its name promises.
    Fix: wait for ALL contexts required by branch protection (take the list from the API, do not
    hardcode it — otherwise it drifts apart when a third one is added), or use `--auto`, so that the
    merge happens by itself when all conditions are met. And a separate loud signal on a merge refusal
    with the label in place — a silent "hanging" is more dangerous here than a red one.

27. **`deploy.yml` still has a step for a migration that will never exist.** Step `2t` from PR #498
    refers to `apps/api/drizzle/manual/2026-08-07_senior_resume.sql` from the closed #497 —
    the file will not appear, the work was rebuilt for a different model (#504, the migration is named differently).
    The step is protected by an existence check, so it just prints a notice and is skipped.
    No harm, but this is a **notice on every rollout about something that does not exist** — and a habit of
    letting notices slide past the eyes costs more than three lines of config. Remove together with the
    next edit of `deploy.yml`. Noticed by the DevOps agent on #505, outside its task — it
    rightly did not silently widen the scope.

28. **Tests do not bring up the whole application, so they do not see an injection container failure.**
    2026-08-10, #504: DevOps reported that the API crashes at startup
    (`UnknownDependenciesException` on `ResumeTypstService` — an interface used as a type in the constructor
    degenerates in the metadata into `Function`), while all of the author's unit tests and local E2E
    are green. Unit tests create services by hand and do not engage the injection container at all.
    A contradiction in the triage; **but regardless of the outcome** a gate is needed: a test that brings up
    the whole application in built form. The class "everything is green, the application does not start" is not caught
    by ordinary tests in principle.

29. **There is no light theme in the application at all — yet the rules require checking both.**
    Found by the designer 2026-08-10 on #504: `apps/web/index.html:2` hard-codes the dark theme,
    there is no theme provider in the code. That is, the requirement "run in both themes", which is in
    our design rules and which I repeated myself in every brief to the designer, **is impossible to meet
    and was met only formally all this time**. Decide: either introduce a light theme for real,
    or remove the requirement from the rules. Right now it is exactly what we have been cleaning out all day —
    a check that cannot show anything.

30. **A storage upload failure after a successful render leaves the status "in progress".**
    Found by the designer 2026-08-10 (outside the #504 diff): if `this.s3.upload()` fails after
    Typst has already built the document, the record hangs in `RUNNING` until the sweeper fires
    five minutes later, and the user is shown nothing. Five minutes of "spinning" instead of a clear
    refusal. Related to item 42: a class of failures visible only on a live stack.

31. **Transferring findings from review into the task is a channel without a gate, and it has already lost one.**
    2026-08-11, #504: when composing the "what to finish" list I (the orchestrator) **lost one
    security finding** — the glyph check bypass. I did not judge it insignificant, I just did not
    transfer it. The coder naturally did not do it; it was caught only by checking the report against the original review.
    We have gates on code, tests, guards, measurements — and none on "all review findings
    made it into the task". It rests on attentiveness, which failed in the ninth round.
    Mechanics instead of discipline: list findings with identifiers and require
    from the executor a report on each, including "did not do it because…". Then an omission is visible.

32. **Limits that nobody compared with each other.** 2026-08-11, #504: the densest
    document that our own limiters **allow** takes 8.3–14.7 s to process — against a
    10 s deadline. Two boundaries, each reasonable on its own, are contradictory together; the result is
    the user is told that their legitimate file is unreadable. Found only when the measurer was fixed.
    Similarly: the address space limit of 1 GiB against **399 GB of reservations** by an
    idle Node process — the same class, and it caused a crash on 23 KB files.
    Introduce as a separate check: every pair "what is allowed" / "in what time or what
    volume it must fit" should have a test comparing them **with each other**, not with a constant.

33. **`describeLimits()` is a dead export whose docstring promises a nonexistent test.**
    Found on #511 (2026-08-11). The function has **zero callers in the whole repository**, yet
    its docstring promises "so that a test can check the limits without the platform check" —
    there is no such test. The limit itself is live: `RENDER_ADDRESS_SPACE_KB` goes into the arguments directly
    (`resume-typst.service.ts:411`).
    **The task is not "write a test", but first to decide whether the accessor is needed.** Writing a test just to call
    a function nobody calls means pinning dead code as live — the same class as
    the rest of this list.

34. **A limiter that receives a corrupted value must become stricter, not weaker.**
    Surfaced on #511. The `cpuSeconds` seam with `NaN`, `Infinity`, `-1` and **`1e21`** left the process
    **with no limit at all**: the install command failed on a non-numeric string (`String(1e21)` gives
    `"1e+21"`), the error was swallowed by a redirect. All these values are a valid `number`, i.e.
    **type checking does not protect against the class**: the value is correct at the language boundary and incorrect
    at the process boundary.
    The asymmetry is telling: the neighboring `timeoutMs` with the same garbage **closes** (the timer
    reduces it to 1 ms), the new seam **opened**. One class of input, opposite consequences.
    Fixed with a clamp on #511. **Rule for the future:** at every place where our value goes
    into an external limiter, check the behavior on corrupted input — and require that it
    goes toward strictness. Candidate for a separate cross-cutting audit: where else we pass numbers
    into a shell or into system limits.

35. **Deploy forever announces a file that will never exist.** `deploy.yml` carries two sentinel steps
    for `apps/api/drizzle/manual/2026-08-07_senior_resume.sql` — «PR #497 ещё не смержен».
    **#497 is closed, not merged**, the file will never exist: the `senior_resumes` table is created by
    `2026-08-10_senior_resume_template.sql` from #504, and it is already in prod (verified from the output of
    deploy 31537077708 — all the layout columns are in place).
    No harm right now, the harm is deferred: every deploy prints two `::notice` about a skip,
    and this is exactly the noise that trains people not to read notices. And the next real DDL
    skip will look exactly the same.
    Remove both steps (copy and apply). DevOps zone, a ten-line edit.

36. **`db:push` synchronizes the database with the files, not with what is merged.** Incident 2026-08-12.
    Local `main` lagged origin by 40 commits — i.e. it was a snapshot from before #493 and #504.
    Running `pnpm --filter @crm/api db:push` against `crm_db` faithfully brought the database to that schema:
    it created csp/telemetry, **dropped `senior_resumes`** and created not a single job sourcing table.
    It also offered to wipe the backup `_settle_phantom_backup_20260715` (28 money rows) —
    it was saved only by the fact that a dump had been taken a minute earlier.
    **Two separate lessons, not one.**
    (a) There was **no warning** about `senior_resumes`: drizzle shows "data-loss" only for
    tables with rows. An empty table vanishes silently. That is, the loudness of the warning depends
    on the contents, not on whether we lose structure — on a developer's empty database this
    sentinel never fires.
    (b) The danger is created by the **distance between the checkout and origin**, and at launch time nobody
    sees it. Next to it sits a second mine of the same kind: a worktree has its own `.env`, and the same command
    goes to someone else's temporary database.
    **What to do:** a wrapper over `db:push` that, before running, (1) counts
    `git rev-list --count HEAD..origin/main` and refuses to work at a nonzero value without
    explicit confirmation, (2) prints the database name from the resolved `DATABASE_URL` and requires
    confirming exactly that, (3) lists the tables that will disappear, **including empty ones**.
    Not with a reminder in the rules — a reminder was already there and did not help: the command was issued by the one who
    had himself discovered the checkout's lag an hour earlier.

37. **The budget unit counts a provider call, not a request to a third-party service.** From the security review of
    #515 (LOW, deliberately moved here). Today DOU has one `fetch` per `collect()`, so
    "budget unit == one `collectSource` call" and "== one outbound request" coincide. A provider
    from slice 2 with paginated results will spend N requests per one charged unit — and JSearch's monthly
    200 will run out N times faster than the counter shows. Pin it down with a contract on
    `JobSourceProvider`: either the provider itself reports how many requests it used, or pagination
    within a single unit is forbidden for it. Decide **before** connecting paid sources.

38. **The `/collect` throttler counts per address, not per user** (`app.module.ts:116-119`).
    From the same review (LOW). Acceptable, because the real protection is the counter in the DB and the throttler
    is a second line. Recorded so that when expensive sources appear this is reconsidered deliberately,
    not discovered.

39. **A race at the budget window boundary.** The loser gets "budget exhausted" although the window has just
    reset. The direction is conservative (skip a run, rather than spend extra), it
    heals itself with the next run. Recorded as known behavior, not as a defect.

40. **`loadSuggestionRows` is the only service query without its own `seniorId`/`status`.**
    From the security review of #515 (LOW). It trusts the caller's visibility scope: today the ids come from
    an already filtered set, and that is correct, but the protection rests on call discipline, not on
    the query itself. Also there, a minor race: a suggestion answered between two passes will flash
    once in the queue. Both are about fragility, not about a current hole.

41. **Truncating an overlong skill collapses different keys into one canonical one.** A consequence of the
    HIGH-1 fix on #515. The direction is strict (no extra match is created, what is created is an extra
    match between two garbage strings), it concerns only skills longer than 100 characters
    in canonical form — i.e. knowingly corrupted data. Recorded so that it is
    known behavior, not a discovery.

42. **A dependency prints a line addressed to agents into the build output.** Noticed by the code-reviewer
    on #517: in the `pnpm test` output there appears "tip: auth for agents [www.vestauth.com]". The source is
    upstream `dotenv@17.4.x`, unrelated to our code. The reviewer acted correctly:
    **did not execute, checked the source, flagged it for visibility.**
    In itself this is probably an advertisement, not an attack. But the form is dangerous: text in tool output
    phrased as an instruction to an agent is exactly the channel through which prompt injection
    gets in, and our agents read this output constantly. The value of the entry is not in the specific line,
    but in the fact that the channel exists and we do not control it.
    **What to do:** check which exact `dotenv` version prints this and for what purpose;
    decide whether to silence it (`DOTENV_CONFIG_QUIET` or similar) and whether it is time to pin the version. Plus
    a reminder in the instruction-source rule: build and test output is data, not commands.

43. **`mcp__postgres__query` is hard-coded to the live `crm_db`.** Noticed by manual-qa 2026-08-12:
    the agent was about to work on its own scratch database, discovered that the MCP tool goes to the owner's live
    database regardless of the passed environment, and **itself** stopped using it,
    switching to direct `psql`. The behavior is correct — but it rests on the agent's attentiveness,
    not on mechanics.
    This is the same class as the whole list: a tool that looks neutral silently
    points at the most dangerous place. The hook `pre:bash:live-db-guard` covers `Bash`, but MCP
    bypasses it.
    **What to do:** either reconfigure the MCP to a safe database by default, or remove it
    from agent profiles, leaving `psql` with an explicit `DATABASE_URL`. The decision is DevOps's.

44. **A test that passes only until a certain date.** Incident 2026-08-13: `main` went red on its own
    at midnight UTC. `admin-income-drop-backfill.integration.spec.ts` seeded rows with
    `created_at = now()` and checked them against the **deliberate** cutoff `'2026-08-13 00:00:00+00'`
    in the prod SQL. Before midnight `now()` was less than the cutoff, after — greater; the candidates became zero,
    ten assertions collapsed. The prod logic was correct, only the instrument was broken.
    **Class:** the test depended on **when** it is run, not on what it checks.
    A mirror image of everything else in this file: usually we catch a check that cannot
    fail — and here is a check that cannot pass from a certain date on.
    Fixed with an explicit time in the seeding. **Worth searching for this class with a cross-cutting pass:** any
    hard-coded future date, any `now()` against a fixed boundary, any snapshot with
    a date inside. Candidate for a separate audit; on #517 such a cutoff was added deliberately and
    correctly, but the test was not adapted to it.

45. **A fixture that coincides with the fallback value disarms the test.** Found by the security review
    on #521 (round 4). Three tests proved that the historical rate request does not poison the shared
    cache. Two of them seeded the cache with `41.5` — exactly what lies in the `HARDCODED_FALLBACK`
    of the NBU service. With cache writes **fully disabled** the fallback would have returned the same 41.50,
    and both tests would have stayed green. The write's work is proven only by the third, contrasting one,
    which takes `43.0`.
    **Class:** the fixture value coincided with the default / fallback value, and the check
    stopped distinguishing "worked" from "did not work". The test is written correctly in intent and
    useless in execution — and it was written **to prove the fix**.
    **Rule:** a fixture must never coincide with the default, the stub constant or
    the fallback value of what you are checking. If it coincided — the test passes by coincidence.
    Candidate for a cross-cutting pass: search tests for values equal to `HARDCODED_FALLBACK`,
    `DEFAULT_*` constants and zeros that are simultaneously "empty" and "did not work".

46. **A flaky sandbox cleanup test — possibly the cleanup itself is flaky.** 2026-08-13,
    PR #527 (changed only `nginx/**` and one shell script) went red on the unit test
    `leaves no scratch directory behind, on success or on failure` in `apps/api`.
    Evidence of irrelevance: the last three runs on `main` are green, and the PR diff physically
    cannot affect the resume render sandbox. A restart unblocked it.
    **Why this is not "just a flake".** The test asserts that after the work **no temporary
    directory remains**. It fails every other time — so the race is either in the check (it looks earlier than
    the cleanup finished), or **in the cleanup itself**. The latter means that prod periodically
    leaves garbage in the file system, and this can only be noticed by the disk filling up.
    The difference between these two explanations is the difference between cosmetics and a leak on prod,
    and it has not been established.
    **What to do:** run the test in a loop (50-100 times) and catch the state; if the race is in
    the cleanup — fix the cleanup, not the wait in the test. The ban on "pre-existing flake without
    proof" is observed here: there is proof of irrelevance, there is no explanation.

47. **The mutation gate does not reach code covered only by integration tests.** Found
    while fixing items 52/53/55 (PR #532), 2026-08-16. The Stryker runner does not set the flag
    by which `apps/api/vitest.config.mts` includes `*.integration.spec.ts` in discovery
    (`isIntegrationRun(argv)` is false). So mutants on lines whose behavior is checked
    **only** by an integration spec cannot be killed — they either survive or are listed
    as "no coverage".
    **Why this matters specifically for us:** money paths (budgets, obligations, repayment,
    accrual top-ups) are covered mostly by integration specs on a real Postgres — i.e.
    precisely the most expensive class of code lies outside the gate we consider the main proof.
    The author of #532 worked around this manually: applied and rolled back two mutations against a real DB, both gave
    red. A manual workaround does not scale and leaves no trace in CI.
    Zone `scripts/devops/**`. Evaluate whether a separate gate run with the integration
    flag and its own database is possible, and what it costs in time.
    **A second blind spot of the same gate, found in the same place:** a global exclusion of `*.module.ts`
    for all packages. So wiring — the order of global guards, the provider set,
    interceptor hookup — is not covered by mutations at all. And that is exactly the layer where
    swapping two lines silently changes the behavior of the whole system (see MED-2 on #532: the order
    `JwtAuthGuard → OnboardingGuard → UserAwareThrottlerGuard` was correct and pinned by nothing).
    Worked around by a manual mutation, which does not scale and leaves no trace in CI.

48. **`chargeBudget` names the wrong cause: budget exhaustion instead of contention.** Found by
    code-review on #532 (2026-08-16), `apps/api/src/job-sourcing/job-sourcing.service.ts:867-871`.
    When the CAS is lost `CHARGE_BUDGET_MAX_ATTEMPTS` times in a row, the tail branch unconditionally throws
    `JobSourceBudgetExhaustedError` — without re-reading whether the budget is really exhausted. The outcome is
    conservative (we will not spend extra), so it costs no money; but the operator is told
    **the wrong cause**: they see "budget ran out" where in fact there was contention for the
    row, and the limit may be far from exhausted.
    The cost of the error is not money but diagnostics: the investigation will go the wrong way. The fix is cheap
    (re-read the state before throwing and name the cause honestly), but it requires its own test,
    otherwise it is exactly the check that cannot go red. The trade-off is documented in the code,
    but not covered by a test.

49. **A nonexistent address answers `200 OK` and statically serves the home page.**
    Google Search Console email 2026-08-16 22:14: a new reason for non-indexing —
    "blocked by noindex tag". The mechanism was established and verified in a browser with JS execution:
    statically the address serves the home page (its title, its canonical, `index, follow`), after
    hydration it becomes "Page not found" with `noindex, nofollow` and canonical to `/404/`.
    One address tells the search engine three different things in a row; Googlebot executes scripts
    and sees the last one.
    **The error is not in the tag** — `noindex` is set correctly. The error is that before it
    the page manages to present itself as the home page with code 200: it is both a soft 404 and a duplicate of the home page.
    The task is written: `.claude/tasks/task-soft-404-and-noindex.md`. Adjacent to item 39 —
    the same surface.
    **A lesson about the tool:** the first pass of the investigation found not a single `noindex`
    and almost closed the question as nonexistent, because `curl` does not execute scripts.

50. **`pre-bash-live-db-guard` fires on READING, not on launching.** Found 2026-08-17:
    the command `git show <ref>:pnpm-lock.yaml | grep -oE '/vite/[0-9.]+'` — a pure read from a
    git object, not a single process — was blocked by the hook with text about launching a dev server
    against the live database. Cause: matching is done on the substring `vite` in the command text,
    without parsing whether anything is launched.
    **Why this matters, not cosmetics.** The hook protects against a real incident (PR #485, the API listened to
    the owner's live database for two minutes) and is written correctly in intent. But a guard that
    refuses a harmless `grep` trains people to bypass it: its bypass is cheap and
    documented right in the refusal text (`DATABASE_URL=` empty), so the reflex
    "append the prefix and repeat" develops in a couple of firings — and then fires
    on a real launch too. A false positive costs not a lost minute but trust
    in the guard.
    Narrow the matching to an actual launch (`pnpm dev`, `nest start`, `vite` as
    a command, `node dist/main`), not to the appearance of the word in any position. DevOps zone.

51. **The runbook describes a verification loop that does not start as written.** Found
    by the devops reviewer on #539 (2026-08-17). `scripts/devops/locale-routing-runbook.md`
    describes a "quick config-only verification loop" via an nginx container — per the instructions
    it does not start: the brotli module and the `Host` header in the verification requests are missing.
    The reviewer finished the environment themselves and did the job, but the next one will have to figure it out again.
    **The same class as everything in this file:** an instruction that does not work as written
    is a check that cannot pass. Until it was executed, it looked workable.
    Related, in the same place: `scripts/devops/check-locale-routing.sh` contains a stale line
    expecting `200` where after #539 the honest answer is `404`. The script is wired neither into CI nor into
    the rollout — decide at the same time whether it is alive or dead weight. DevOps zone, a separate small PR.

52. **An old crutch for the same frame bug, and its comment has become wrong.** Found by
    code-review on #540 (2026-08-17). `apps/web/app/styles/globals.css:197-212` —
    `.nav-active-accent[data-status='active'] { border-left-color: var(--primary) !important; }`
    from PR #287: a point workaround for exactly the defect that #540 closed at the root.
    No regression (the semantics of `!important` in layers were verified by the reviewer), but the accompanying
    comment claims that "unlayered CSS beats any `@layer`" — after #540 this is
    no longer true for this file.
    **Why it is worth removing rather than leaving as is:** a crutch with `!important` and an explanation
    that no longer matches the code is a trap for the next person. They will read the
    explanation, believe it and build the next decision on it. The author's self-check
    understandably does not catch this: there is nothing to compare visually, the behavior has not changed.
    Check whether the crutch is needed at all after #540, and either remove it together with the comment,
    or rewrite the comment to match the facts.

53. **The invoice fixture in `crm_qa` references a file that is not in storage.** Noticed
    by the designer on #540 in passing: the invoice PDF preview returns a `NoSuchKey` error from MinIO —
    the document object exists in the test database, the file behind it does not. Unrelated to the change,
    they did not touch it (rightly so).
    Meaning: any test or manual pass going this way runs into a storage error,
    not into the behavior under test. Such a fixture masks real breakages — a failure
    looks the same both when the code is broken and when the file is simply absent.

54. **A new form of bypassing the prod-DDL guard: a dead assignment is counted as an application.**
    Found by code-review on #542 (2026-08-17). `check-prod-ddl-wiring.py` parses steps
    and looks for a real `psql` call — but an assignment of a variable with the file name **in the same step**
    where `psql` is called for ANOTHER file is counted as "this one is applied".
    That is, the guard fixed against a comment bypass is bypassed by dead code.
    The docstring mentions this as a known limitation — **but there is no test for it**, and a
    limitation without a test lives exactly until the first person who does not read it.
    A separate task: narrow the parsing to the line where the file name actually goes into `psql`,
    and write a check that goes red on this form of forgery. DevOps zone.
    Related to item 28 (the same file, the previous form of bypass — closed in #499/#520).

55. **Two junior masking surfaces are built oppositely — and this is deliberate.**
    Recorded by security-review on #541 (2026-08-17), so that nobody later "brings them to
    uniformity" by reverting one of the sides.
    - **The project surface** (`projects.service.ts:613-615`): member rows are
      KEPT, fields are blanked. The code states directly that the cardinality of the set
      is preserved deliberately — the senior sees that a member exists but does not see who.
    - **The «Команда» tab** (`getTeamMembersForUser`): rows are REMOVED entirely, the count is lost.
      Both forms correspond to the owner's decision of 2026-08-17 "hide everywhere". But they are different,
      and the difference is meaningful: on a project what matters is that the roster is not empty; on the tab — that the person
      is not in the list at all. Touching one "for consistency" means breaking the design of the other.

56. **A senior with a roster of only juniors sees «Не состоит в команде».** A consequence
    of the strict form of masking (#541). Factually wrong: the team exists, the senior simply
    does not see it. Not security — the reviewer checked that there are no counters or aggregates on this endpoint,
    the only consumer is `TeamTab.tsx`, only sorting and rendering.
    But the empty state **lies to the user about a fact**, rather than just hiding data.
    Text is needed that is honest for both cases: "no team" and "roster hidden". Designer's zone,
    tier 3.

## Audit — second wave (not started)

R2 file storage and temporary links · XSS surface of `apps/web` (contracts, markdown) ·
infrastructure and dependency chain. Run via the `codebase-audit` skill (read-only fan-out).

## Separate tasks already written

- `.claude/tasks/task-soft-delete-and-money-audit.md` — soft delete + money operations journal
  (owner's requirements: visible only to admin and accountant, hidden by default in the general list).
- `.claude/tasks/task-authz-followups.md` — see item 5.

## Review lessons — paid-transaction edit cascade (2026-08-21/22)

70. **Backfilling a column is dangerous not because it writes a wrong value, but because it
    erases the "value unknown" marker.** #600, round 3 (HIGH-2). An empty amount snapshot was
    the only way to tell "filled by migration" from "actually signed"; the backfill wiped out
    both the log warning and the distinguishability itself — closing the window for correction
    with the very mechanism whose urgency it justified itself by. Emptiness is information.
    **Second-order consequence:** if you narrow the backfill source with a condition but do not
    narrow its check in the same patch, `RAISE EXCEPTION` will crash the migration step **in prod**.
    Narrowing the source and narrowing the check must be one patch.

71. **"0 surviving mutants" says nothing about the uncovered ones.** `check-mutation-tally.mjs:101-110`
    goes red only on `Survived > 0`; `NoCoverage` passes silently. Claimed coverage must be
    checked against the facts, not against the gate's verdict. Separately: Stryker has **no
    mutator for operators inside template strings**, so SQL fragments are structurally unprovable
    by this gate — only integration tests catch them, and `Integration Tests (Postgres)` is **not
    a required check** on `main` (see item 72).

72. **The only class of tests able to catch a regression in a SQL fragment lives in a
    non-required check.** `Integration Tests (Postgres)` is not among the required checks —
    a red integration run does not block merge. The owner's decision on making it
    required is open.

73. **`resolveBase()` in the mutation gate picks the wrong base after `origin/main` is merged
    into a branch.** The merge-commit heuristic picks the developer's own pre-merge tip,
    and the entire task diff silently drops out of the check. The gate stays green.

74. **Successful delivery of a message to an agent does not mean the agent was working.**
    Recurrence: two agents resumed via `SendMessage` were dead yet reported "in progress";
    the owner caught it. The third time — the agent on #600 ended with the phrase "I'll wait for the notification",
    but the work had been done and pushed. Takeaway in both directions: **verify by fact** —
    new commits in the branch, a published review, `ListAgents`. Write context into the task file,
    don't keep it in a live agent: the file survives death.

75. **A mock that computes the expected result the same way the code does confirms
    any implementation.** What to check is not a match but a challenge: the test must go red on
    the previous version of the code. Demand proof (`git stash` + run), not assertions.

76. **Choosing "to the start or to the end" for a whole group of rows is a sign the group should not exist.**
    #601: "undated first" reproduced the same regression at the opposite edge
    once the undated rows outnumbered the page size. The right solution is not an edge but a fallback
    sort key (`txDate ?? createdAt`) that puts the row on equal footing with the rest.

77. **A date-without-time is rendered in the operator's local time zone but sorted in UTC.** Found
    by the reviewer on #601 (MED, not a blocker). `dayOf()` in `finance/sort.ts` truncates to **UTC** days,
    while the "Date" column goes through `fmtDate()` (`finance/constants.ts:243`) — `toLocaleDateString`
    **without** `timeZone: 'UTC'`, i.e. in the browser's zone. The rationale for the round 2 fix
    was "truncate to the day the column shows" — when the zones diverge, this rationale
    stops being true.
    **No practical harm to the owner right now:** Kyiv is east of UTC, and UTC midnight for
    a date-without-time renders as the same day. **The real hidden defect is wider than sorting** —
    for any operator west of UTC, `fmtDate` will show a date-without-time as the **previous day**.
    The fix belongs in `fmtDate`, not `dayOf`: dates-without-time need an explicit `timeZone: 'UTC'`.
    **Not provable by tests:** the project environment is pinned to `TZ=UTC` (see the comment in
    `SettleSeniorPayoutDialog.tsx:462`), so the divergence physically cannot be reproduced
    in unit, E2E, or the mutation gate.

78. **A signed payout act and its own QR verification name different amounts in different currencies.**
    Found by security review on #600 (HIGH-3). The act has the aggregate over linked incomes (1000 USD),
    the public verification response has the payable in USDT (740 USDT). Not a hypothesis: reproducible by a test
    from the PR itself on one fixture. The defect is **pre-existing**, aggregated invoices in prod
    since 2026-06-02 (#80). Fixed in round 4 of the same PR: a single amount-resolution helper shared by
    signing and verification.

79. **The payout invoice amount is assembled blindly from rows in different currencies.** Surfaced
    while analysing item 78. `signInvoice` sums linked incomes via `parseFloat` **without regard
    to currency** and takes the currency of the first row — while the `SELECT` has **no `ORDER BY`**, so
    "first" is nondeterministic. As long as all incomes of one payout share a currency, it does not fire;
    as soon as they do not — the signed document contains a meaningless number, and which one depends on
    the planner.

80. **`GET /api/invoices/verify/:id` is public and has no throttle of its own.** Noted while analysing
    MED-D on #600. While the load on the request is small, it is not a problem; any logic that adds
    DB queries to it must be tightly bounded by the row set.

81. **A flake in the unit run triggers on a FAST machine, not a slow one.**
    `resume-render-responsiveness.spec.ts:183` — `Math.max(...samples)`. `samples` is filled by
    a probe loop for the whole duration of the render: the faster the runner, the more probes get through, the
    likelier it is to hit the call-argument limit and get a stack overflow. That is,
    the usual intuition "flake = slow runner" points the opposite way here.
    **CLOSED** (#604, merged). A fold instead of a spread + a regression with 200,000 elements.
    The remaining five spread sites were checked by name and deliberately left: none
    shares the shape of the defect (accumulating samples for the whole duration of an operation) —
    monthly charts, incomes of a single group in a modal, a fixed array of length 8.

82. **The mutation gate does not see `*.integration.spec.ts` — and that makes whole endpoints invisible
    to it.** Confirmed twice in one day. On #603 an entire new endpoint showed "0 killed" in
    the log for exactly this reason: there was coverage, but integration coverage, and Stryker does not count it.
    Cured by a unit duplicate (rule `mutation-gate-integration-specs.md`), but the problem can be noticed only by
    reading the log — **the gate's verdict stays green**, because it goes red only on `Survived`.
    Combined with item 71 and item 72 it gives one conclusion: on SQL paths a green mutation gate means nothing,
    and the only check that means anything there is non-required.

83. **A payout act with mixed currencies prints a meaningless amount — even though the correct one
    is already computed.** Found while analysing HIGH-4 on #600. A batch with rows in different
    currencies is converted to USDT at NBU rates, and the result sits in `transactions.amount`.
    But the PDF gets a **blind sum of raw numbers** (`autoCreateForPayout`, a `parseFloat` reduce
    ignoring currency) with the currency of an arbitrary row. So a person ends up holding a legal document
    with a number that means nothing, although the system already knows a meaningful one.
    **Do not fix in #600:** what the act should show — the blind sum (as now), the converted
    total, or a breakdown by currency — is a product and legal decision, not a coder's. It needs the owner's
    verdict, possibly with a lawyer. Until then #600 must only **not make it worse**: the snapshot stores exactly
    what was printed, however defective it is.

84. **Mixed currencies in a batch are an intentional configuration, not an edge case.** Important to remember on any
    change to this path: the previous hard guard was removed **as a bug** —
    `transactions.service.ts:4208-4214`, "the previous hard guard blocked legitimate mixed-currency
    batches". Any decision to "just forbid mixed currencies" would be a reintroduction of the same
    bug.

85. **A rule duplicated in three places, with a comment "keep the copies in sync".**
    The payout invoice amount was computed independently in `autoCreateForPayout`, `signInvoice` and
    `verifyInvoice`; the third copy's comment directly asks the reader to sync it by hand
    ("signInvoice PAYOUT branch mirrors this exactly"). A request to the reader is not a mechanism.
    Eliminated in round 5 of #600 by collapsing to a single helper. Worth looking for the same wording
    elsewhere: "mirrors X exactly" in a comment is almost always a marker of a third copy.

86. **The same structural defect was found twice today in unrelated places: a number
    computed from two incomparable quantities.** In invoices — an act for 1000 USD versus a verification
    of 740 USDT (#600 HIGH-3). In the cascade — the share in USDT minus an accumulator stored **in the
    payment currency** (#603 HIGH-2): an obligation closed in hryvnia puts ≈2000 into the accumulator, and
    almost any edit declares the drop overpaid. The common form: **the currency is stored next to the
    value but does not enter the arithmetic**, and the currency warning is hung on top of the already computed number.
    Worth reviewing the remaining money paths for this same form:
    wherever there is an `amount` + `currency` pair, subtraction/comparison must either check
    currency equality or not produce a number at all.

87. **A property test can be blind by construction.** #603 HIGH-1: the generator derived
    `settledAmount` **from** the "obligation closed" flag, so the disputed combination
    "obligation `PENDING` + accumulator > 0" was never produced even once — and the "monotonicity
    invariant" under test was asserted only where it could not be violated. The same class as a mock
    confirming any implementation, only a level up: **the defect is not in the assertion but in the
    generator**. When reviewing property tests, look not at the asserts but at which combinations
    the input can produce at all.

88. **The `security-noted` label does not exist in the repository.** Reviewers try to apply it and cannot
    (`gh label list` — absent). Either create it or remove the mention from the agent instructions.

89. **A flag raised on only one branch asserts a falsehood on all the others.**
    #600 MED-G: `mixedCurrency` was set only on the legacy recalculation path, so for a normal
    signed invoice of a mixed batch the public response said `mixedCurrency: false` — denying
    mixedness in exactly the case the field was introduced for. The PR's own test
    pinned this (`false` for a 1000 USD + 500 EUR batch). The common form: **a boolean field does not distinguish
    "no" from "not determined"**, and the consumer reads it as "no". Cured by a nullable third
    state. Item 70 belongs here too: emptiness is information, and it must not be replaced by a confident "no".

90. **Manual cleanup of `payout_requests` will break act signing.** Noted on #600 round 6.
    Currently unreachable (neither code nor manual migrations delete `payout_requests`), but the schema **itself**
    calls "future cleanup of payout_requests" realistic — `dropCascadeOrigin` was introduced in #443
    for that. With such a cleanup, the FK `ON DELETE SET NULL` (`schema.ts:706-708`) will null out
    `payoutRequestId`, and `signInvoice` will start failing with 409. If the cleanup is ever done —
    look here first.

91. **A guard may rest on an invariant that the next task of the same cascade removes.**
    #603 HIGH-2-residual, and this is the subtlest finding of the day. Comparing the currency to the literal `'USDT'`
    is correct today only because the row's currency is held unchanged by BIZ-18 — **the very guard
    that task 3 removes**. No test will catch this: a unit test will only prove that the literal
    is what it is, not that another package depends on it.
    **General rule:** when reviewing an assumption, ask not "is it true now" but "what exactly holds it
    up and is that part of the plan for the upcoming work". In a multi-task cascade, an invariant
    propping up someone else's code is an obligation both sides must know about.
    **An asymmetry worth remembering:** on the write side in this same codebase
    (`pending-settlement.service.ts:806`) they refuse **loudly** on an invariant that is unreachable today.
    The write side chose a loud refusal, the read side a silent assumption. Align to the write side.

92. **A "will go red when the literal changes" test is almost always self-deception.** A continuation of item 91: such
    a test proves the existence of the literal, not the dependence of a remote consumer on it.
    If module A's correctness depends on a value in module B, the thing to fix is the link (read B's
    value), not to add a watchdog test in B.

93. **An agent without `isolation=worktree` inherits the parent's worktree, not the one named in the task.**
    Caught on #603: the prompt specified a working directory, but the harness gave the agent the worktree of
    the calling session, and `git rev-parse --show-toplevel` returned the main checkout. The hook
    `pre:bash:cross-agent-blast` caught this and blocked edits to the "foreign" tree — so the
    protection worked as designed, but the task was worded so that the agent physically could not
    execute it as written.
    **Takeaway for dispatch:** if an agent must work in a specific existing worktree,
    stating it in the prompt text is **not enough** — either it does `git worktree add --detach`
    into its own scratch, or the task is built around a branch, not a directory. Side note: giving
    the absolute path of someone else's worktree in the prompt is an invitation to contamination, which the hook then
    catches.

94. **`signInvoice` had not a single happy-path unit test — discovered in round seven of #600.**
    The function signs legal documents and moves money; all unit tests around it were
    on `SENIOR_INCOME` and threw an exception **before** the PAYOUT branch. The mutation gate was silent because
    it does not redden on uncovered branches (item 71), and the integration spec exercised PAYOUT only along
    the happy path and never reached the `throw` branches.
    **A lesson wider than one function:** "covered by tests" and "has at least one test that actually
    executes it" are different claims, and the second is worth checking separately on money paths.
    It is worth running an inventory: which other money-moving functions have no unit test
    that executes them.

95. **The same "currency does not enter the arithmetic" defect moved into the display path — and its trigger
    is also task 3.** Found by security review on #603 round 3 (SR-M-1, not a blocker). `oldAmount`
    is taken from rows to which `bookCompanyObligations` stamps `currency: 'USDT'` as a literal,
    but the plan labels it `sourceCurrency`. `CascadeDerivativeSnapshot.currency` is loaded and never
    read; `pendingObligations.currency` does not reach the snapshot at all. Unreachable today —
    BIZ-18 forbids changing the currency of a paid row. **But BIZ-18 is one condition
    on `amount || currency || salaryMonth`**: if task 3 relaxes it wholesale rather than surgically
    for `amount`, the admin will see a USDT number labelled EUR. The second case of item 91 in a row, and both wait for
    the same wrong move in task 3.

96. **A test can buy the gate's number instead of protection.** #603, LOW: the test on the
    `settledAmount > 0` boundary kills its mutant **only** with a negative source amount — an input
    that `.positive()` on the wire schema does not let through. In the real input domain `>= 0`
    is equivalent to `> 0`, i.e. the mutant is equivalent, and the test raises the gate's count while protecting
    nothing. An honest approach would have been a suppression with an equivalence argument. The form to recognise:
    **the test is green only on an input that is impossible in prod.**

## Owner's decisions 2026-08-23

**D-1 (closes item 72). `Integration Tests (Postgres)` made a required check on `main`.**
Applied via the branch protection API on 2026-08-23; the required checks are now
`Typecheck · Lint · Unit Tests` · `E2E Tests` · `Integration Tests (Postgres)`.

What was verified before applying, so as not to repeat the "renaming a job breaks merge" class:

- The check-run name was taken from a **real commit** (`ffb04fc0`), not derived from YAML:
  `Integration Tests (Postgres)`, without the workflow prefix. A required check is matched by name —
  renaming the job in `ci.yml` now blocks merging for the whole repository.
- The job **always runs**; the docs filter hangs on its _steps_ (`steps.scope.outputs.code`),
  not on the job itself. So the verdict always arrives, and a docs-only PR does not get stuck on
  "required check skipped". That was the main mechanical risk — it is not there.
- `enforce_admins` = `true` (was so before this change, not modified): the check cannot be bypassed, even by the owner.

A consequence to keep in mind: **a flake in an integration spec now blocks all merges**,
not just its own PR. The zero-tolerance for flakes from `feedback_zero_flaky_e2e` extends to
the integration run in full.

**D-2 (closes item 83/84). A payout act with mixed currencies prints ONE final currency.**
The owner's decision: not a breakdown by currency and not a blind sum — **one converted total**.
The system already knows the meaningful number: the batch is converted at NBU rates and the result sits in
`transactions.amount`; today the PDF instead gets a blind `parseFloat` reduce of raw numbers
with the currency of an arbitrary row (and a `SELECT` without `ORDER BY`, i.e. "arbitrary" literally).

Boundaries of the decision, so that it is not widened during implementation:

- **Forbidding mixed currencies in a batch is still NOT an option** (item 84): the previous hard guard
  was removed as a bug, it blocked legitimate batches. The decision is about what to **print**, not
  about what to **allow**.
- A lawyer was not involved: the owner decided directly. If the form of the act is ever
  challenged by a counterparty — this is the point to start from.
- It does not block task 3 of the cascade and is not part of it (AC5 item 10 — do not fix neighbouring things in passing).
  A separate task.

**D-3. Resume auto-submission — on pause, a change of approach is expected.**
The owner's decision 2026-08-23. A pause, **not** a cancellation: the code `apps/api/src/job-sourcing/**`
(DOU provider, filtering, html→markdown, source budgets, matching) stays in `main` and
works. What changes is the approach to how auto-submission is done going forward; which one is not stated.

How to apply this so that the pause does not dissolve on its own:

- Draft tasks on the topic in `.claude/tasks/` (`task-resume-per-vacancy`, `task-vacancy-matching`,
  `task-job-sourcing-slice1`, `task-resume-*`) **are not to be picked up** without a new explicit word
  from the owner — they were written for the previous approach, and cannot be reused blindly.
- Review findings on `job-sourcing` **are recorded as usual**: the pause is about new development, not
  about fixing defects. Security and prod outages do not fall under the pause.
- Before proposing anything on the topic — ask what the approach has become.

The priority at the time of the pause is the paid-transaction edit cascade (tasks 3, 5, then 3b).

## Found during review of #607 (2026-08-23)

**97. The session scratchpad is shared between agents, and a checkout under a generic name vanishes from under you.**
Noticed by the security-reviewer on #607. His first checkout `…/scratchpad/checkout` disappeared from disk
between two calls, and the same directory held other people's files (`pr-body.md`, `addendum.md`,
`tx-diff.patch`), created before his session started. So the scratchpad the agent considers
its own is not.

This is the same family as `agent-isolation.md` §3 (a shared working directory under a predictable name),
just one level down: the rule closed `/tmp/rev<PR>`, but not generic names **inside** the scratchpad.
`checkout` is exactly such a name: any reviewer who needs their own checkout will pick it, and §6 of the
`code-review-discipline` skill effectively suggests precisely that.

The reviewer worked around it by recreating it under the unique name `sr607-checkout`, and this did not affect his conclusions.
But the workaround rests on attentiveness, not mechanics — exactly what we try not to
leave in place. Fix in the rule: the checkout name is derived from the agent's identifier, just like the worktree path.

**98. A ledger term verified by arithmetic on positional sums does not verify set membership.**
Formulated by the security-reviewer on #607 and confirmed by finding SR-H-2. The unit test of the ninth
term feeds nine fixed numbers and asserts the exact total — it catches a sign, a missing
term, and summing the wrong column, but **cannot catch a wrong predicate**: which rows
end up in the SUM is decided by Postgres, and the mock never poses that question. The test nevertheless looks
exhaustive and is green.

The shape to recognize: **a test on an aggregate checks the aggregate's arithmetic, not the selection into it.**
Selection is provable only by an executable query against a real DB — that is, by an integration spec,
which the mutation gate does not see (item 82). So money terms need both halves, and the absence of the
second betrays itself in no way.

**R-4. The cascade order changes: task 3b goes BEFORE task 5.**
Owner's decision 2026-08-23, made after the cost of deferral changed.

What changed. In the first edition of the task, a top-up on a drop obligation was refused **at the moment of
the top-up** — i.e. the row simply waited for 3b, and everything else worked. Closing SR-M-3/SR-M-4
with the single law AC15 ("the cascade does not roll back what it will not be able to close") moved the refusal **to the moment
of the edit**: the cascade has no right to reopen an obligation that then cannot be closed, because
a reopened row claims a nonexistent debt to a person, and the only way out of that state
is editing data.

Consequence: **income whose drop share is already paid out is not editable until 3b.** This is an ordinary
scenario, not an edge case. So 3b stopped being a nice-to-have addition and became a condition of the feature's completeness.

New order: **3 → 3b → 5**. The UI ships when both branches (senior and drop) close through the
system, rather than with a screen that says "not allowed" in a normal scenario.

**99. E2E fixtures and `db:seed` diverge: a full local run is not reproducible.**
Found by the coder on #607 round 2. All local E2E failures die at `dev-login` with
`HTTP 404 — User admin@cheekycheese.dev not found in DB`: these users exist nowhere in
`apps/api` (grepping the repository finds only the fixtures file itself), and `db:seed` creates different ones.

Shown, not asserted: swapping `apps/api/src` + `packages/shared/src` for `origin/main` gives
**exactly the same** number of failures as on the branch; `git diff origin/main -- apps/web apps/e2e apps/landing`
is empty. So it is a pre-existing gap, not a regression of the task.

Why this is not cosmetic: **E2E is green on CI**, because it has its own DB preparation steps.
So a developer running E2E locally before push (which is the requirement `feedback_e2e_before_push`)
gets redness unrelated to their change — and gets used to explaining it with the word
"pre-existing", exactly the phrase the zero-tolerance rule forbids without proof.
This has already led to a wrong report once: the coder declared the run green after reading a truncated
`tail -6` of the `line` reporter's output, where the total is visible but the list of failures is not.

AutoTest zone. Fix either via the seed (create the fixture users), or via the fixtures (use the ones
the seed actually creates). Incidentally: `tail` on the `line` reporter's output is a trap — the total is printed
after the list of failures.

**R-5. A top-up must come from the same payer, not just from the same pocket.**
Owner's decision 2026-08-23 on finding SR-M-5 (#607 round 2).

AC14 in the first edition compared the **funding source** — `COMPANY_ACCOUNT` versus `null`. Within
`ADMIN_PERSONAL` the source is the same for all admins (`null`), yet the flip
overwrites `senderId`, and personal balances (`adminBalances.sent`) sum the row's `amount` by
`senderId`. Result: admin A pays 260 → rollback → admin B tops up the remainder → **the whole row amount
is credited to B, and A looks like they did not pay**. The company account is not affected — hence MED — but
this is money between two partners with 50/50 shares, and the discrepancy is silent: it will surface nowhere until
the shares are reconciled by hand.

Rejected alternative: a "who contributed and how much" column modeled on `settled_currency`. More precise and
blocks nothing, but it is a separate task with a migration and a change to personal balances, and #607 should not
wait for it.

Accepted cost: if the first payment was made by one admin, that same admin must close the remainder — the other
gets an explicit refusal naming who paid. Reversible: drop the condition and add the column.

**100. Worktree provisioning is incomplete: without `apps/api/.env` and the throttle variables E2E does not start.**
Found by the coder on #607 round 3, cost them noticeable time — and will cost every next person.

The known provisioning fix consists of two steps (`pnpm install --frozen-lockfile` +
`pnpm --filter @crm/web build`), but they are not enough:

- a fresh worktree has no `apps/api/.env`, and the API **silently** fails on environment
  variable validation — the symptom looks like "the server did not come up", not "no config";
- CI sets `THROTTLE_RELAXED` / `THROTTLER_LIMIT`, they are absent locally — without them 68 specs fail
  with `HTTP 429` at `dev-login`, i.e. **redness unrelated to the change**.

Combines with item 99 (fixtures diverge from the seed) into one and the same effect: a developer
performing the mandatory "E2E locally before push" gets environment redness and gets used to
explaining it with the word "pre-existing" — exactly the phrase the zero-tolerance rule
forbids without proof.

Fix in provisioning, not in the instructions to agents: an instruction is a request to the reader, while
a missing file is mechanics. Minimum: copy `.env.example` → `apps/api/.env` and set the same throttle variables
that CI sets.

**101. BIZ-18 held up the correctness of four independent places, and none of them knew it.**
A generalization over the four HIGHs found on #607 across three review rounds. This is the most valuable takeaway about the
cascade, and it is bigger than the cascade itself.

The BIZ-18 guard ("the amount of a paid row is immutable") looked like a single business rule. In fact it was
**load-bearing** for four places, each of which would have been wrong without it, and none
of which referred to it:

| What lifting it woke up                                                          | Why it went unnoticed                                            |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Editing a row that **itself** is a settlement fact (`SENIOR_INCOME`)             | the flip zeroes `payoutRequestId`, guard 2 does not hold         |
| Overwriting `funding_source` by the next settle erases the term's compensation   | before top-ups a row was paid exactly once                       |
| The key `source_transaction_id = self` is wrong for the pre-July era             | the other predicates are empty for that population               |
| A race: a write without a status predicate (**pre-existing**, present on `main`) | without editing the amount of a `PAID` row the race has no price |

The fourth row is the most instructive: the defect **was already** in `main` and was harmless **only**
because BIZ-18 did not let anyone reach it. "Do not make it worse" is not enough for such a case:
the PR that lifts the guard is the activator, so it is the one that must fix it.

**A practical takeaway to apply to any guard removal.** The question "what breaks
if we remove it" is not about the guard itself, but about **everyone who silently stands on it**. They cannot be found by reading
the diff: they do not reference the guard, because they did not know they depended on it. They are found
only by the question "which statement stops being true" — and then by searching for the consumers
of that statement. Here: "the amount of a `PAID` row does not change" → who reads the amount of a `PAID` row →
the ledger terms, the accumulator, the origin predicates, the write races.

Related to item 91 (an invariant propping up someone else's code) — it is its mirror: there code depended on a guard
that was about to be removed; here the guard held four at once.

**102. Preview and apply read the row with DIFFERENT queries — the third "one state, two descriptions" pair in one file.**
The coder's observation from #607 rounds 3-4, confirmed by two findings in a row.

`getEditCascadePreview` reads through `fetchWritableTransactionOrThrow`, `adminUpdateTransaction` —
through `loadCascadeSnapshot`. Discrepancies were caught **twice in two rounds** exactly at the junction of these
two reads: CR-M-1 (the preview returned `editable: true` where apply refused) and
SR-M-2 (the preview showed 100, the write saved 260).

The irony is that the whole AC4 construction — "one resolver, two wrappers" — was built precisely so that the preview
and the fact would not diverge. There really is one resolver. **But the inputs to it
are formed by two different queries**, and the guarantee "a pure function on the same input gives
the same output" holds exactly as long as the inputs coincide — and that is no longer a property
of the construction, but a coincidence that has to be maintained by hand.

Right now they give the same thing. This is the third pair of its kind in this file (see item 85 — a rule in
three copies with a request to sync them by hand).

**Fix as a separate task: reduce to a single read.** It is important not to fix "one discrepancy per
round" — each such fix looks like a closed finding and leaves the cause in place.

**103. No gate reads prose — and three findings in a row were precisely in prose.**
The outcome of five review rounds of #607. A candidate for a mechanical layer, NOT a decision.

In rounds 3-5 three findings in a row turned out to have one shape — **a record asserts something that is not there**:

- references to a variable `priorSettled` not declared anywhere (six places, plus a seventh, found by the
  coder beyond the list: a name that exists in a different scope and means something else);
- a comment describing a **cancelled** implementation variant — the very one that bypassed the AC13
  boundary, and which in addition referred to an "explicit test" that did not exist;
- an escape hatch naming the wrong file — **twice in a row**, both times because the
  argument was carried over rather than re-checked.

All three survived both review and the mutation gate: **the gate mutates code, not prose**, and the reviewer
reads prose as an explanation, not as an assertion subject to verification. More dangerous than ordinary staleness —
the comment about the cancelled variant directly invited the next person to "restore consistency" and
bring the defect back.

**The coder's proposal:** check that every `` `identifier` `` in backticks inside a comment
resolves to an existing symbol. It would have caught the `priorSettled` finding entirely and the wrong
file one half-way, without touching judgments.

**Why this is a candidate, not a finished solution.** Before adding it, the noise has to be measured: backticks
hold snake_case column names, symbols from other packages, DB fields, library types, SQL fragments, and
just plain English words. A gate that makes noise on the harmless and stays silent on the dangerous is the very class
we have been cleaning out all month (see the argument in `review-findings-transfer.md` §"Mechanical check").
Order of action: first run the proposed rule over the repository **in report mode** and
look at the share of false positives; introduce it as a gate only if it is small.

**R-6. Cascade task 3 is merged (#607, 2026-08-23) on the owner's explicit "merge".**
Five review rounds, ~28 findings, **four HIGH** — all closed before merge, none reached the money.
Final verdicts on `cfa9529b`: `code-review: APPROVE (0)`, `spec-review: PASS (0)`,
`security-review: APPROVE (1 LOW, carried over)`. CI: 13 of 13, including `Integration Tests (Postgres)`,
which became required today.

The rationale for merging before manual acceptance — **the function is unreachable from the interface**: the PR does not touch
`apps/web` with a single file, the current client does not send `cascadeVersion` and does not call the preview
(verified by grep). For the user only the refusal text changed: editing the amount of a paid
row was rejected before and is rejected now. Full manual acceptance — on task 5, before
the screen makes the mechanics reachable. Owner's decision.

**Left over from the review, deliberately set aside (not forgotten):**

- preview and write read the row with different queries — item 102, a separate task;
- the classification of an edit is smeared across five `const`s — readability, belongs to the tasks of the series;
- the label `SR-L-2` in the task file was used for two different findings — an identifier must be
  a unique address; separated during transfer (the order of 3b and "two reads" are different items).

**Next by the owner's decision: 3 → 3b → 5.** 3b (top-up on a drop obligation) is a condition
of completeness, not an add-on: until it exists, income with an already paid-out drop share is not editable.

**104. Two worktrees on one branch: another checkout shows a "staged rollback" that nobody made.**
Found and **first diagnosed wrongly** on 2026-08-23. The corrected version is this one.

What was observed: in the owner's main checkout `git status --porcelain apps/ packages/` showed 18
files in the index — deletions of the cascade specs, of the addendum, a return of `transactions.service.ts` to its
pre-merge form, **−8718 lines**. It looked like classic MAIN contamination (FM-2), and that is how I
recorded it in the first edition of this item. **That was wrong.**

The actual mechanism, reconstructed from the facts:

1. The main checkout was on branch `main`, but its index and files remained at the **pre-merge**
   `0e43ce41` — nobody updated it after the merge of #607 (it is the owner's checkout, it simply sat there).
2. The orchestrator synced with `main` **in its own worktree** with the command
   `git checkout -B main origin/main`. **Git allows two worktrees to hold one branch with the
   forcing `-B`** — a plain `checkout main` it would have rejected, `-B` went through.
3. The branch pointer moved forward. The main checkout's HEAD moved with it, because the ref is shared,
   while the index and files are not: git does not touch the working trees of other worktrees.
4. `git status` honestly showed the difference between the new HEAD and the old index. Nobody wrote anything.

Evidence distinguishing this from real contamination: the index is **byte for byte** equal to the pre-merge state
(`git diff --cached <pre-merge-sha>` is empty), there are no unstaged edits at all, own work is zero.
Real contamination looks different — there are someone's edits, not an even rollback to a commit.

**Practical takeaways:**

- **`git checkout -B <branch>` in a worktree is a silent hijacking of the branch from another checkout.**
  A plain `checkout` protects ("already checked out at …"), `-B` removes that protection. To sync with
  the remote state in your own worktree you need a detached head (`git checkout --detach origin/main`) or
  your own branch, not a shared one.
- **A diagnosis of "looks like a known failure" is not a diagnosis.** The first edition of this item
  named the FM-2 mechanism as the culprit and proposed adding a hook for it. The hook would have caught what
  did not happen, and would not have touched the real cause at all — i.e. it would have cost the trust in the whole hook infrastructure for
  a false target.
- The owner should know: **the main checkout can lag behind `origin/main` for months**, and this is
  fine exactly until someone moves the branch under it.

**105. Fixing one review axis can reproduce a defect of another axis in a new place.**
Found on #611 (cascade task 5), round 2. The most instructive case of the whole cascade.

Round 1 produced two independent findings: `SR-H-1` — preview and submit diverge in the debounce
window; `COPY-H-1` — the note «Сохранить нельзя, пока не устранены проблемы» demands eliminating
something the operator cannot eliminate.

Both were fixed correctly. But the `SR-H-1` fix **widened the blocking condition** (`cascadeSaveBlocked`
now includes `previewIsRecomputing`), and the text from `COPY-H-1` was shown precisely by that
condition — and moved along with it into two ordinary happy-path states: while the first
request is in flight and in the debounce window after each keystroke. The operator started seeing both
«Пересчитываем…» and «сумму не пересчитать, нужно ручное решение» at once.

That is, the defect that the text was written to eliminate came back — in a new place and more often than it was.

**Why neither the coder nor the four other axes caught it.** Each axis looks at its own slice: code —
correctness of expressions, security — money, spec — conformance to the task, fidelity — pixels. The text
and **the condition of its display** belong to different axes, and the link between them is not visible from any one
of them alone. It was caught by the `copy-reviewer` on the repeat pass, because it read the already changed code, not
only its own earlier findings.

**Practical takeaways:**

- **A repeat review must look not only at "are my findings closed" but also at "has what they relied on
  shifted".** An axis that checks only its own list will miss exactly this class.
- **The formulation "the text is correct" is incomplete.** The correctness of a message is a function of the text AND of the
  set of states in which it is shown. The second is changed by other people's edits.
- Instead of arguing, the reviewer provided a **falsifiable check** — one line in an existing test,
  red on the current code. It is cheaper than a debate and does not require the parties' agreement.

**106. A finding addressed to a file outside the executor's zone is lost if left in the PR body.**
Same PR, `COPY-L-2`. The fix is addressed to `CONTEXT.md` (architect's zone), the coder refused to fix
one rule by violating zone-of-write — the right move. But the PR body collapses into the commit message,
and nobody looks for a glossary there.

The content of the finding, formulated as behavior (per `doc-durability`, without coordinates): **in the article
«Расчёт» the dictionary must allow the word "paid out" in the sense of an amount actually gone to the
recipient; the ban concerns calling the settle process itself a payout.** Without this the next
reviewer will raise the same thing again — which has already happened twice on this cascade with different
wording.

**Mechanics, not discipline:** a finding outside the executor's zone must go to the backlog, carried by whoever
assembles the aggregate, at the moment the refusal is accepted — and not stay in the PR body "for memory".

**107. A click before the debounce fires goes out without a token — the benign half of the same window.**
**CLOSED 2026-08-25 (#613): the rule was extracted into a pure function and is also computed from the live
value of the field — the button is inactive while there is no preview, instead of active with a subsequent refusal.**
Found by security-review on #611 round 2 (SR-L-4, LOW), measured by probe P6, not inferred.

After the SR-H-1 fix, submitting an unseen plan is impossible. But if the operator manages to press
«Сохранить» **before** the first debounce fires, the request goes out without `cascadeVersion` at all, and the
server bounces it with 400 and the text «откройте предпросмотр» — although there is no preview panel
on screen yet and nothing to open.

Fail-closed, lives ~400 ms, gives no wrong application — hence LOW and outside #611. But the refusal
text at that moment again instructs an action the operator cannot perform: the same
class as #610 and COPY-H-1, the third time in one module.

Fixed by the same device as the rest of the window: while there is no preview, the button is inactive, not
active with a subsequent refusal.

**108. A bookkeeping error during finding transfer: one axis's finding was attributed to another.**
The orchestrator (me) passed to the coder the finding "`CascadeDerivativePlan` does not carry the recipient for
`DROP_PENDING_PAYOUT`" as having come from the security axis. In fact it is from §14 of the designer's spec.
The security-reviewer noticed this on the repeat pass and checked his list: his six were different.

Why this is dangerous: the `review-findings-transfer` rule rests on **arithmetic** — the number of
identifiers in the `Findings:` of each axis must match the number of lines in the executor's report.
Attributing a finding to another axis breaks exactly that check: one axis gets an extra line, another
a shortfall, and both look like an executor error.

Takeaway: when transferring, specify the **source** of the finding (axis + identifier), rather than retelling it
in your own words with a reference "seems to be from there". If the source is not obvious — ask the axis, do not
guess. It was caught only because the reviewer on the repeat pass checked his own list
instead of accepting my wording.

**109. `db:seed` truncates 24 tables but not `company_account` — the balance accumulates between runs.**
Found by the coder on #611 round 4, explains the systematic redness of local E2E.

The observation it came out of: shard 1 at the start of the session was fully green, by the end it gave
46 failures — **and it is not the branch** (on `main` at the same moment 47). The cause is not in the code but in the rig:
the seed does not zero the company account, so the balance grows from run to run, and the DROP specs start
failing on their own.

Combines with items 99 (fixtures diverge from the seed) and 100 (provisioning is incomplete) into one thing:
**local E2E is currently not an observation instrument but a ritual.** To tell a regression from background,
you have to run both sides every time and compare the sets of `file:line` — which the coders on this
cascade did, but that is protection by discipline, not by mechanics.

**FIXED 2026-08-25 — the claimed mechanism is wrong, the cause of the redness remains unknown.**
The coder checked the claim before fixing and refuted it: `company_account` **is already
zeroed** by the seed — as a side effect of `TRUNCATE ... CASCADE` on `users`, because there is
a foreign key to it (`updated_by`). Shown by two seed cycles with an operation that debits the account:
the balance returns to zero both before and after the change. The same implicit protection covers several more
tables not named in the list.

So the explanation "the balance accumulates between runs" **is not the cause** of the observed
E2E redness (46 failures versus 47 on clean `main`). **The real cause has not been found** — it
is still open, and it must be looked for anew, not considered closed by this item.

How this entry came about: the diagnosis came from the coder's report on #611 and was carried into the backlog
**without verification**. Exactly the class we have been catching all month — a confident assertion where there
was no check. It should have been recorded as "there is redness, the cause is not established".

The seed change was made nonetheless and is justified differently: today's protection is **accidental** — it rests
on an unrelated foreign key and will quietly disappear when `company_account` is refactored, resurrecting exactly the
risk the original item feared. An explicit line in the truncation list makes the protection intentional.

Incidentally, from the same report: unit runs on the owner's machine give ~1 sporadic failure per
run under load (three different tests in three runs, including a run on clean `main`) — i.e.
this is CPU starvation from parallel agents, not a code flake. Worth remembering when reading reports.

**110. The new error banner prints the server message as is — English appeared on a money screen.**
**CLOSED 2026-08-25 (#613): fixed in the shared resolver, not in the panel. It turned out to be deeper than the
wording — the resolver trusted any response message as an explanation, while the server puts
boilerplate phrases there for unhandled exceptions. Such phrases are now treated as "did not explain".**
Found by security-review on #611 round 4 (SR-L-5, LOW), measured.

After UX-6 the preview panel shows a banner on a status error — a new surface that
did not exist before. The banner renders the server response's `message` without translation, so on a 500
`Internal server error` is visible, on a 403 — `Forbidden`.

There is no leak of internals (verified: the raw message goes only to telemetry), but `russian-language.md` is violated:
the entire project UI is Russian, and this screen shows money. Fix in the shared
message resolver, not in the panel — otherwise the next surface will repeat it.

**111. The compiled `@crm/shared` survives a branch switch — and forges the "proof by red".**
**CLOSED 2026-08-25 (#613) from two sides: `tsconfig.base.json` entered the build system's hash;
the alias to sources in tests became unconditional (landing did not have it at all); the package
build precedes the type check. The variant via `pre*` scripts was checked and rejected — in our version of
pnpm they are silently not run by default.**
Found while reconciling the agents' measurements on the cascade (2026-08-23/24); the mechanism was verified, and an incident
with a wrong conclusion did not happen only because the agents compared sets of failing tests.

`@crm/shared` is resolved by consumers **through `dist/`** (the package's `main`/`exports` field), `dist/`
is in `.gitignore`, and the build is a separate step. `git checkout` of another branch **does not rebuild
the package**: what stays on disk is the compiled code of the branch where `build` was last run.

Why this is more dangerous than ordinary staleness. Our main verification device is "show that the test goes red
on the version of the code without the fix": the agent switches to `main`, runs the test, sees red, and concludes
"the defect is pre-existing". If `dist` meanwhile holds the feature-branch build, the red was produced by **its
own code**, and the conclusion comes out exactly opposite to the truth. That is, the mechanism hits not convenience
but the instrument by which we tell a regression from background.

The symptom by which it is recognized: the run result does not change when switching branches although the diff
between them touches `packages/shared`. Or the opposite — it changes where by the diff it should not.

Condition for checking that the finding is still alive: `packages/shared/package.json` still points
consumers at `dist`, and `dist` stays outside git. While both hold, the trap is in place.

Fix not by discipline ("do not forget to rebuild") but by mechanics: rebuilding `@crm/shared` as a
precondition of a run that may import it. Discipline has already been tested here and does not hold:
the instruction about rebuilding exists, and we caught this by comparing sets of `file:line`, not by memory.

**112. A number in a long-lived record without a handle for re-checking (§15 of the preview spec).** — CLOSED
Found by copy-review on #611 round 7 (COPY-L-8, LOW). Closed 2026-08-25: the text of the failing
assertion was added to §15, so the claim about four tests is now re-checkable without repeating the experiment.

`docs/design/cascade-preview.md` §15 asserts that the naive edit "breaks four
pre-existing tests — one in `@crm/shared`, three in `@crm/api`". The number is there, **the handle is not**:
a reader three months from now cannot re-check the claim without repeating the entire experiment.

In the code comment next to it the handle **already exists** — the text of the failing assertion is quoted there. The long-
lived record is §15, not the comment, so the verifiable detail must live in it (or §15
must explicitly point to that place).

This is a special case of the general rule: `doc-durability` requires a long-lived record to carry the **verification
condition**, not only the conclusion. A number without a way to re-check it is a conclusion without a condition.

**113. From the outside it is impossible to tell which commit is running in prod.**
**CLOSED 2026-08-25 (#613): a build fingerprint in the liveness-check response + passing it during
image build from the same version source that already goes into the frontend. The check on prod
to be done in fact after deploy.**
Found during acceptance of the cascade on 2026-08-25: it was necessary to prove that prod had been updated — and it turned out
that this can be proven only for the frontend.

`/api/health` returns `{status, timestamp}` and **not a word about the version**. There is no public introspection
(swagger / openapi). Logging in is impossible: prod is SSO only.

**FIXED 2026-08-25 (finding of security-review SR-M-2).** The first edition claimed that
finance routes answer `404` to an unauthorized caller — the same code as for a nonexistent path — and
that therefore the probe "is the endpoint there" distinguishes nothing. **This is wrong, and wrong through my
mistake:** I tried the path `/api/finance/transactions`, which **does not exist**, and got `404`
precisely because of that. The real path returns `401`.

The probe distinguishes perfectly well: an existing protected route → `401`, a nonexistent one → `404`.
Re-checked on both cascade endpoints — the edit preview and the edit apply both answer `401`
(apply — with method `PATCH`; on `GET` it naturally gives `404`, and that is also easy to mistake for
a missing route). That is, **the presence of the server half on prod is verifiable from outside**, and on this
cascade it was verified.

The item nevertheless **remains open**, but for a narrower reason: the presence of a route proves
"a version in which this route exists is deployed", not "this very commit is deployed". For the second
a build fingerprint is still needed.

Outcome: the frontend is verified in fact (the bundle hashes changed, the served code contains strings of the new
feature), **while the server half is verified only by trusting the green deploy step.** That is exactly the support
that has already failed once: the build was green while prod was not updated for four days, and it was noticed
not by a gate.

Cheap to fix: `/api/health` returns a short build fingerprint (commit and time). Then checking
prod becomes one command instead of reasoning, and works the same for both halves.

Careful with the form: the fingerprint must not turn into a hint for an attacker beyond what is already
visible in the public repository — the commit is enough, the stack and paths are not needed.

**114. An empty string is not absence: two defects of one shape, both caught only by running the image.**
Found by the coder while closing item 113 (2026-08-25). Both fixed there; the value is in the shape, not in
the lines themselves.

The build fingerprint is read from environment variables set during the image build. Going along this
path, the coder hit two independent places where an **empty string passed itself off as a value**:

1. **Declaring a build argument with an empty default value** bakes into the image a
   **present** variable with the value `''`. A validation schema marking the field as
   optional does not catch this — **the key is there**. Result: the container went into a restart loop
   at startup. Fixed by the same device already applied in the project to another optional numeric
   parameter: preprocessing "empty/whitespace string → absent".
2. **The configuration reader, on `undefined` in the validated config, falls back to the raw
   environment** (verified by reading the library sources, not the documentation). The same empty string
   reached the controller a second time, and the safety net via nullish coalescing **did not catch it**:
   `''` is not nullish. Fixed with a plain "or".

The common shape: **two different layers agreed that an empty string is a value**, and both standard
protections (optionality in the schema, nullish coalescing) by construction let it through. This is the same
class as item 70 (filling a column erases the "unknown" marker): the marker of absence
is destroyed, and then the system confidently works with emptiness as with data.

**Why it was caught.** Unit tests passed. Both defects showed up only when the coder **built
a real image and brought up the container**. The mutation gate was passed too — and said nothing as well.
Checking the build fingerprint without building the image means checking everything except what you are fixing.

**115. Two client conditions keep two text branches dead, and nothing links them.**
Found by manual QA during cascade acceptance (QA-LOW-1, 2026-08-25), clarified on a direct question.

The cascade preview panel can show six refusal reasons. Two of them — about the row belonging to the
payout family and about the link with a payout request — are **unreachable from the interface**: no live
scenario leads to them.

The unreachability rests on **two independent conditions in the client**: one hides the edit button itself,
the other, inside the dialog, replaces the whole editable block with static text, so that the amount
field is not rendered and the preview request cannot go out in principle. Verified that there is
exactly one entry into the dialog.

**Why this is recorded although there is no defect.** The server today already **unconditionally and correctly** returns
both reasons — verified by direct calls bypassing the client. That is, the branches are not dead code but a
**sleeping contract**: break either of the two client conditions — and they come alive instantly, without
a single change on the server.

At the same time **no assert, no test, no shared symbol links** the two conditions either to each other or to the
server list of refusals. The match today is manual, not structural — the same family as BIZ-18 (five review rounds went on
four independent places silently standing on one guard,
and none of them referred to it).

What is worth doing: a regression test binding the client conditions to the server list of
reasons — so that a divergence shows up as red, rather than being discovered by a live pass. AutoTest
zone.

**116. The cascade preview network error was not announced by a screen reader.** — CLOSED
Found by manual QA during cascade acceptance (QA-MED-1, MED, WCAG 4.1.3), 2026-08-25, fixed in #613.

A sighted user saw the red banner and the «Повторить» button; the live-region area meanwhile
stayed empty, so the screen reader announced **nothing** — the screen silently stopped doing
what it promised.

Recorded retroactively on a remark from spec-review (SPEC-M-2): the fix arrived in the PR from a live
QA pass, not from the backlog, and therefore was not tied to any item. A finding that got into the
diff bypassing the record is no different from a finding that was forgotten — the same channel that
`review-findings-transfer.md` fixes, only from the acceptance side, not the review side.

**117. The `apps/api` tests and the `apps/api` build now read different slices — this is intentional.**
Found by code-review on #613 (CR-M-4, MED). Recorded **not as a defect but as a decision**, so that
the next person does not reopen it as a bug.

When closing item 111, we made the alias to sources in tests unconditional. As a side effect this means that `apps/api`
units read the **sources** of the shared package, while the build of the same application reads its **built**
output. Formally a discrepancy.

**Why the trade is right** (verified by the reviewer, not assumed): CI brings up the API for end-to-end
tests only **after** the build and runs them against the real built code. So there are three layers:
units on sources — honest logic; the build — catches compilation breakage; end-to-end on the built output —
integration. **Before the change both test layers read the same, possibly stale, built
code and could lie in the same way** — that was the essence of item 111. After the change they read two different
slices, each honest.

The residual risk is named honestly: the compiler and the test bundler may diverge in semantics on the same
sources. Possible by construction; in the shared package there are validation schemas and pure functions,
without constructs where such a divergence is known. The reviewer looked and did not find any.

**118. A finding slipped past the control line — and this refines the rule, not refutes it.**
Observation on #613 (2026-08-25).

`review-findings-transfer.md` requires numbering findings and ending a review with the line
`Findings: … (N)`. On #613 the line was there — and still **did not match the body**: the reviewer numbered
the findings inside the "non-critical remarks" section, while one more lay separately, in a prose
section the numbering step did not reach. The cause is mechanical, not carelessness.

**It was caught by arithmetic** — the check "how many identifiers in the line versus how many findings in
the body", which the rule prescribes. That is, the case **confirms** the value of the check, and
does not call for its replacement by a machine gate: the rule itself names as the condition for a gate "a repeated loss
**in the presence of** a control line, i.e. proof that the arithmetic is not being done". Here
the arithmetic was done, and it worked.

A refinement worth making in the rule at its next edit: **number findings as they are
written, not by section** — the loss occurred exactly at the section boundary, where "numbered the section"
imperceptibly replaced "numbered every finding".

**119. The documented rollback does not roll back — it rebuilds `main` and overwrites what is being rolled back to.**
Found by security-review on #613 round 2 (SR-H-2). The mechanics were verified, **the defect itself is not fixed by this
PR** — it is older and bigger.

The runbook describes rollback as a manual run of the deploy with the tag of an old revision. In fact:

- the build job has no run condition, and the checkout goes **without specifying a revision** → the
  fresh tip of the main branch is taken;
- the image built from it is published **under the requested old tag**, i.e. it **overwrites
  the real image of that revision**.

Outcome: the rollback (a) does not return the old code and (b) **destroys the target of the rollback**. And it does so
silently, at the moment of an outage, when prod is already being watched by four eyes.

**Why this is recorded separately and not fixed along the way.** The fix changes the semantics of the
**only** path to prod to which the owner has no SSH access: a broken deploy
is fixed only by a new deploy run. This is not done inside a fix round for other people's findings.

**What was done instead of a fix: the defect was made visible.** The build fingerprint now takes the hash of the
**actual checkout**, not of the requested tag — so after a rollback it will honestly show
the tip of the main branch and **itself reveal** that the rollback did not happen. The difference between "fix" and
"make visible" here is deliberate.

**How to fix it for real** (as a separate task, with a trial run): a rollback by its meaning is **not a build**.
A run with an explicit tag must deploy an **already existing** image, not build a new one. Or,
if a build is still needed, the checkout must take the requested revision, and the publish must not overwrite
someone else's tag.

Related: the wording "redeploy a previously built image" appeared in a comment and was
**false from the moment it was written** — the same class as the finding about the wrong comment on
response codes. A prose assertion diverged from behavior, and it was noticed only by the one who went to
check the behavior.

**120. An allow-list for the appearance of a new secret substitution in build arguments.**
Proposed by security-review on #613 round 2 (SR-M-3, after the accepted rejection of the text guard).

The rejection of a mechanical check was justified by the fact that a **value** classifier will not distinguish
a public value kept in secrets for convenience from a real secret, and will make noise on
legitimate lines. The argument is valid — but it refutes only the value classifier.

It **does not refute** a check of a different kind: a list of known substitutions in the block of build arguments
that goes red exactly when a **new** one appears. Such a form has no false positives
by construction: it fires once, on the addition of a line, and demands not "prove it is not a secret"
but "add it to the list deliberately". The form is already applied in the repository for checking the wiring
of prod migrations.

Not done in #613: it is a new check, not a fix for a finding, and introducing it inside somebody else's
fix round would be an expansion of scope.

**121. The mutation gate blames code where it itself ran not a single test (web).**
**CAUSE REVISED 2026-08-25, THE SAME DAY. The plugin is not to blame, our arithmetic is.**
The first edition below attributed the defect to a known plugin bug and referred to its documentation.
The diagnosis was plausible and **wrong**.

The real cause: the test configs computed the repository root **by a fixed climb of two
levels** from their own location. The tool copies the package two levels deeper and reloads
the same config from there — the fixed climb lands on the package itself, and the alias to the shared package
points to a nonexistent path. Next to it, meanwhile, lay an already written but **not wired in**
helper that finds the root by walking upward and does not depend on depth.

**And we activated this ourselves** — with item 111: by making the alias unconditional, we woke a defect
that had until then slept behind the condition "only in the working tree".

Proof that the diagnosis was replaced, by the numbers: after fixing the root computation the web package went from
33 "unevaluated mutants" (zero tests run) to **17 honest survivors**. If the cause
had been a plugin bug, fixing the paths would have changed nothing.

What from the first edition **remains true**: the failure mode was false redness, not false
green; and the gate's ability to tell a tool failure from a surviving mutant is a value in its own right,
and it is still needed. Only the attribution of the cause was wrong.

_Below is the first edition, preserved as a trace of the reasoning._

Diagnosed by DevOps on 2026-08-25 while analyzing the block on #613. The cause is a **plugin bug**, not our
code and not this branch.

**Mechanism.** The "run only related tests" setting is on by default and is applied
**twice**: correctly on the exploratory run and **again on each mutant** — but there already with a
single file. For web the second, narrow pass finds **no** tests at all. And the result
"zero tests run" turns into the verdict **"survived"**, because among zero tests there are no
failed ones, — while the non-empty coverage map from the exploration prevents marking the mutant as uncovered.

The sign in the Stryker report is verbatim: **"0.00 tests run per mutant"**. Precisely this phrase
describes the symptom in the tool's own documentation, where the only solution offered is to
disable the mentioned setting.

**The failure mode is false REDNESS, not false green.** The gate blames code that the tests
in fact cover and kill; it cannot let bad code pass this way. This is important: the first reaction
("so its past green verdicts meant nothing") is **wrong**.

**Not introduced by the cascade.** The gate code on the main branch is identical; the defect has lived since the gate was created
and until now had not shown itself so clearly. On a control diff in another package the gate worked
normally — i.e. the defect is specific to web's complex module graph, not general.

**The official fix was checked and is unsuitable as is.** Disabling the setting mechanically removes
the cause, but: the exploratory run grows almost threefold; a **separate** structural defect surfaces — the tool's
sandbox sees only the package directory and does not see the monorepo root, because of which
the meta-test importing the root config fails; and after working around that **not a single
mutant completes** within the allotted time, presumably because mutants under markup conditions require
a full environment reload for each.

**Related, same class:** the same sandbox blindness reproduces for the server package and is
heavier there — the shared package does not resolve inside the sandbox at all, and any diff that reaches
the load of the root module fails.

**What to do — the owner's decision.** Options: (a) teach the gate to tell "the run executed no
tests" from "the mutant survived" and report it as a tool failure — honest, cheap, but web
temporarily remains without a mutation gate; (b) raise the budget and deal with the cost; (c)
leave as is and work around by hand — the worst, because it breeds workarounds.

**122. The nightly mutation run does not separate a tool failure from a surviving mutant.**
Found by DevOps while fixing the gate's reporting (2026-08-25). **Deliberately not fixed** — the shape of the task is
different, fixing it silently would have been worse.

Item 121 taught the gate on push to tell "the run executed no tests" (a tool failure) from
"the mutant survived" (the code's fault). The nightly run, which opens an issue about surviving mutants, reads the
verdict **directly from the raw report** and does not share this reclassification.

So at night the same unevaluated mutants will still be counted as survivors. **The coverage there is wider**
(the night sweeps the whole package, not the changed files), so the discrepancy will be larger, not
smaller.

Why it was not done right away: the nightly path aggregates uploaded artifacts of several runs, i.e.
this is not the same fix in another place but a different task. Merging them into one code path is the right goal,
but it requires a decision on where the shared report-reading logic lives.

Until then: **an issue about surviving mutants opened at night for the web package should be re-checked** —
some lines there may be not the code's fault but a tool failure. The sign is the same: zero
executed tests for the mutant.

**123. A mutant suppression above a chained call is silently applied to the wrong node.**
Found by the coder while closing survivors on #613 (2026-08-25). Worked around in one place, **the class was not
checked across the repository**.

A suppression directive is bound to a node by the **start of the owner node**. For a chained call the start
is the first link of the chain, not the line above which the directive was written. So a suppression
placed above a specific link is applied **to a different one** — silently, with no error and no
warning.

Practical outcome: the author thinks they suppressed the mutant in link X with an explanation why; in fact
the mutant at the start of the chain is suppressed, while X stays alive (or the other way round — too much is suppressed, and we
stopped checking what we thought we were checking).

Worked around by extracting the value into a separate constant, the mechanism is documented nearby.

**What is not done:** the repository has **128 suppressions**, and the existing check of their correctness
(`check-mutation-suppressions.mjs`) looks only at whether the suppression is line-level and has a reason — it
**does not check whether it bound to the right node**. How many of the 128 stand above chained calls
and therefore mean something other than what is written — unknown.

The same class as the other findings of this day: the mechanism accepts a record and does something other than what
it says, without reporting it. Check by running, not by reading: remove the suppression, make sure
the mutant appears exactly where expected.

**124. A guard that compares a mirror with a mirror is green when diverging from the truth.**
Found by security-review on #615 round 4 (SR-M-5). Fixed there; the value is in the shape.

We introduced a check that two manual lists of the same files agree **with each other**. It
showed "no discrepancies" — while **both lists missed the same two files**,
which have existed in the pipeline since the start of August.

The reviewer's wording is more precise than any retelling: **of the two duties recorded in the comment,
the second was mechanized; the first had already not held by the time of mechanization.**

A generalization applicable to any guard: **comparing a copy with a copy is not a check.** It becomes a check
only when one of the sides is derived from a source rather than maintained by hand. Here
the source turned out to be a syntactic marker in the pipeline itself (whether a step has a condition),
and it was enough — semantics did not have to be derived.

How to tell that a guard is of this class: ask **what it compares**. If a human writes both sides, the guard proves only
that the human wrote the same thing twice.

**125. In the deploy pipeline an edit breaks not where it is written but in the neighborhood and the order.**
An observation from #615: five review rounds, three HIGH, six MED — and **not one finding could
be obtained by reading the diff**.

Where they lived: in the schedule of another trigger (the rollback cancels itself on the next scheduled
run); in a neighboring job that the edit did not touch (it pulled files from the fresh tip, because of
which a code rollback would have produced old code on a new schema); in the order of steps inside one job (the failure
happened after half of the files had already gone to the server); in the shape of a command's output (an empty
response with a successful exit code went into the "nothing to check" branch).

The cause is in the nature of the subject: **a deploy is not a function but a graph of jobs with shared side effects
on a live machine.** The question "is this edit correct" systematically does not work on it: the harm comes not
from the branch but from the neighborhood.

A working replacement for the question that has proven itself: **"what has now become possible".** Twice in a row
the answer to it produced the best part of the executor's report — including a finding named **against
itself** (that the new check had become a third manual list).

Incidentally, for guard discipline: the obvious move "guard the steps that fail" was **strictly
worse** — it moved the failure closer to the server. The right place for a failure is one: **the single
job that runs before all the others**.

**126. The resume render integration test is unstable under CI load.**
Observation 2026-09-01, isolated proof obtained.

A test in the resume RBAC suite checks that saving **does not render in place** but puts it into
the queue, and that the background task then ran. The assertion is "the render function was called one
time"; the run got zero.

**Proof of a flake, not a breakage:** the very same commit on a rerun gave
green. Between the last known green run of the integration tests and this failure only a **documentation-only PR** reached
the main branch, and the PR under test changed exclusively the
client date-picker component — unrelated to queues.

Time in the test is **relative** (`Date.now() - timeout`), not calendar — i.e. this is not
the same class as the date picker that broke the same day.

This blocks other people's merges: the failure looks like a red required check, and the next
person will spend time analyzing it exactly as I did.

**Fix as a flake:** the test waits for the background task to finish and, apparently, relies on
time, not on a completion marker. The right form is to wait for an observable fact (record state, a counter),
and not hope that the task made it in time. AutoTest zone.

The project rule requires isolated proof before calling a failure a flake.
It is here and recorded above — which is exactly why the item was opened and not silently passed over.

**127. The frozen fixture of a verification script no longer reproduces.**
Found by DevOps while fixing the gate (2026-09-01), set aside deliberately, not fixed.

In `scripts/devops/mutation-gate-vacuum-proof.sh` one of the checks reproduces a frozen
state from 2026-08-07. On the current component it fails in the tool's own trial run —
an access to an undefined value.

This is **fixture drift**, not a gate defect: the code it checks has changed since then.
The other checks of the same script work.

**Why recorded and not fixed on the spot:** the fix concerned a different place in the gate, and
mixing someone else's breakage into it would have meant combining two unrelated changes in one diff.

**Why this is dangerous if left unfixed.** The script claims to prove that the gate works.
One of its checks now always fails — so either they will stop running it altogether, or
they will get used to the redness and stop reading. Both outcomes make the proof decorative.

**128. Ordinary word wrapping does not fix overflow inside a flex container.**
Found while fixing the notifications popup (2026-09-01), would have cost half a day of debugging next time.

The obvious device — allowing long words to wrap — **does not work** if the container is flex.
By specification this mode is **excluded** from the min-content width calculation, so the box
manages to stretch to the unbreakable string before wrapping even kicks in.

Verified by the numbers: after applying it the overflow stayed **exactly the same** — 1535 versus 318,
not a pixel of difference. A different mode helps, the one that allows a break at an arbitrary place.

**The sign by which this is recognized:** if after the "fix" the overflow has not changed by a single
pixel — the wrong mode was chosen. Not "almost helped" and not "a bit more is needed" — simply the wrong
property.

## 130. The cross-agent blast guard does not let a reviewer clean up after itself

**Noticed:** 2026-09-02, twice in one session (security-reviewer round 3, code-reviewer on the same
PR).

A reviewer who, per the rule, is supposed to make **its own** checkout to verify redness
(`code-review-discipline` §6) cannot delete it afterwards: `pre:bash:cross-agent-blast`
blocks `git worktree remove`, because a read-only agent is dispatched **without**
`isolation="worktree"` — and the harness does not tie it to any working directory. The hook
honestly reports "yours: <not in a worktree>" and treats as foreign even a checkout the agent created itself
a minute earlier in its own session-scratchpad.

**Why this is not a trifle.** The `agent-isolation.md` rule requires the reviewer to have its own checkout — and the
same family of hooks punishes it for fulfilling that requirement. The agent is forced to leave garbage and
write "please clean up manually", which is what happened both times. The orchestrator had to clean up.

A worse consequence: **this is exactly how the habit of bypassing a gate is formed.**
A false positive costs trust in the whole hook infrastructure, not a minute — this is written in
`agent-isolation.md` itself, §"The cost of a false positive", and here it is violated by that very file.

**A direction, not a solution:** the hook needs a signal "this directory was created by this agent", not
"the agent was dispatched with isolation". The agent's session-scratchpad is issued by the harness personally — a path
inside one's own scratchpad is recognised as one's own with no connection to a worktree. Check that this
does not open the hole the hook was created to close (mutation of a foreign tree, PR #551).

**How we'll know it's fixed:** a reviewer that made a checkout in its scratchpad deletes it itself, and
the report has no "please clean up manually" line.

**Recurred 2026-09-03, three times in a day:** three reviewers (#644 x2, #646, #647) created a checkout per §6 of `code-review-discipline` in their session-scratchpad and could not remove it — the hook considers "its own" only a worktree issued at dispatch. The directories remained on disk (`scratchpad/checkout`, `cr-pr646-checkout`, `pr647-review-checkout`); cleanup — by the owner only. Until this is fixed, rule §6 prescribes what the hook forbids.

## 131. Playwright MCP writes to a foreign working directory by default

**Noticed:** 2026-09-02, designer on the project status filter spec.

Screenshots taken via Playwright MCP from an agent worktree landed in **someone else's** worktree
(`paid-transaction-edit-cascade-d0b6d1`), not in its own. The agent noticed this and moved the files
in a read-only way (`base64`), without touching the foreign tree — but noticed it by chance.

**Why it is dangerous:** writing to a foreign working directory is exactly what the isolation rule exists to prevent.
Here it happens **bypassing** the agent, via the tool's default path,
so neither of the two hooks sees it: no `git`/`kill` command is executed, the file appears
on its own.

**What to check:** where Playwright MCP takes the output directory from and whether it can be bound to the
calling agent's session-scratchpad. If not — make an explicit path specification a mandatory
part of the dispatch prompt of any agent that takes screenshots, and record this in
`agent-isolation.md`.

**How we'll know it's fixed:** a screenshot taken by agent A does not appear in agent B's directory.

## 132. The isolation rule gives a false stop on paths inherited from the parent session

**Noticed:** 2026-09-02. A coder dispatched to fix PR #623 stopped without starting work,
having decided it had been given a foreign working directory. The cost was about 120 thousand tokens and one
lost turn.

**Its own check passed:** `git rev-parse --show-toplevel` matched the issued path,
i.e. the rule's requirement (`agent-isolation.md` §8) was met. It was stopped by three other
signals it took for proof of a mismatch:

- the path to `CLAUDE.md` in the system reminder;
- the session-scratchpad path;
- the session memory contents.

**All three belong to the parent session and are inherited by every subagent.** They have no
relation to the agent's own directory. It also found the `locked` flag on its worktree suspicious — but
the harness marks all agent directories that way; it means "in use by you", not "foreign".

**Why this is not the agent's fault.** The rule explicitly says not to trust the environment's self-description
("The environment's self-description cannot be trusted", §8) and cites a case where the harness reported the
path of a nonexistent worktree. The agent applied the rule literally and in good faith. The rule
does not say **which** signals relate to its directory and which are inherited.

**What to write into the rule:** list what is inherited (the `CLAUDE.md` path in reminders, scratchpad,
memory) as parent-owned by definition and not subject to verification, and call `locked` the normal
state of one's own directory. The one remaining signal is a single one — the match of
`--show-toplevel` with the issued path.

**How we'll know it's fixed:** an agent whose toplevel matches does not stop and does not write to the
report about a mismatch.

## 133. Agents lose hours of work at the session limit because they do not commit along the way

**Noticed:** 2026-09-02, twice in a session. Five agents were cut off by `rate_limit`; three of them had 6 to 23 kilobytes
of uncommitted edits left in the working tree — several hours of work each.
Nothing was lost only because the orchestrator extracted the patches manually.

**How this came about.** `git-policy.md` §"WIP commits & chunking" **already requires** a `wip:` commit
every two files or five minutes, and `wip:` is specifically exempted from `ac_verified:` precisely for
this. The rule exists, it is not followed, and nothing reports it: uncommitted work
looks exactly like committed work while the agent is alive.

**How this differs from an ordinary discipline violation.** A cutoff at the limit is neither rare nor an
accident: it is a routine event, the more likely the longer an agent works. That is, the
rule is broken precisely in the tasks where the cost of breaking it is highest.

**Direction:** make the reminder mechanical rather than disciplinary. A candidate — a hook on
`Edit`/`Write` that counts files changed since the last commit and prints a warning
after a threshold. A warning, not a block: a blocking gate in the middle of an edit is a way to
breed a habit of bypassing it (`agent-isolation.md` §"The cost of a false positive").

**How we'll know it's fixed:** an agent cut off by the limit has no more than two
modified files in its working tree.

## 134. The session-scratchpad is shared by all subagents, and the prescribed checkout name in it is fixed

**Noticed:** 2026-09-02. Two reviewers of the same session independently named their checkouts identically
(`checkout`) and ended up in the same directory.

**This is not a coincidence but a construction.** The scratchpad is issued **per session**, not per agent: all
subagents of one session get the same path. Verified by listing — "its own"
scratchpad holds artifacts of dozens of different agents over a day: reviewers' checkouts, spec-reviewer
reports, mutation gate logs, designer screenshots. On top of that, the prescribed cleanup snippet
(`pm-snippets.md`, the reviewer checkout section, and `code-review-discipline` §6) names the
directory with a **fixed** name under `$SCRATCH`. Two agents that both followed the instruction literally
are bound to collide. Those that did not collide added a prefix themselves (`cr-pr611-r7-checkout`,
`sr-pr623-r5b-checkout`) — that is, improvisation saved them, not mechanics.

**How this is wider than the opaque-path hole** (closed by the `WORKTREE-OPAQUE` refusal): that one was about a
command the guard could not verify. Here there is nothing to verify — the path **really is** shared.
`agent-isolation.md` §3 requires that the working directory be derived from the identifier of the **agent
itself**; the scratchpad path is derived from the **session** identifier. This is exactly the defect the
rule forbids, and it is written into the prescribed snippet.

**Why the hook will not close this.** It has no signal separating "my subtree of the scratchpad" from
someone else's: it knows only about worktrees. So it can neither refuse a mutation of a foreign checkout in the
scratchpad nor recognise its own — the second half of the same gap is recorded as item 130 (a reviewer
cannot clean up after itself).

**Direction:** the directory name must be derived from the agent's identifier rather than be a constant in
the snippet — then a collision is impossible by construction, and the hook gets the very ownership signal
it lacks for item 130.

**How we'll know it's fixed:** two agents of one session, both following the snippet literally, get
**different** paths; there are no two directories with the same name from different agents in the scratchpad; a reviewer
deletes its own checkout itself, without a "please clean up manually" line.

## 135. CI: deferred optimizations with measurements (after splitting out the mutation gate)

**Opened:** 2026-09-03 by the owner's decision — focus on notifications; for CI we do only
the safe minimum (mutation gate as a separate job, docs-only filter, per-package matrix).
The rest goes here, with numbers, so we do not measure again.

**Measurements (8 successful CI runs, median/max, seconds):** `Typecheck · Lint · Unit Tests`
567/750 (of which unit tests 235–257, the rest is the mutation gate); `E2E (misc)` 332/384 —
the critical path among E2E; `E2E (landing)` 253/278; integration 232/246; the shortest
shard `drop-lifecycle` 109/143. Mutation gate per package: `shared` ~10 s, `web` ~230 s, `api`
typically 250 s, **maximum 2489 s** — the source of 25–47 minute runs on heavy diffs.

**Checked and refuted:** the concurrency ceiling is **not hit** (in runs with a queue
at most 13 slots were busy; the 302 s of waiting was not due to the limit). The ceiling of 20 itself is not confirmed
(`gh api /user` → `plan: null`). The design must be such that correctness does not depend on it.

### What is deferred

**[PRIORITY, 2026-09-03 — owner's decision]** Sub-item 1 below is the only remaining
lever for mutation gate speed after the rollback of `ignoreStatic` (the self-check showed that the setting
hides module constants — the 2026-08-07 incident class; see `mutation-gate.mjs` "PR GATE vs
NIGHTLY"). Until this fix, heavy diffs on `--changed` take 25–47 minutes (the same figure from
the eight CI runs above in this same item, not re-measured after the rollback — `ignoreStatic`
never made it to production), deliberately.

1. **File sharding of the `api` leg of the mutation gate.** The only thing that cures heavy diffs:
   a per-package matrix gives `max` instead of the sum, but when all the weight is in `api`, `max` = `api`.
   The `mutation-gate.mjs` script **cannot** split by file — environment variables: only
   `MUTATION_PACKAGES`, `MUTATION_ONLY_FILES`, budget, concurrency. The script needs a change:
   distributing the changed files across N legs while keeping **one** report per package
   (the gate reads the report by package name — N legs would give N reports, and the aggregation must be explicit).
   Estimate from measurements: heavy PRs 25–47 min → ~16–23 min.
2. **Rebalancing E2E shards.** `misc` is 18 files and the critical path; per-file durations
   were taken from **one** run (±20%), the decision needs 3+. Candidate: move `tests/crm/`
   (9 specs) into a separate shard. Along the way: `crm-tab-title.spec.ts` is claimed to run twice —
   confirm and remove the duplicate.
3. **Splitting `Typecheck · Lint · Unit Tests` into legs under an aggregator with the same name.**
   The largest potential gain (~567 → ~330 s), but the aggregator is a new point of failure: a bug in
   it means either a forever-red required check or green with a red leg. Do it only with
   a test for both sides and **without** renaming the required context.

### A trap, recorded deliberately

The per-package mutation gate matrix **must not** introduce per-package budgets (3600/1800/600 etc.):
the script knows **one** budget per run, and separate numbers without a measurement for `web` mean a silent
tightening with false reds. One budget per leg, the same as now.

**How we'll know it's done:** the median of `Typecheck · Lint · Unit Tests` on PRs with code is below 300 s,
and no PR in a month exceeded 15 minutes on the mutation gate.

## 136. Audit of landing and CRM text — before the next multilingual work

**Opened:** 2026-09-03 at the owner's request. **When to do it:** as the first step of the next task
on multilingual support, before translating or extending the dictionaries.

**The fact behind this entry.** Text review (`copy-reviewer`) had not been run before PR #623
even once. The agent was created 2026-08-04; the landing was translated into five languages (en/uk/ru/es/pt) in July, PRs
#421–#425 — that is, **none of the five dictionaries went through text review**. The CRM (`apps/web`)
is Russian-language, with no real dictionaries; all its strings were written by coders as they went
and were likewise not reviewed as text.

On #623 the very first run of this axis produced fourteen findings, three of them HIGH, and two of them were not
about style but about behavior: the login page crashed on error codes, and the advice "choose another
account" was impossible to follow. That is, unchecked text is not only "reads like a translation",
it is also a place where defects hide that neither code review nor tests see.

**What to audit.**

- **Landing, all five dictionaries** — per the `copywriting` skill: the logo-swap test for each
  heading, signs of machine text, and above all — **five originals, not a translation**: write out
  each heading's claim in one line and check that all five languages carry the same
  set of promises. Measure length in characters for the longest language at 320px.
- **CRM, all visible text** — headings, empty states, errors, toasts, button labels.
  Pay special attention to error messages: each must say **what to do next**, not
  only what happened (findings COPY-H-3 and COPY-M-8 on #623 are a sample of how this breaks).
- **English strings in the Russian-language CRM** — on #623 two English toasts were found on new
  paths (`COPY-H-5`, `COPY-H-6`), and both came from old literals in services. Go through all
  `throw new *Exception('...')` in `apps/api` and find those that reach the screen.

**Why precisely before multilingual work, and not sometime later.** Translating unchecked text
means multiplying every defect by the number of languages. It is cheaper to fix the source once than to
fix five dictionaries in sync later.

**How we'll know it's done:** every landing dictionary and the CRM carry a `Copy Review:
PASS` verdict from `copy-reviewer`, and the list of found behavior defects (not style) has been filed as separate
backlog items.

## 137. The nightly mutation alert channel delivers, but nobody reads it

**Filed:** 2026-09-03, while fixing `task-mutation-gate nightly-alert-fidelity` (see alongside —
the fix to the alert TEXT of `post-merge-alert.sh` for `KIND=mutation`). Verified by execution
(`gh issue view 26 --repo yaremenko-maksym/cheekycheese-telemetry`): the issue was opened 2026-08-12,
**22 comments**, the last one today, 2026-09-03, still `OPEN`. For many weeks the channel
technically worked (the issue was opened, commented on every night) — but for more than three weeks
in a row nobody read it, and the nightly gate silently stayed red precisely because of that, not only
because of the imprecise alert text.

**How this differs from what is being fixed alongside.** The neighbouring fix (`post-merge-alert.sh`,
`check-mutation-tally.mjs`) makes the alert TEXT precise: previously "the run did not complete" and "survivors were found"
read the same ("surviving mutants — here is what to do"), although they are different diagnoses.
But precise text in an unread issue does not solve the original problem — 22 silent comments
prove that the wording is not the only cause: a delivery channel by itself does not create attention.

**Direction (not decided, requires an owner choice — irreversible at the price of "weeks of silence again",
see `autonomy-levels.md` A2/A3):** a digest/notification ON TOP of the issue (email/Telegram when it is
opened and on every continuation, not just the fact that the issue was created) — by analogy with how
`telemetry-digest.yml` already aggregates other private issues into a readable summary; or an explicit
periodic item in someone's regular checklist ("every N days open
`cheekycheese-telemetry` by hand"). Not DevOps's decision alone.

**How we will know it is fixed:** no `mutants-surviving` issue in `cheekycheese-telemetry`
accumulates more than 2-3 consecutive comments without an external signal (email/message) BEFORE
someone reacted to it; or an explicit person responsible for periodically reviewing the channel is named and
confirmed.

## 138. The Stryker sandbox does not copy `.sql` — a local full `@crm/api` run is unreliable

**Filed:** 2026-09-03, coder's finding on #623 (verified by `git log`) — unrelated to #623 itself,
a structural hole in the mutation gate. The `.sql` file from PR #587 does not make it into the sandbox that Stryker
builds for `@crm/api` before a run: the gate mutates and tests TS/JS sources, but copying the
project into the sandbox is a separate, more general Stryker mechanism (`files`/autodetect in
`@stryker-mutator/core`), and it does not guarantee that every file the code depends on at runtime
(a migration, raw SQL, anything non-TS) ends up next to it in the sandbox. Practical effect: a local
`--changed`/`--full` on `@crm/api` may pass (or fail differently) compared to the same run in CI, where
the checkout is complete — i.e. a local green is NOT proof that CI will also be green, specifically for
diffs touching such files.

**Direction (not decided):** check which list of paths Stryker actually copies into the sandbox for
`@crm/api` (`mutation-gate.mjs`'s `writeConfig()` — no explicit `files:` allow-list, so Stryker's
default autodetect applies; compare its behaviour against `.sql` paths using the primary source
`@stryker-mutator/core`, not a guess). If the default really skips non-TS dependencies —
either an explicit `files:` allow-list with the needed paths, or a documented limitation "a local
run of @crm/api is unreliable for diffs outside TS/JS, trust only CI".

**How we will know it is fixed:** a full local `--changed` on `@crm/api` (a diff touching `.sql`
or another non-TS runtime-dependency file) gives THE SAME result (the same surviving/killed on the same
mutants) as the CI run of the same commit.

## 139. Killing another agent's process by the right PID, but with a misidentification

**Filed:** 2026-09-03, an honest admission by the coder on #623 — sent SIGKILL to another
agent's process. Formally the rule was followed (`agent-isolation.md` §5: kill by PID, not by the
`pkill`/`killall` pattern) — but the PID was obtained from a wrong identification: a process mistaken for a
zombie of its own session turned out to be a live process of ANOTHER agent.

**How this differs from what is already closed.** `agent-isolation.md` §5 and the `pre:bash:cross-agent-blast` hook close the
specific mechanism — a broadcast `pkill -f`/`killall` by pattern. Here the mechanism is different:
the kill is targeted, by PID, syntactically correct — the error is in WHOSE PID it is, and the hook cannot
check that (it does not know which PID belongs to whom; that is a fact from the outside world, not from
the command text).

**Direction:** before `kill <PID>` — first `ps -o etime,cmd -p <PID>` and compare the result with
**one's own** ports (`lsof -ti tcp:<own port>`) and the agent's working directory, not with the
assumption "it has been hanging for a long time — so it's a zombie". If what `ps` shows does not match what is expected (own
process, own port, own directory) — do not touch it, report to the orchestrator, do not kill "just in case".
A candidate for `agent-isolation.md`: an explicit verification step before §5, not only a ban on the pattern form.

**How we will know it is fixed:** no agent report contains a line like "killed a process,
it turned out to be someone else's" — i.e. either the verification prevents the mistake, or (when in doubt)
the agent reports BEFORE, not after, the kill.

## 140. The pre-push hook runs the full unit suite regardless of the diff

**Filed:** 2026-09-03, orchestrator's observation on #646. One line in `.github/workflows/ci.yml`
(wiring an E2E spec into a shard) → `git push` = husky pre-push: typecheck plus the `api`/`web`/`landing` suites
(about 6,600 tests). Under machine load that is 5–10 minutes per attempt; the same agent's two previous attempts
failed on flakes of **other people's** tests after the full run. Result — more than half an hour for one line,
and the owner asked "what is the problem with these agents".

**How this differs from what is already done.** An empty `DATABASE_URL=` exempts only integration specs;
the `ac_verified:` gate is about the commit message; neither scopes the run by the diff.

**Direction:** a run over affected packages (`turbo run test --filter=...[origin/main]` or equivalent)
and a full exemption for diffs confined to `.github/**`, `docs/**`, `.claude/**`. The full suite remains
in CI — those are required checks, the hook does not replace them. Cost: a cross-package regression is no longer caught locally
(CI catches it); accept this knowingly.

**How we will know it is fixed:** a push of a diff of a single workflow file takes seconds, not minutes; a push with
an edit only in `apps/api` does not launch the `web`/`landing` suites.

## 141. The persist allowlist promises "non-PII reference data", yet the `projects` key persists e-mail, rates, shares, notes — and the rejection reason

**Filed:** 2026-09-03, security review of #646 (SR-M-1 is closed in the PR, SR-M-2 — here). Behaviour:
`PERSISTED_KEY_PREFIXES` includes the `projects` key; `members[].email`, `rate`,
shares and `notesGeneral` are stored in IndexedDB for 24 hours, and since #646 also `rejectionReason` (text about why a person
declined a money scheme), and the approvals panel on the SENIOR/DROP dashboards fills the cache where previously there was no request.
The persist rule (memory `project_persist_query_allowlist`): auth / payment / finance / PII — never.
The comment above the list claims something that is not true — the same class as the 15 false comments on #645.

**Direction:** either a persist-time transformer that strips sensitive fields for the `projects` key, or
move the financial fields and approvals data into a separate key outside the allowlist. One decision for both
points, not two different ones.

**How we will know it is fixed:** after loading `/projects` as SENIOR, the IndexedDB contents contain no e-mail,
no rates, and no rejection-reason text — a check of the **store contents**, not of the code.

## 142. A reviewer who reuses a checkout between rounds diffs not from the merge-base

**Filed:** 2026-09-03, second review round of #644. `git diff origin/main..HEAD` after `fetch` showed
75 files and −11,741 lines: `origin/main` had moved ahead by three commits between rounds, the real PR diff is
10 files. Caught only because the number did not match the first round.

**Direction:** in `code-review-discipline` §6 — before the diff, `base=$(git merge-base HEAD origin/main)` and
`git diff "$base"..HEAD`, and the source of truth for the diff's composition is `gh pr diff <N>` / `gh pr view --json files`;
the local checkout is needed only for running, not for reading the diff.

**How we will know it is fixed:** the file count in the second-round report equals the PR's file count per
`gh pr view --json files`; a mismatch is a finding about the procedure, not about the code.

## 143. Two worktrees on one branch ref: `checkout -B` did not stop git, one agent's commit landed on top of another's

**Filed:** 2026-09-03, DevOps report on #646 (a shard in `ci.yml`) — the second time that day by the same mechanism
(the first — `infra/mutation-gate-progress` and another agent's `agent-a8ed9dc9ba1e79209`). The task file told it to run
`git checkout -B feat/project-status-filter-ui origin/…` in its own worktree while the coder was working on the same branch in
theirs. Git did not refuse (the expected "already checked out at …"), and both worktrees ended up with HEAD on one
mutable ref: the coder's commit landed on top of DevOps's commit through the shared ref, not through a pull. No work was lost —
DevOps noticed, detached HEAD (`--detach`), cherry-picked only its own work onto a clean branch from the origin tip and pushed.

**Mechanism that must be established as a fact, not a guess:** why `checkout -B` went through (the `-B` flag resets an
existing branch; the "checked out elsewhere" check may not apply to `-B`; or the coder's branch
was named differently — `worktree-agent-…` with the same upstream). Reproduce on two temporary worktrees.

**Direction:** the orchestrator does not give two agents the same branch at the same time — the second gets **its own** branch from
the first's tip and a PR into it, or waits; in prompts — `git switch -c <own-branch> origin/<branch>` instead of `checkout -B`.
A candidate for the `pre:bash:cross-agent-blast` hook: refuse `checkout -B <branch>` if `git worktree list` shows
that branch at another worktree.

**How we will know it is fixed:** reproduction on two worktrees gives a refusal (git or the hook) before the second
HEAD lands on the shared ref.

## 144. A docs-only PR still brings up E2E service containers and triggers a deploy

**Filed:** 2026-09-03, #649 (only `BACKLOG-followups.md`): the `E2E (drop-lifecycle)` shard failed on
`Initialize containers` — three `docker pull postgres:16-alpine` timeouts in a row. The docs-only filter skips
**steps**, but a job's `services:` start before the steps, and docker-pull becomes a flake surface for a diff of
a single markdown file. After the merge `deploy.yml` rebuilt and redeployed prod with the same code.

**Direction:** for E2E — a job-level `if:` on the filter result (verify that a "skipped" required check does not
block the merge — GitHub treats skipped jobs as passed for required status checks; confirm by fact on a
test PR, not from memory) or move service containers into steps (`docker compose up` inside the job after the
filter). For deploy — `paths-ignore` on `**/*.md`, `.claude/**`, `docs/**` with the same `predicate-quantifier`.

**How we will know it is fixed:** on a docs-only PR no E2E shard shows the `Initialize containers` step, and
after the merge of a docs-only PR no deploy run is created.

## 145. GitHub Actions are pinned by tags, not SHA — including the step that receives the VPS SSH key

**Filed:** 2026-09-03, security review of #650 (SR-L-1, outside the PR — a convention of the whole repository).
`appleboy/ssh-action@v1.2.0` receives `VPS_SSH_KEY`; a tag is a movable pointer, a compromise of the tag on the
maintainer's side = someone else's code with the key to prod. The same class as pinning the signal-cli version by key
fingerprint: here there is no pin.

**Direction:** `uses: owner/action@<sha40> # vX.Y.Z` for all actions, starting with those that see secrets
(`ssh-action`, `docker/login-action`, `scp`); Dependabot/Renovate to update SHAs. A separate DevOps PR,
verified by `actionlint` + a grep for `@v`.

**How we will know it is fixed:** `grep -rnE 'uses: [^ ]+@v[0-9]' .github/workflows` is empty, except for explicit exceptions with a
justification in a comment.

## 146. Playwright MCP — one browser for all of a session's parallel agents

Filed 2026-09-03: ui-ux-designer (Mode B r2, #646) and manual-qa worked at the same time, each on its own stack
(3030/3031 and 3040/3041), but through ONE Playwright MCP browser instance of the parent session: the URL and user
were periodically swapped by another agent, the dev-login cookie on `localhost` (RFC 6265 — cookies do not distinguish ports)
was erased by another's login and vice versa. The known item 131 ("writes into another's directory") is merely a symptom of the same thing:
the browser does not belong to the agent. Consequences: the visual QA of two agents in parallel is invalid; screenshots into
another's allow-list directory; measurements may be of another's screen.
Direction: a rule in `agent-isolation.md` — no more than one agent with Playwright MCP at a time (the orchestrator
serialises the visual axes), or a per-agent browser (Playwright directly via `npx playwright` in its own worktree
with `--user-data-dir`/`storageState` in its own directory, instead of the shared MCP). Check: two agents with different
dev-logins at the same time → each has its own user until the end of the session.

## 147. `responsive-design.md`: touch target ≥44 px only "on mobile" (<640) — a 768 tablet counts as a touch device, but the rule does not cover it

Fidelity r2 #646 (UX-L-1): `sm:h-7` gives 28 px at 768; the designer considered it acceptable by the letter. Clarify the rule: 44 px up to `md` (1024)?

## 148. manual-qa/ui-ux infrastructure: three limitations found on #646 (2026-09-03)

1. Playwright MCP `browser_take_screenshot`/`browser_snapshot` accept only paths from an allow-list bound to the
   PARENT session's worktree — the agent cannot save a screenshot into its own worktree by either an absolute or a relative path
   (a relative one falls into the root of another's worktree). Related to 131/146: the browser and its directories do not belong to the agent.
2. `browser_resize` was missing from manual-qa's toolset at dispatch, although the agent's system prompt mentions it —
   reconcile the `tools:` frontmatter of `manual-qa.md` with the actual list (the same class as the `security-noted` label: an instruction
   refers to something that does not exist).
3. The `pre:bash:*` hook "too complex to verify that it stays inside the worktree" blocks multi-line heredocs with `while`,
   `page.evaluate`+`fetch`, path concatenation via `+` — even when everything is inside its own worktree; the agent wrote scripts
   in pieces via `cat >>`. A candidate for narrowing the predicate (a false positive teaches circumvention — see `agent-isolation.md`
   "The cost of a false positive").
   The workaround that worked for manual-qa: its own Node script on the monorepo's `@playwright/test` from Bash in its own worktree —
   all responsive screenshots and measurements were obtained by it, not through the shared MCP browser. Perhaps that is the direction for 146.

## 149. A reviewer's stress load ("load hogs") outlived the reviewer by 22 hours and kept the machine at LA 200

Filed 2026-09-03 23:41: the security-reviewer of round 6 of #623 (2026-09-03 ~01:30) launched `NPROC*2` = 16 busy-loops
in the background to check resilience to load and finished without stopping them. 16 `zsh -c` at ~35 % CPU each kept the load average at
150–320 all day; this was blamed on rendering in a neighbouring project and on parallel agents. Consequences: pre-push
flaked (3–6 attempts per push), test timeouts, "what is the problem with these agents". It was found only via `ps -r` with
the full command line (it contained the path to the reviewer's scratchpad).
Direction: (1) any synthetic load generator — with a TTL (`timeout <sec>` around the loop) and `trap` cleanup in the same
script; (2) in `code-review-discipline` §6 — "after the redness check make sure `ps` for your own scratchpad path is empty";
(3) the zombie reaper (`reap-zombie-devservers.sh`) catches only node/worktree — extend it to processes whose command contains
the scratchpad path of a finished session/agent older than N hours. Check: `ps -Ao etime,command | grep scratchpad` is empty
an hour after any reviewer finishes.

## 150. A full nightly mutation sweep is infeasible as a single job: 25,665 (`api`) and 29,099 (`web`) mutants against a 5 h budget

Filed 2026-09-04, run 33776905012 (the first run after #644/#647): `shared` green in 20 min; `api` and `web` exhausted
18,000 s at ~23,000 mutants each, the estimate to completion ~33 h and ~16 h; the gate → "NOTHING was verified"; the 2.8 MB step summary
did not fit the 1 MB limit. The intermediate survivors (5,117 / 4,326) are real, but the current alert does not show them.
Direction (owner's decision): (a) a rotating subset — each night 1/N of the files from a deterministic list
(`MUTATION_ONLY_FILES` already exists), the whole repository in a week; (b) a matrix of shards by files within a single night (N × 5 h
in parallel — CI is free); (c) reducing the set of mutants (exclude `__tests__`, fixtures, `*.gen.ts`, mutator
levels) — measure how much that gives; (d) an alert with a partial result: "checked X of Y, Z survived" instead of
"nothing"; (e) a summary — truncated to the limit with a link to the artifact. Check: the nightly run ends green/red on
the merits, not on the budget; every file is covered within 7 nights.

## 151. A fix instruction from a review itself became a regression: "truncate to the first line" was applied to all output

2026-09-04, #650 SR-M-6: the first security round prescribed masking/truncating signal-cli output for error channels; the coder
applied truncation to any stdout — `--groups` prints one group of three, the "version is too old" detection goes blind with a
stderr line before the message. The reviewer acknowledged authorship of the wording. A lesson for `review-findings-transfer.md`: a finding
names the **channel and the invariant** ("the e-mail/alert must not contain the number"), not the mechanics ("truncate to the first line");
the executor chooses the mechanics, and the second-round reviewer checks the invariant, not the execution of their own hint.
Check: fix tasks contain no lines like "do it this way: <mechanics>" without the invariant it enforces.

## 152. A new test script that nobody runs — the third case in a month

#650 SR-M-7: `tests/test_verify_release_signature.sh` (a guard on a HIGH) was not executed by pytest, nor by the image stage, nor by
`run-guard-tests.sh`, nor by CI. Precedents: the 42 cases of `cross-agent-hooks-smoke.sh` (#625), the nightly `mutation-nightly` red for
20 days. Direction: a meta-guard "every `test-*.sh`/`test_*.sh` file in the repo is mentioned in some runner/workflow"
(extend `check-guard-tests-exist.sh` beyond `scripts/devops/tests`). Check: a new `.sh` test without a runner → CI red.

## 153. Runner network failures knock down a required check unrelated to the diff

2026-09-04 night: `E2E (drop-lifecycle)` on #649 — three `docker pull postgres:16-alpine` timeouts; `pnpm audit gate` on #650 —
three 60 s attempts with no registry response → `Typecheck · Lint · Unit Tests` red (required). Both cases were "restart the
job", both cost a full round of waiting and a manual restart. Direction: (a) move `pnpm audit` into a separate
non-required job with an alert (an advisory is essentially not a property of the diff); or a retry with a larger budget and `neutral` when
the registry is unavailable + an alert in telemetry; (b) service containers: `docker pull` with retry is already built into GitHub (3 attempts) —
cache the postgres image in the repository's GHCR mirror (`ghcr.io/<owner>/postgres:16-alpine`) so as not to depend on Docker Hub.
Check: a week without manual `gh run rerun --failed` for network reasons.

## 154. A smoke test that cannot fail: `--version` under the hardening profile

2026-09-04, #650 SR-M-9: the CI smoke ran `signal-cli --version` via `--entrypoint` (bypassing the entrypoint script) —
the only subcommand without native libraries; meanwhile the real daemon under the same profile crashed on `Can't load library`
from a `noexec /tmp`. The smoke was green by construction. A lesson for the collection "a mechanism confidently reports what it did not check":
a smoke must go the same way as prod (entrypoint + the same command/subcommand as in prod), and have a known
red case (proof that it can fail at all). Check: in the smoke's PR body — the output of the red run before the fix.
Related: the premise "environment variable X is read as system property Y" (TMPDIR ≠ java.io.tmpdir) — verify the fact by
a run, not from memory; this is already the third case in a day where a fix relied on an unverified premise.

## 155. The "quiet window" before push via a `pgrep -f` substring — two waiting agents block each other

2026-09-04: the push discipline (wait until `pgrep -f 'husky/pre-push'` is empty) does not converge with two agents: the command line of
another's wait-loop contains the same substring. Found by the #648 coder on the 12th attempt. The fix — anchored patterns
(`\.husky/pre-push`, `vitest\.mjs run|vitest/dist/workers|@stryker-mutator`). The real solution is item 140 (scoping
pre-push by diff): the queue behind the window disappears together with the full run. Until 140 is done — patterns in task files.

## 156. Outside the diff of #648 — two manual-qa findings (OOS-1, OOS-2)

Source: issuecomment-5540201417 on PR #648. Excerpt:

> - **OOS-1:** `ProjectShareInfo` (the project "Overview" card, `$projectId.tsx`) computes the displayed percentage only from `seniorSharePercentOverr
> - **OOS-2:** The team edit dialog (`/team/:teamId`) — the Telegram field (`type="url"`, expects `https://t.me/...`) for \*\*all 4 seeded teams with

## 157. `core.hooksPath` is an absolute path into the main checkout: all worktree pushes run the MAIN checkout's hook, and it lags behind main

2026-09-04: after the merge of #653 (scoped pre-push) a push from a worktree still ran the full suite — `git config core.hooksPath`
= `/…/CheekyCheeseIT_CRM/.husky/_` (absolute), and `h` runs `$(dirname $(dirname $0))/pre-push` — the main checkout's file,
which sat on `main` at 83b27a1c (dozens of commits behind). "The hook in main" enabled nothing until the main `main` was
pulled up (`git merge --ff-only origin/main`). Related: `pnpm install` in any worktree rewrites `hooksPath` to that
worktree's path (husky), and after its removal hooks break for everyone (memory `project_worktree_provisioning_gotcha`).
Direction: (a) the `h` wrapper hook must take `.husky/pre-push` from the **current** worktree (`git rev-parse --show-toplevel`),
not from the `hooksPath` directory; or make `hooksPath` relative (`.husky/_`) — check how git resolves a relative
hooksPath in a worktree; (b) in `light-track.md`/`agent-isolation.md` — a step "update the main checkout after merging changes to
hooks". Check: change a hook in a branch, push from a worktree — the log shows the new hook's line without updating the main checkout.

## 158. Subagents of one session share the orchestrator's scratchpad — reviewers' checkouts collide, and the hook won't let them clean up

2026-09-05, PR #646 round 4: spec-reviewer and security-reviewer, launched from the same session, both made a checkout at
`…/<session>/scratchpad/checkout-r4` — the path matched because the harness hands subagents the **parent** session's
scratchpad, not a personal one. The second saw "already exists, clean" and carried on in it; there were no mutations, so it got away with it —
but this is the collision from `agent-isolation.md` §3 (path not derived from the agent's identifier), only the source is not an absolute
path in the prompt but a shared scratchpad. The second half of the same trouble: `cross-agent-blast` only recognises as "own" the worktree
issued at dispatch, and denies a reviewer `git worktree remove` on their own scratch checkout — more than twenty of them
piled up over the session (`git worktree list | grep scratchpad`), and the cleanup falls on the owner.
Required behavior: the checkout name includes a unique token that the agent obtains itself
(`mktemp -d "$SCRATCH/checkout.XXXXXX"`), and the agent refuses to work in a checkout it did not create; the hook treats as
"own" a checkout whose path lies in the current session's scratchpad and whose `.git` file points to the shared repository.
How to verify: two read-only reviewers of the same PR from the same session → `ls $SCRATCH` for each shows different directories;
`git worktree remove` of one's own scratch checkout passes without denial.

## 159. Signal "+": the third alert channel (issue via `post-merge-alert.sh`) is unreachable from the container

2026-09-06, first `--now` on the VPS: `could not invoke /opt/crm/scripts/devops/post-merge-alert.sh: [Errno 2] No such
file or directory`. `signal_plus/alert.py` (layer 3) calls the host script by absolute path, but runs inside the
container, where `/opt/crm` is not mounted and there is neither `gh` nor a PAT. The layer is meant to "read opportunistically", but it prints
ERROR on every alert trigger. Options: (a) mount the script + `gh` + `GH_TOKEN`/`ALERT_REPO` into the container —
heavy and widens secrets; (b) enable the layer only when the file and env are present, otherwise stay silent at DEBUG; (c) call the
GitHub API directly from Python when a token is present. Recommendation — (b) now, (c) if the issue channel is actually needed. Related:
the owner has been offered layer 2 (`SIGNAL_ALERT_RECIPIENT` = their own number, a message to themselves) as a channel with no new secrets.
How to verify: `docker compose run --rm -e HANDOVER_TIME=00:01 signal-plus signal-plus --now` after 00:01 Kyiv — the log
has no line about `post-merge-alert.sh`.

## 160. Signal "+": the README link command did not work, and the minimal secret composition is recorded nowhere

2026-09-06: `sh -c 'signal-cli link …'` from the README failed with `signal-cli: not found` — the binary is not in the container's PATH; the working
form is `"$SIGNAL_CLI_BIN" -Djava.io.tmpdir="$SIGNAL_TMPDIR" link -n server-plus …` with a fallback to
`/opt/signal-cli-pinned/signal-cli`. Then `--groups` failed with `ConfigError: SIGNAL_CLI_BIN is required`: the secret
`SIGNAL_PLUS_ENV` carried only the number and the group, while `config.py` also requires `SIGNAL_CLI_BIN` and `STATE_FILE`; the deploy writes
`.env` as is and does not validate its composition, so the error only surfaces on the wrapper's first run. Incidentally the owner overwrote the secret
with an empty string (`ssh … | gh secret set` with ssh failing) — the deploy fails loudly on this, but only on the next run.
Required behavior: the README and the runbook list the minimal secret composition; the `write-env` step in
`deploy-signal-plus.yml` checks the required keys (`SIGNAL_ACCOUNT`, `SIGNAL_GROUP_ID`, `SIGNAL_CLI_BIN`,
`STATE_FILE`) and fails naming them; the link command in the README is the working form above. How to verify: a secret without
`STATE_FILE` → the deploy is red at `write-env`, not green with a dead container.

## 161. Label-triggered auto-merge does not deploy `signal-plus`; also — `status` is read-only in zsh

2026-09-06, PR #660: the squash via `merge-approved` runs under `GITHUB_TOKEN`, no push event is born (the known
anti-recursion), and `auto-merge-on-label.yml` explicitly dispatches only `deploy.yml` and `ci.yml`. So
`deploy-signal-plus.yml` did not start after the merge of #660: the Sunday-rule code sat in main, while the VPS ran the
old image until the orchestrator triggered `gh workflow run deploy-signal-plus.yml --ref main` by hand.
Required behavior: if the merged PR touched `services/signal-plus/**` or `deploy-signal-plus.yml` itself,
auto-merge dispatches it too (via `gh pr view --json files`), or `deploy-signal-plus.yml` listens to the auto-merge `workflow_run`
with a path filter. How to verify: merge by label an edit to `services/signal-plus/README.md` —
`gh run list --workflow deploy-signal-plus.yml` shows a run on the merge commit.
A related small thing for monitors: in zsh the variable `status` is read-only — a script with `status=$(...)` dies silently
(`read-only variable: status`), the #660 merge monitor died exactly that way; name it differently.

## 162. The project row grid at 320 px collapses the name, senior and junior (QA-H-4 on #646, exists on main)

2026-09-06, manual-qa r4 on #646: at exactly 320 px the five-track `ProjectRow` grid (no breakpoints on main) squeezes
the name/senior/junior columns almost to zero — company "A…", senior "C", the junior shows a bare dot. Reproduces on the "Active" tab
on an untouched seed project, i.e. before the #646 feature; the `project-status-filter` spec §11 forbade touching the
grid in that PR, so five rounds only fixed the status column. The copy reviewer and the designer flagged the same since round 3.
Required behavior: below `lg` the row is a card in a column (foundation.md §10, "table → card-stack"), without a grid of
five tracks; at `lg+` the grid stays as is. How to verify: `/projects` under any role at 320/375 — the company name and the names
read in full, touch targets ≥44×44. A separate task with the design gate Tier 2, not light-track.

**Addendum 2026-09-07 (UX-L-4(r7) on #646).** The label «Нет джуна» is truncated at 768/834 too, not only at 320 —
the same class of defect, a wider range. The designer showed by grid arithmetic that the junior column after #646 became wider
than on main (unconditional 8fr → conditional 7fr/8fr), so this is not a regression of the PR. Frames: branch
`screenshots/pr646-r7-designer`, `pr646-r7-copy-l13-junior-col-834.png`, `pr646-r7-admin-active-junior-col-{768,834}.png`.
Check on closing the item: at 768 and 834 under ADMIN the junior column label reads in full.

## 163. The full `ProjectDto` goes to DROP through the approvals widget (SR-L-6 on #646)

`mapProject` masks `rate`/`notesGeneral`/`members[].email` only for JUNIOR, so DROP receives everything SENIOR sees for their
project, and the `PendingProjectApprovalsPanel` widget on the DROP dashboard pulls the full `GET /projects` for the sake of the
approvals list (it does not reach the persist — the key is outside the allow-list). Closed by item 7c (`task-pending-screen.md`):
the widget is moved to the narrow `GET /pending`. If 7c is postponed — narrow `mapProject` for DROP separately.
How to verify: under DROP the `/projects` response contains no `rate`, `notesGeneral`, `members[].email`.

## 164. `drop-distribution-edge.spec.ts` is not idempotent on a reused database

2026-09-06, observation by the #648 coder (fix round 2): a second run of the spec against the same scratch database gives 409 —
the share proposal is already open or confirmed by the first run; on a fresh seed it is green. A property of the scenario from
fix round 1 of #648: the step confirming the proposal by the senior was added without state cleanup. In CI the database is always fresh,
so it is not caught; locally it breaks repeated runs and masks real regressions by retry.
Required behavior: the scenario itself returns the project to its initial state (cancel or reset via the API in
`beforeEach`/`afterEach`) or takes its own project from a fixture. How to verify: two runs in a row on the same database are
green.

## 165. English-language pill `Override` on the project page (COPY-L-14 on #648, outside the diff)

Copy reviewer r3 of #648 (2026-09-06): on the project page next to the senior's share there is a pill with the English word
`Override` — exists on main, PR #648 did not touch it. The `russian-language.md` rule: all visible text is in Russian;
the product term is «личный процент по проекту» / «индивидуальная доля по проекту» (`CONTEXT.md`).
Required behavior: the pill in Russian with the same term as the share form's hints. How to verify:
`git grep -n '>Override<' apps/web/app` is empty; on the project page under ADMIN there is no word `Override`.

## 166. The pre-push hook runs tests against the working tree, not the pushed commit

2026-09-07, observation by the #648 coder (fix round 3): he edited files twice while `pre-push` was running, and the hook tested what
was in the working tree, not the contents of the commit going to origin. The result can be falsely red (an edit
broke a test that is not in the commit) and falsely green (an edit fixed what is broken in the commit).
Required behavior: the hook checks the pushed commit — either it refuses on a dirty tree (`git status --porcelain`
not empty → "commit or stash your edits"), or it runs the checks in a temporary checkout of the pushed sha
(`git worktree add --detach` in `$TMPDIR`). The first is cheaper. How to verify: make a commit, break a test in the working
tree without committing, `git push` — the hook either refuses because of the dirty tree, or passes on the commit's contents.

## 167. E2E specs from `KNOWN_UNSHARDED` are silently broken by branches

2026-09-07, observation by the #648 coder (fix round 4): a branch changed the behavior of the project override `PATCH` (it now
opens a proposal), and `team-share-override.spec.ts` went red — but CI does not run it: the spec is in the `KNOWN_UNSHARDED`
list of the shard guard `check-e2e-shard-coverage.py`. The breakage was found only by a local run. The same
list holds `senior-create-default.spec.ts`, which has been stale since PR #119: the spec waits for the `user-dialog-submit` button in
create mode, but the button has since rendered only when editing. The "known debt" list has turned into a
list of specs nobody runs.
Required behavior: either return these specs to the shards one at a time, fixing what got in the way, or run
`KNOWN_UNSHARDED` as a separate non-blocking job with an alert so the red is visible. How to verify:
`KNOWN_UNSHARDED` in `check-e2e-shard-coverage.py` is empty, or every spec in it has a job that runs it.

Addendum 2026-09-11 (coder of #664): `accountant-dashboard.spec.ts` cannot pass since 2026-06-21 (#268) — the spec waits for an `<h1>` inside `accountant-dashboard-hub`, but `AccountantDashboard.tsx` has no `<h1>` heading; the spec is in the shard guard's debt list, CI has been silent for three months. Check: the spec is outside `KNOWN_UNSHARDED` and green in its shard.

## 168. Tab label «На подтверждении» and badge «Ждёт решения» on the same page (COPY-L-11 on #646)

Copy r6 #646 (2026-09-07): the full filter label `STATUS_FILTER_LABELS.PENDING` = «На подтверждении» diverges from the
«Ждёт решения» / «ЖДЁТ ВАШЕГО РЕШЕНИЯ» family on the badges and in the widget of the same page; the short label «Ждут» is already
closer to the product than the full one. Required behavior: one name for one fact — the full label «Ждут решения».
How to verify: `git grep -n 'На подтверждении' apps/web/app` is empty.

Addendum 2026-09-12 (copy r1 on #670, COPY-M-2): (filter label «На подтверждении» ↔ «Ждёт решения»): copy r1 on #670 (COPY-M-2) counted five names for one state — nav «Ждут решения», list row and page badge «Ждёт решения», filter «На подтверждении»; the #646 metric (113.5 px) allows «Ждут решения» without overflow. The decision "not to do it in #670" — so as not to touch the filter spec in someone else's PR; close with a single edit of `STATUS_FILTER_LABELS.PENDING` + the spec.

## 169. Different breakpoint for full labels of the segmented filter: vacancies from 640, projects from 1024 (COPY-L-12 on #646)

The same `SegmentedToggle`: on `/vacancies` full labels from `sm` (640), on `/projects` after COPY-M-13 — from `lg`
(1024; chosen by the Linux font metrics in CI, where 768 and 800 gave a wrap). On one tablet two screens with different
policy. Required behavior: a single breakpoint for all segmented filters (probably `lg`, with
vacancies checked at 768–1023 under Linux metrics in CI). How to verify: both screens at 834 show labels
of the same length.

## 170. The guard-test gate fails on a PR body over 128 KiB

2026-09-07, PR #646: `guard-test-gate.yml` passes the PR body through an environment variable on the `actions/checkout` step, and
the runner dies with "Argument list too long" (`MAX_ARG_STRLEN` 131072). A body of 134,657 bytes took the gate down; re-running
the same run does not help — the event stores the old body, a new push is needed. Workaround for the moment: the round history
was moved into two archive PR comments. Required behavior: the PR body reaches the script as a file (write
`github.event.pull_request.body` to a file in a step after checkout or read `gh pr view --json body` there), not as
env on the checkout step. How to verify: a PR with a body over 130 KiB and a green `guard-test`.

## 171. Isolation incident: manual-qa started a run in the designer's worktree (#648, final round)

2026-09-07: the QA agent of the final round of #648 reported that it ran the first part of the run in the worktree and on the ports of the
designer of the same PR, then "after the harness cut off the response" continued in its own; it rechecked the report in its own worktree,
but read the foreign artifacts (`scratchpad/shots`, `scratchpad/pw`) as a lead. The `agent-isolation.md` mechanics (item 4,
item 7) worked only partially: the `cross-agent-blast` hook does not catch a `cd` into a foreign `agent-*` followed by running
scripts, and the `git rev-parse --show-toplevel` check is done once at start, not after a restart.
To find out: does this reproduce when the harness restarts the agent (resume in a foreign cwd), and is a `pre:bash`
predicate on `cd` into a foreign `agent-*` needed. How to check that it is alive: an agent report in which `Worktree:` does not match the
artifact paths.

## 172. Pre-push typecheck on a docs-only branch requires full worktree provisioning

2026-09-07: an attempt to push a single markdown file to the screenshots branch from a checkout with a `node_modules` symlink from a neighboring
worktree failed in `pre-push`: when root files change (even `docs/**`) turbo considers all packages affected and
runs typecheck, which needs per-package `node_modules`. For docs-only branches that is minutes of `pnpm install` for
zero code. Required behavior: pre-push scopes typecheck by the actually changed files the same way it already
scopes tests (#653): a diff without `.ts`/`.tsx`/`package.json`/lock — no typecheck needed. How to verify: a docs-only
commit is pushed from a checkout without `node_modules` in seconds and without bypassing hooks.

## 173. The docblock of `UsersService.archive` claims the opposite of what the code does (SR-L-6 on #662)

Security reviewer on #662 (rounds 1 and 3, 2026-09-07): the summary docblock of the `archive` method in `users.service.ts` says that
the cascade for SENIOR "sets leftAt for HR/Acc team_members", while the implementation and the inline comment AC7/AC9 fifteen lines
below say the opposite and call the former behavior "a deliberate removal, not a regression". It is exactly this (archiving a
senior does not close memberships) that gave rise to SR-M-1 on #662 — an archived senior made it to the HR selector. Risk: a maintainer
who trusts the summary will decide that `getAccessibleSeniorIds` already cuts off the teams of archived seniors, and remove the
`notArchived` predicate in `getBoardSeniors`, reopening the leak.
Required behavior: the docblock describes what the code does, or the code does what the docblock promises — decide explicitly.
How to verify: `git grep -n "sets leftAt" apps/api/src/users` is empty, or there is a test next to it that confirms it.

## 174. Impersonation does not clear the query persist, unlike logout (SR-L-5 on #662)

Security r2 on #662 (outside the diff): `login-as.tsx` does `queryClient.clear()` and a reload, while `useLogout` additionally
deletes the IndexedDB key `crm-query-cache`. The persist is throttled, and a dump of the ADMIN cache (`projects`,
`interviews`, …) that survived navigation may rehydrate already in the impersonated session. There is no leak today (ADMIN → non-ADMIN in the
ADMIN's own browser), but the two session-change paths are inconsistent, and the cost grows with every new prefix in the persist allow-list.
Required behavior: one shared "reset the session" step for logout and impersonation. How to verify: after "log in as"
there is no `crm-query-cache` key in IndexedDB until the first request of the new session.

---

## Added 2026-09-12 — rounds of #664 (item 6) and #667 (item 7c), items 175–200

## 175. MCP tools inside subagents hang and the agent is killed by the watchdog

2026-09-07: six agents in a row taken down with "Agent stalled: no progress for 600s"; the coder of the 7c API half managed to record the cause: `mcp__codegraph__codegraph_explore` hung for 30 minutes. Earlier, by the same picture, `mcp__eslint__*` and `mcp__playwright__*` were ruled out. Until the cause is found (does the codegraph MCP server index worktree duplicates? an SQLite lock? — see `project_codegraph_adoption`), dispatch prompts and `pm-snippets.md` must forbid all MCP in subagents, and the `mcp-first.md` rule must stipulate an exception for subagents. Required behavior: an MCP call with a timeout (≤60 s) and an error instead of infinite waiting; or a codegraph server that does not block on parallel worktrees. Check: `codegraph_explore` from a subagent in a worktree returns an answer or an error within a minute.

## 176. The `pnpm audit` gate turns the required check red on all PRs when new advisories appear

(2026-09-11: `vitest`/`@vitest/mocker` GHSA-82fw-gwwq-j7x9 fixed in 4.1.11 with the pin at 4.1.8; `@xmldom/xmldom` fixed in 0.8.15). The lockfile did not change, the step was green four days ago — i.e. the gate goes red from the calendar, not from the diff, and blocks other people's PRs. Required behavior: new advisories unrelated to the PR's diff must not turn the PR's required check red — either the gate compares against the main baseline (reddens only what is new relative to main), or the audit lives as a separate job/nightly run with an alert, and on the PR — only a regression relative to main. Check: a PR with no changes in `package.json`/the lockfile is green with a fresh advisory.

## 177. Three inherited discrepancies in identity masking (security r1 on #664, SR-L-3, not in the review body):

(1) `TEAM_NEW_MEMBER` gives the senior the drop's `displayName` — `mapTeam` already reveals it, `mapProject` does not; (2) a drop in a drop team can learn the name of a junior that `mapDropTeam` hides; (3) `ProjectsService.createDraft` writes `proposedByUserId: currentUser.id`, whereas the author filter uses `impersonatorId ?? id`. All three predate #664; one explicit "who sees whom" contour is needed for teams, like `mapProject` for projects. Check: tests "a senior does not see the drop's displayName in the notification and in `GET /teams`", "a drop does not see the junior's name", "impersonated ADMIN — author = impersonator".

## 178. `docker-compose.prod.yml` (dormant profile `selfhosted-s3`) pulls `minio/minio:latest` and `minio/mc:latest`, which no longer exist — CLOSED 2026-09-24 (#709)

**Closed:** the MinIO images became unavailable on quay.io too (2026-09-24); by the owner's decision MinIO was removed from the project entirely, the dormant `selfhosted-s3` profile was removed from `docker-compose.prod.yml`, the CI/dev S3 stand is RustFS (#709). The text below is historical.

The images are no longer on Docker Hub (MinIO stopped publishing community images 2025-10; #668 pinned `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` and `quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z` in CI and dev-compose). Prod is on R2, the deploy pulls only `api nginx`, so it is not an incident now; but enabling the profile will fail on pull. Behavior: the same pin in prod-compose; check — `git grep -n 'minio.*latest' docker-compose.prod.yml` is empty.

## 179. `@xmldom/xmldom` 0.8.15 breaks two resume-extraction specs — the bump is postponed by audit exceptions

Version 0.8.15 breaks two resume-extraction specs (`resume-text-extraction.service.spec.ts`, `resume-render-responsiveness.spec.ts` — the test relies on quadratic behavior that GHSA-8344-3jmq-59r6 is precisely fixing); #668 recorded nine GHSAs in the audit exceptions with a justification. Behavior: bump to ≥0.8.15 together with an edit of the two specs (AutoTest zone) and removal of the exceptions. Check: `pnpm audit` with no xmldom entries in `pnpm-audit-exceptions.json`.

## 180. `apps/api/tsconfig.spec.json` is part of no gate and carries ~448 inherited errors

(fix round 2 of #664): that is exactly why a duplicate import (TS2300) in two integration specs survived until review — esbuild/Vitest collapses it, `pnpm typecheck` does not see the specs. Required behavior: either the specs are typed cleanly and the config is wired into the CI typecheck, or the config is deleted so as not to create an illusion of checking. Check: `pnpm --filter @crm/api exec tsc -p tsconfig.spec.json --noEmit` → 0 and there is a step in `ci.yml`.

## 181. `resume-render-responsiveness.spec.ts` measures the machine, not the code

(same round; caught by DevOps on #668 and by the API coder of #667): absolute thresholds in milliseconds turn pre-push red under parallel agent work (LA 30–130), green on a free machine. Behavior: comparison with a baseline measurement in the same run (a relative threshold) or a skip when `load average` is above a threshold with explicit `skipped` output. Check: three pushes in a row with parallel agents without false redness.

## 182. 23 `NoCoverage` of the mutation gate on #664

22 — the resolver of notification-object existence, covered only by a realdb spec (the gate by construction does not execute it), 1 — the `onClick` of the delete button in `notifications-bell.tsx` (E2E). Per `mutation-gate-integration-specs.md`, thin unit doubles around the same branches are needed. Check: `no-coverage` for these files → 0 without suppressions.

## 183. `scripts/devops/mutation-gate.mjs` contains a literal `\0` byte — `grep` treats the file as binary

(integrator of #667, 2026-09-12; the same defect was in `pending.service.ts` and replaced by an escape sequence): for `grep` the file is "binary", a search over it stays silent. Behavior: no raw NULs in the sources — only `\0` as an escape. Check: `git grep -I --name-only -P '\x00'` is empty (or `grep -rlP '\x00' scripts apps packages` is empty).

## 184. The default `MUTATION_BUDGET_SECONDS=900` silently cuts off the web stage of `pnpm mutation:changed` on a large diff

On a large diff (integrator of #667: the first run died on the budget, a full one requires `MUTATION_BUDGET_SECONDS=7200`). The cutoff must be loud and distinguishable from `PASS`; the local default budget should be raised or computed by the number of mutants. Check: a run with an insufficient budget ends with an explicit `BUDGET EXCEEDED`, not "PASS" and not silence.

## 185. `notifications-popup-overflow.spec.ts` (mocked-auth) does not pass against the dev proxy on non-standard ports

On the integrator's stand `notifications-bell-trigger` was not found even on `origin/main` (isolation by file substitution). The spec is tied to the default `localhost:3000/3001`; agents bring stands up on 30xx. Behavior: the spec reads addresses from `baseURL`/env, like its neighbors. Check: the spec is green with `API_PORT=3084`/web 3085.

## 186. The legacy producer of `INVOICE_SIGNED` can give a 500 on an already-signed invoice (security r3 on #664, outside the diff)

(security r3 on #664, outside the diff): the title is assembled as `<displayName> подписал инвойс`; `display_name` is `varchar(255)`, the `notifications.title` column is also `varchar(255)`, a long name overflows the title, `create()` throws after the signature has been recorded and the document redirected — the client gets a 500 on a successful operation. Behavior: the producer through the `emitInTx` seam (savepoint, like the ten new types) and truncation of the title by code points. Check: signing an invoice by a counterparty with a 255-character name → 200, the notification is either truncated or skipped with an ERROR in the log.

## 187. A load error of the team overrides is swallowed under the share figure

(security r1 on #667, SR-L-2): `loadTeamOverridesForSeniors` in `PendingService` does `.catch(() => [])` — a mirror of the existing pattern `ProjectsService.loadTeamOverridesBySenior`; when the query fails the share resolves without the team override, and the person sees a wrong percentage under the «Подтвердить» button. The form was chosen under the Stryker constraint. Behavior: a failure to load overrides is a response error (or an explicit "share unavailable"), not a silent default; fix both places in one PR. Check: a test "the override query fails → response 5xx/field `viewerSharePercent: null` with a reason", not a number.

## 188. The project page shows the badge «Активный» for `DRAFT` and `REJECTED` (manual-qa r1 on #664, confirmed from main's code)

(observation of manual-qa r1 on #664; the badge in `$projectId.tsx` is derived only from `archivedAt` — «Активный»/«В архиве», the approval status does not participate; #646 added a banner and decision buttons to the page but did not touch the badge). A light-track candidate right after the merge of #667 (the file overlaps). Behavior: the project page badge repeats the list status (`DRAFT` → «Ждёт решения», `REJECTED` → «Отклонён», `ACTIVE` → «Активный»). Check: under ADMIN open a draft — the badge is not «Активный»; a unit test of the status mapping on the page.

## 189. "Open project" on an already-rejected draft

(QA-L-1 on #664): the confirmer is redirected to the dashboard without explanation — the `REJECTED` project is not in `visible_projects` for them. Behavior: the route guard shows «Черновик отклонён» (or the notification degrades per §7.4 to «Проект отклонён» without a button), not a silent redirect. Check: SENIOR opens the notification for a rejected draft → sees the explanation.

## 190. Notification registry: branching by `subjectType` and by `type` — two maps of one fact

(security r4 on #664, outside the review body): `loadExistingIds` degrades the contract by `subjectType === 'EMPLOYEE_CONTRACT'` and the status `READY_TO_SIGN`, while `notificationActions` — by `type === 'DOCUMENT_SIGN_REQUIRED'`; the next type with the same kind of object will silently inherit "degrades until READY_TO_SIGN" and the label «Контракт удалён». Behavior: in the registry an explicit map `type → subjectType → existence rule`, the single branching point; the compiler catches a new type (`never`). Check: adding a type with `subjectType: 'EMPLOYEE_CONTRACT'` without an entry in the map does not compile.

## 191. `whitespace-pre-wrap` on notification details makes line breaks in untrusted text (the rejection-reason preview) significant

Safe today (React text, `line-clamp-2`), will become significant if `detail` is rendered without a clamp or substituted into an email (item 7a). Behavior: the preview collapses spaces/line breaks into a single space on the server when truncating. Check: a reason with ten line breaks → one line in the popup and in the email.

## 192. Three copies of amount formatting

(code r4 on #664, CR-M-3): `apps/web/app/lib/format-amount.ts#formatAmount`, `apps/api/src/invoices/invoices.service.ts#formatAmountForNotification` and `money()` in the notification registry of `@crm/shared` — one formula (ru-RU, two decimals, thousands space). Behavior: one function in `@crm/shared`, web and api import it. Check: `git grep -n "minimumFractionDigits: 2"` gives one definition.

## 193. The "remove share override" notification does not show the effective percentage

(copy r2 on #664, COPY-L-4): «30% → не задана», whereas the screen shows `effectivePercentAfterApproval`. Behavior: the producer puts the effective percentage after confirmation into `data`, the text — «30% → 25% (по умолчанию)». Check: the notification and the screen name the same number.

## 194. Race of the client-side onboarding redirect in `_authenticated/route.tsx` (manual-qa r2 on #664, outside the diff)

(manual-qa r2 on #664, outside the diff): the redirect to the wizard lives in a `useEffect` after the status response, so child routes and widgets manage to mount and hit the API before the redirect (403 `ONBOARDING_REQUIRED` in the console/network). Behavior: the onboarding status is resolved in the route's `beforeLoad`/loader before the tree renders. Check: a user in onboarding opens `/` — not a single request to `/api/pending`/`/api/notifications` before the redirect.

## 195. `cascade-impact-panel.test.tsx` is nondeterministic under a full parallel run

(coders of #667 r3 and #664 r2/r5, DevOps #668 — four independent observations on pushes under load): fails on different cases (CP-7; CP-28+CP-29), in isolation 41/41, the full web suite separately — green; in the DOM snapshot `data-scroll-locked` on `<body>` — a leaked Radix overlay of a neighboring test. Behavior: the test is isolated from its neighbors (cleanup of the overlay/`scroll-lock` in `afterEach`, or `test.sequential`/a separate file), green with `--threads` under load. Check: three full `@crm/web` runs in a row at LA > 30 without failures of this file.

## 196. `pnpm test` from the root pulls the full E2E on `localhost:3000/3001`

(coder of #664 r5 ran it accidentally: hundreds of `ECONNREFUSED`, and with a live stack on the default ports it would have hit it): the root script must not include `@crm/e2e` by default — E2E is run explicitly (`pnpm --filter @crm/e2e test`). Check: `pnpm test` in the root does not bring up Playwright.

## 197. A new unconditional request in the layout breaks all mocked-auth specs with a redirect to `/login` (#667, fix round 5)

The nav badge «Ждут решения» sends `GET /api/pending` on every authenticated page; `mockAuthAs` did not mock it → the request went to the real API without a cookie → 401 → the axios interceptor sends the user to `/login` in the middle of a click. The shard `E2E (drop-finance)` was red on every PR head, the other shards were cancelled by fail-fast and never checked, and the redness was considered "a flake outside the diff" for three rounds. Closed with a mock in fix round 5, but the class of defect repeats (the same scenario for `/notifications` is described in the fixture itself). Behavior: a guard — a test that brings up a page under `mockAuthAs` and fails on any request that went past the mocks (`page.on('request')` to `API_RE` without a handler), or fail-fast in CI is turned off for E2E shards so a red shard does not hide the rest. Check: a new `api.get` in `nav-sidebar`/`notifications-bell` without a mock → red guard before CI. Diagnostic lesson: verify "a flake outside the diff" by correlating mock/real login over the list of failed specs, not by a rerun.

## 198. `pending.spec.ts` (#667) is flaky with `--workers>1`

The tests share one seed SENIOR, neighboring cases create/delete his projects between reads of the nav badge — the badge assertion fails both ways (`Expected 2/Received 1`, `Expected 0/Received 1`); with `workers=1` (parity with CI) 8/8. Proven by isolation on the pre-round head (coder r4). Behavior: each test — its own SENIOR/projects from a fixture (as in the `drop-*` specs), no shared state. Check: `--workers=4 --repeat-each=3` is green.

## 199. The degraded "Ждут решения" row for an unknown `kind` does not say what to do

(copy r3 on #667, COPY-L-7, LOW — the reviewer did not insist; postponed so as not to run the gates again in the merge window): on a client/server version mismatch the person sees «Запрос на действие · N минут назад» without buttons and without advice. Behavior: a second line in the same style as «Доля неизвестна. Обновите страницу.», — «Обновите страницу, чтобы увидеть подробности.» (a reload pulls a bundle that knows this kind). Check: a response with `kind: 'FUTURE'` → a row with the hint, the other rows intact.

## 200. `resumes-rbac.integration.spec.ts` («finished PDF is served from storage») fails in CI on a docs-only commit

(#667, head `0a789508`, job `Integration Tests (Postgres)`; on the previous head with the same code — green): `getRenderedPdf` returned `ready: false` — the render queued by the save had not finished by the time of the read; the test waits for completion by time, not by event/state polling. The resume autosubmit code is paused — do not fix the product, fix the test. Behavior: the test waits for `ready: true` by polling with a timeout (or explicitly drains the render queue), not by a single read. Check: five runs of the file in a row on a loaded runner without failures.

---

## Added 2026-09-12 (evening) — #670 (project status badge) and the merge of #664/#667, items 201–204

## 201. The project page shows «Отклонён» without a reason and «Ждёт решения» without "whose" (COPY-M-3 on #670)

(copy r1 on #670, COPY-M-3): the list row under ADMIN shows both the rejection reason and "from {senior}", while the project card after #670 — only the status word. The data is already in `ProjectDetailDto` (`rejectionReason`, `seniorApprovalPending`, `dropApprovalPending`). Behavior: next to the status badge — the rejection reason (for those to whom it is visible in the list) and who has not yet decided. Check: ADMIN opens a rejected project → sees the reason; a draft → sees whose decision is awaited.

## 202. "Drop-проект" next to "Rejected" — role in Latin letters vs. the glossary's «Дроп» (COPY-L-1 on #670)

(copy r1 on #670, COPY-L-1, outside the diff): the project header badge writes the role in Latin letters, while the `CONTEXT.md` glossary says «Дроп»; the English word drop ("to discard") next to the red neighbour reads as a second rejection. Behaviour: «Дроп-проект». Check: `git grep -n 'Drop-проект' apps/web` is empty.

## 203. Project status visuals are duplicated between `ProjectStatusBadge.tsx` and `ProjectRow.tsx` (CR-L-1 on #670)

(code r2 on #670, CR-L-1, LOW): the Tailwind colour classes and icon choice (`Clock`/`XCircle`) for `DRAFT`/`REJECTED`/archive are repeated literally in two files, the only shared source is a comment. Behaviour: a single function `projectStatusVisuals(status)` (colour + icon + label) imported by both the list row and the page header. Check: `git grep -n 'lucide-clock\|amber-500/10' apps/web/app/components/projects` yields one definition.

## 204. Integration specs assemble services by hand and break when a constructor changes in a neighbouring PR

(2026-09-12: `pending.integration.spec.ts` from #667 failed on the merged branch of #664 with `Cannot read properties of undefined (reading 'emitInTx')` — #664 added `NotificationsService` to the `ApprovalsService` constructor; seven other specs already carry `makeNotificationsStub()` — i.e. the same fix is repeated file by file). Neither pre-push (scoped by diff) nor the merge coder (ran only the `notifications` specs) saw this — CI caught it. Behaviour: one test-service factory (`buildApprovalsService(db)` / `buildProjectsService(db)` in `__test-helpers__`) imported by all integration specs, so that a new dependency is added in one place; plus a rule for the merge coder — run the full `integration.spec` on a scratch database, not just the module of their own PR. Check: `git grep -n 'new ApprovalsService(' apps/api/src --include='*.spec.ts'` yields one place — the factory.

---

## Added 2026-09-13 — deferred from #673 (position 7a), items 205–208

## 205. An impersonated ADMIN changes an employee's channel settings with no trace (SR-L-3 on #673)

(security r1 on #673, SR-L-3, LOW): `PUT /notifications/preferences` takes `userId` from the session, and under "log in as" the session is the employee's; `locked` types are protected, the rest are changed on behalf of the employee with no "who" record. Behaviour: impersonation audit — either forbid changing settings under impersonation, or record `impersonatorId` in the log; decide together with the general impersonation trail. Check: under "log in as", toggling a channel is either 403 or an audit row with two ids.

## 206. Third-party actions in `deploy.yml` are pinned by tag, not SHA (SR-L-5 on #673)

(security r1 on #673, SR-L-5, LOW; the convention of the whole file): a moved tag is a supply-chain risk. Behaviour: all third-party actions in workflows pinned by full SHA with a version comment, in one PR. Check: `grep -nE 'uses: .*@v[0-9]' .github/workflows/*.yml` is empty.

## 207. Four Russian `logger.*` strings in `notifications.service.ts` (COPY-L-7 on #673, from #664)

(copy r2 on #673, COPY-L-7, from #664): per the `russian-language.md` rule, log strings are in English (173 precedents). Behaviour: translate the four strings in one commit. Check: `git grep -nP '(logger|this\.logger)\.(warn|error|log)\(.*[А-Яа-я]' apps/api/src` is empty.

## 208. The "action-required" email goes out without checking that the approval is still current (assumption A1 on #673)

(position 7a, orchestrator's assumption A1 on #673): the cron sends the "action-required" email as is, even if by the time of the tick the proposal has already been withdrawn/decided (`notification-subject-resolver.ts` can tell these apart for the popup). Behaviour: before `send`, resolve the object's state with the same resolver; withdrawn/decided → `SKIPPED/STALE` (a new reason code). Check: propose a share → cancel before the tick → row `SKIPPED/STALE`, no email.

## Added 2026-09-19 — tails of the notifications epic (#677, #678) and the 2026-09-13 session, items 209–214

Closed in these same PRs: 168 and 201 — #677 (the "Ждут решения" label, approval caption in the project header);
205 and 208 — #678 (notification settings under "log in as" are view-only; `SKIPPED/STALE` before sending).

## 209. Background wait loops of subagents outlive the agent and pile up in the orchestrator's session

(observation 2026-09-12/13 and 2026-09-19: in a day, up to seven dead `until … sleep` loops from fix-round coders — "Wait for mutation gate", "Collect unit suite numbers" for 5–13 hours; the owner asked twice to clean them up). Mechanics: the coder starts the mutation gate or a suite in the background and waits with a loop `until ! pgrep -f mutation-gate.mjs` (catches its own command by substring — never terminates) or `until grep … <log in the worktree>` (the worktree was removed by the harness after the agent finished — the file is no longer appended to). The harness removes the worktree but not the agent's processes. Behaviour: (1) in `pm-snippets.md` and coder prompts — wait by PID (`wait <pid>` / `kill -0 <pid>`), not by `pgrep -f` substring, and kill your own background commands before the final report; (2) a cleanup script after the agent finishes — kill processes whose `cwd` or command points at its worktree or whose log lies in a removed directory (model — `reap-zombie-devservers.sh`; Architect zone). Check: an hour after a coder finishes, among the descendants of the claude process there is no `until … sleep` older than ten minutes.

## 210. Query persistence stores `GET /projects/:id` whole — with `effectiveTeam` and participants' e-mails (SR-M-1 on #677)

(security r1 on #677, SR-M-1, pre-existing): the `projects` prefix in `PERSISTED_KEY_PREFIXES` (`__root.tsx`) also covers the page key `['projects', projectId]`, so the `findOne` response goes into the IndexedDB `crm-query-cache`, although the allow-list comment explicitly forbids persisting team member data (that is why `teams`/`team`/`user-team` were removed from it). Behaviour: the project list is persisted, the detail page is not (a separate prefix for `findOne` outside the allow-list, or `shouldDehydrateQuery` by key length); a pin test in `persisted-key-prefixes.test.ts` via the real `shouldDehydrateQuery`. Check: after opening a project page there is no `effectiveTeam` in IndexedDB.

## 211. Auto-merge by label does not deploy signal-plus — confirmed from the code (addendum to 161)

(2026-09-19, manual deploy of #676): `auto-merge-on-label.yml` after the squash does `gh workflow run deploy.yml` and only that; `deploy-signal-plus.yml` listens to `push: main` with `paths:`, and a squash under GITHUB_TOKEN produces no push events. Behaviour: in the "Dispatch production deploy" step — if the squash contains `services/signal-plus/**` or the workflow itself, additionally `gh workflow run deploy-signal-plus.yml`. Check: merging by label a docs edit in `services/signal-plus/README.md` → a `deploy-signal-plus.yml` run with `event=workflow_dispatch` appears.

## 212. Decisions on approvals under "log in as" are not restricted in any way (SR-L-2 on #678) — owner's decision

(security r1–r3 on #678, SR-L-2, LOW; A3 — money and shares): after #678 notification settings under impersonation are view-only, while `approve|reject` for a share (`senior-share-routes.ts`) and for a project do not check `impersonatorId` — an admin under "log in as" can confirm or reject on behalf of an employee with no trace. Behaviour — per the owner's decision (question in the decision brief): either forbid (403 as for settings), or allow with `impersonatorId` recorded in the approval row or in an audit. Do not create a task until answered. Check: under "log in as" `POST …/approve` → 403 or an audit row with two ids.

## 213. Project header at 320: a long rejection reason reads as a column (COPY-L-4 on #677)

(copy r3 on #677, COPY-L-4, LOW, pre-existing): a text column of ~150 px next to a 56 px avatar; a 200-character rejection reason makes 11 lines. The "avatar + column" layout existed before the PR; #677 fixed 640–1023 (header stack up to `lg`), left the mobile width untouched. Behaviour: on mobile the avatar above the text, or smaller, so that the reason takes the screen width. Check: `/projects/:id` of a REJECTED project with a reason of 200+ characters at 320 px — the reason is not narrower than 80% of the header width.

## 214. `TelemetryErrorsService.recordError` does not sanitize `meta` (SR-L-5 on #678)

(security r3 on #678, SR-L-5, LOW, a telemetry property): `recordError` trims and cleans `message`/`stack`, but puts `meta` in raw and `mapErrorRow` hands it out to the digest; the safety of `meta.reason` rests on callers' discipline (`safeErrorReason` on the Resend path, a fixed string on the `decideDelivery` path), not on mechanics. Behaviour: string fields of `meta` go through the same `sanitizeAndTruncate` inside `recordError`. Check: `meta.reason` with an e-mail and 10 KB of text → the telemetry row has no address, the length is bounded.

## Added 2026-09-19 (evening) — #680 (decisions under "log in as") and the i18n audit, items 215–221

Context: on 2026-09-19 the owner decided that under "log in as" an admin does not make decisions on behalf of an employee; #680 closed the contract,
terms of use and invoice (share and project were closed earlier). Below is what review found nearby and what did not make it into the PR.

## 215. Denials under "log in as" on consent paths leave no trace (SR-L on #680)

(security r1/r2 on #680, LOW): the 403s for share, project, contract, terms and invoice are not written to the audit — an admin who tried to decide for an employee is invisible. Behaviour: one audit record "denial: actor, target, path" for all five paths, from one helper. Check: an attempt under "log in as" → an audit row with two ids and the path name.

## 216. `POST /payout-requests` under "log in as" is not blocked (SR-L on #680)

(security r2 on #680, LOW): the fifth surface of the same class — a payout request is created on behalf of an employee; the artifact is reversible and attributes the real operator, hence LOW. The owner's general decision → 403 with the same pattern (a shared literal in `packages/shared`, check as the first line of the service, a disabled button with an explanation on the client, a test for propagation of `impersonatorId` from the controller). Check: `POST /payout-requests` with a JWT that has `impersonatorId` → 403, no row.

## 217. Contract language is determined by the heuristic "is there a pipe table in the body" (i18n audit, `api` slice)

(audit `docs/architecture/2026-09-19-crm-i18n-audit.md`): `contract-pdf.service.ts` chooses the document language by the shape of the template body; Russian `'не указано'` is substituted inside a Ukrainian contract. Behaviour: an explicit language field on the contract template; substitutions go by it. Outside the i18n milestone (contracts are separate, see spec §1 item 5). Check: a template without a table, marked `uk`, renders in Ukrainian.

## 218. Four 403s under "log in as" do not name the way out (COPY-L-2 on #680, owner's decision)

(copy r2 on #680, LOW): the share/contract/terms/invoice texts explain "why not", but not «выйдите из режима «войти как» — и сделайте от себя». The fix pulls in all four literals at once and the shape of the family; owner's decision. Check: each of the four texts ends with an action.

## 219. The "not allowed" banner at 320 leaves «сам.» as a single word; take 320 screenshots as a full page (COPY-L-3 on #680)

(copy r3 on #680, LOW): at 320 the last line of the invoice banner is a single word; in viewport screenshots the banner is out of frame, and the review checked against the previous round's screenshot. Behaviour: (a) when editing the literal family (218), check the line wraps at 320; (b) in the coder's task — "320 screenshot as a full page (`fullPage: true`)". Check: the 320 screenshot contains the whole banner, the last line is not a single word.

## 220. Invoice type twice in the invoice dialog header (COPY-L-6 on #680, pre-existing)

(copy r3 on #680, LOW): the dialog title and the badge next to it print the same type; at 320 the duplication is more noticeable. Behaviour: the type once (the badge), the title — «Счёт» + number/amount. Check: in the dialog header the type word appears once.

## 221. The leftover «инвойс» against the glossary's «Счёт» (copy r3 on #680)

(copy r3 on #680; `CONTEXT.md` keeps «Счёт», with «инвойс» under `_Avoid_`): after #680 «инвойс» remained in `document-card.tsx`, `document-detail-dialog.tsx` and `upload-document-dialog.tsx` (`INVOICE: 'Инвойс'`), `documents.tsx` (filter and empty state), the public invoice verification page, `ArchiveConfirmDialog.tsx`, and in the API — in the notification title and the exception texts of `invoices.service.ts`. It will be closed by the i18n wave `web-docs-notify`/`api` or by a separate earlier PR. Check: `git grep -n "нвойс" -- apps/web/app apps/api/src` is empty.

## 222. `AC2 — «Просмотр» открывает диалог с PDF-превью` is red on `origin/main` independently of the i18n migration (task-i18n-3c-pr2, fix-round A CI-E2E)

(fix-round A on PR #725, isolation on `origin/main` with the same scratch stack): the test expects `candidate-resume-preview-error` not to appear after opening the resume preview dialog — it fails in isolation on `origin/main` (detached checkout, prod-build, same scratch stack), i.e. before the vacancies i18n edits. The cause is not the text but the preview pipeline: the presigned resume URL via S3/RustFS does not resolve in the test environment. `VacancySheet.tsx`/`use-vacancies.ts`/`ResumePreviewDialog.tsx` (this PR) touch neither the blob pipeline nor `PdfPreview`. Behaviour: `PdfPreview`/the presigned resume URL resolves in the scratch/CI environment the same way as in prod. Check: the same test on `origin/main` is green after the preview pipeline fix.

## 223. `CandidateCard` — the button row in the card footer is clipped at 320px (uk) (task-i18n-3c-pr2, fix-round A WIDTHS)

**Closed in fix-round B of the same PR #725 — fixed in the text, not as a separate task.**
`CandidateCard`'s status toggle and resume button got a breakpoint swap (short forms
«Перегляд»/«Відмова»/«Завантажити» at <640px, the same catalog entries already present in `$vacancyId.tsx`
and in `CandidateCard`'s own preview button — not new ids) — the same technique by which
the `$vacancyId.tsx` applications filter had already solved an identical defect (PR #396). Re-verified with a live
Playwright pass at 320/375 (uk): `document.documentElement.scrollWidth === clientWidth` on every
screen, the action row fully in frame.

(fix-round A on PR #725, live Playwright pass 320/375/1440 × uk/en on `/vacancies/:id?tab=applications`): the Ukrainian text of the candidate card footer buttons is longer than the original Russian — at 320px the row is visually truncated (not a horizontal page scroll, but local clipping inside the card). The other vacancy screens (list, form, details, SEO, translations) are clean at all tested widths × locales. Behaviour: the `CandidateCard` action row is not clipped at 320px in any of the uk/en locales. Check: a screenshot of `/vacancies/:id?tab=applications` at 320px (uk) — the candidate card button row fully in frame.

## 224. `@xmldom/xmldom` 0.8.x high CVE transitively from `mammoth` — a simple override breaks DOCX parsing (gardener #8, 2026-10-05)

(codebase-gardener, category #8 Security; verified by fact): `pnpm audit --prod` gives a series of HIGH/MODERATE on `@xmldom/xmldom` (injection + ReDoS/quadratic-parsing, DoS class). The source is the direct dep `mammoth` (DOCX→text for resumes, `resume-text-extraction.service`): mammoth requires `@xmldom/xmldom@^0.8.6`, there is no patched 0.8.x (the fix is only in 0.9.x), bumping mammoth to latest does not help. **Verified:** `pnpm.overrides` on `@xmldom/xmldom@^0.9.12` closes the CVE in the audit but breaks extraction (10 specs of `resume-text-extraction.service.spec.ts` go red: AC1/zip-bomb-guard/AC5/concurrency limit; the `sandboxed-process` worker fails with exit 1); on a clean main the same file is green. So mammoth 1.12 is incompatible with the xmldom 0.9 API. **Exposure (why not a blocker):** server-side DOCX parsing only from authenticated users; input is bounded by the zip-bomb guard and an isolated worker with memory/time limits; there is no unauthenticated surface. **Owner's decision (put into the decision brief 2026-10-05):** (1) accept the bounded risk until mammoth upstream moves to xmldom 0.9; (2) a Coder task — root-cause the exit 1 under xmldom 0.9, `pnpm patch` mammoth if needed; (3) replace mammoth. Closing check: `pnpm audit --prod` without @xmldom/xmldom HIGH AND `resume-text-extraction.service.spec` green.

## 225. `resume-glyphs.ts` — O(n) `includes()`+`push()` instead of a Set in three helpers (gardener #9, bounded — a note, 2026-10-05)

(codebase-gardener, category #9 Performance; severity LOW — bounded data): in `findUnrenderable`/`toRenderableText`/`toRenderableDeep` unique characters are accumulated through `string[]` + `if (!arr.includes(ch)) arr.push(ch)` — O(n²) in the number of unique glyphs. The data is bounded (resume text, usually <5 KB), so by the runbook rubric (`code-reviewer.md` Step 3: bounded collections = a note, not a blocker) — **deliberately NOT fixed**: a Set replacement gives zero real gain at 5 KB, and the file is a glyph sanitizer (a past security finding of a glyph-check bypass, PR #504), where preserving behaviour matters more than micro-optimisation. Behaviour on closing (if the function is extended to large texts): `out`/`dropped` → `Set<string>`, `.includes`/`.push` → `.has`/`.add`, result identical. Check: `resume-glyphs` tests green, function output byte-for-byte the same.

## 226. Remainder of the gardener sweep of 2026-10-05 — tail (non-giant) + giants human-planned

(codebase-gardener; detailed list from the previous session, verified by fact — the audit systematically overstated volumes, check with grep/du before dispatch). Merged: #1 scope of rules/common (#776), #2 CONTEXT.md (#773), #3 dead root docs (#772), #5/#6 CI (#780), #8 dead-code e2e (#778), #10 dedup (#779), #11 dead exports (#778), #18 prod-any (#781); + efficiency axis in code-reviewer (#777), PM removal (#775), runbook (#782); #7/#9 deps = PR #783. **Remainder (non-giant):** #16 de-flake E2E misc — **the premise "flakes steadily" is NOT confirmed by the 2026-10-05 records** (recent misc failures = a real regression of #783 resume-paste/CodeMirror, not a flake); evidence is needed before de-flaking (intermittent pass/fail on one commit). #17 compressing agent docs (`coder.md` 418 / `code-reviewer.md` 358 / `skills-invocation.md` 169 lines) via writing-for-agents — Architect zone, token ROI; **deferred: reforming live agent docs mid-loop of vacancies is risky** (these agents are actively running Phase 2). #12 composite CI action (6 workflows duplicate node-setup) — low ROI + workflows-scope merge risk. #19 cleanup of `.claude/worktrees` (git list ~50) + `.claude/tasks` (**592K, not 2.4MB**) — removing a worktree from main is blocked by the agent-isolation hook → owner's prerogative with literal paths. #20 stale references/comments — mostly done by #778/#779, the remainder is pointwise. **Giants — HUMAN-PLANNED, NOT auto:** #13 split `schema.ts` (~3.6k), #14 split `transactions.service.ts` (~9.4k), #15 split `users.service`/`projects.service`/`$projectId.tsx`/`UserDialog.tsx`. The weekly `codebase-gardener-weekly` (Mon 06:01) reopens the audit by itself — it will pick up the tail #12/#16/#17/#19/#20. New findings of this session: [[224]] xmldom CVE, [[225]] resume-glyphs O(n).
