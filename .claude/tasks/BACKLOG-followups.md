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
> (`parse_steps`, `source_values`) and a comment beside them explicitly calls
> "name mentioned, therefore wired" the naive approach it avoids.
> Verified by execution: a devops agent built a fake `deploy.yml` in which the file name
> appears three times in prose and never in the real steps — the guard returned FAIL.
>
> **I did exactly what I criticized the audit for:** I judged a mechanism by a superficial
> match instead of by what it does. The audit read the file by name, I read it by a line
> from its documentation. The rule stays the same and is now reinforced twice over:
> **a guard is verified by running it, not by reading it.**

- **42 — alive, confirmed on `origin/main`.** `apps/api/src/app.module.spec.ts` (from #532)
  looks by name like it closes the item, but its own docstring says it
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
- **41 + 49** — the pair of steps in `deploy.yml` around
  `2026-08-10_senior_resume_template.sql` (the SCP copy in the build job and the matching apply in
  the deploy job). Both now notice-skip when the file is absent, so they are inert rather than dead;
  the item is whether they should exist at all now that the template has merged.
- **60** — `mutation-gate.mjs` still excludes `src/**/*.module.ts`.

### Confirmed closed (no need to re-check)

**5** (RBAC is deliberately delegated to callers and this is recorded in the docstring; the remainder is a test that
every caller checks permissions, also in `task-authz-followups.md`) · **10**
(`deploy-alert.yml`) · **11** (`ci.yml` seeds vacancies builds the landing —
the build runs against a non-empty set) · **17** (`vitest.config.mts` prints an explicit banner
about skipping integration specs with the command to run them) · **21** · **26** · **31** · **33**
(`not.toBeNull()` + a written explanation of why the previous form could not fail) ·
**34** · **35** · **47** (`describeLimits` was deleted outright by #544 — `grep describeLimits` over
`apps/` and `packages/` returns nothing; the same closes the prose entry 33 below).

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

6. **Docs drift** (BA zone): `docs/business/modules/auth.md` and `docs/business/user-flows.md`
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
    in review of #455, where `teams.archive.spec.ts` creates a service without the audit dependency.
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
   мерж») and finishes successfully rather than silently. The `workflow`permission is intentionally not granted to auto-merge:
   it is GitHub's built-in protection against uncontrolled pipeline changes by automation, and a bypass
   for convenience would be a security downgrade. Manually merging such PRs is an ordinary `gh pr merge --squash`, without `--admin`.
10. **A deploy failure does not raise an alert.** The deploy failed 2026-07-27 21:22 and stayed red for
    **four days** — nobody found out, prod quietly ran on old code. We set up a notification about a red
    main branch (#441/#446), but not on `Deploy → failure`. Set it up.
11. **The structured-data check is enabled only when vacancies exist.** While there were
    zero, the build passed and pages went to prod without markup for search engines. This is already
    the second case of this class in the same file (see the comment `prerender.mjs`).
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

14. **The prod-migration wiring guard is satisfied by a comment.** `check-prod-ddl-wiring.py`:
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
    - dies on a **positive** assertion (strict mode, 2 matches — the viewer
      is itself "Senior Dev"), so its "junior is hidden" checks are never executed;
    - **was never executed**: both preconditions are under `if (isVisible)`, and the needed
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
    (`index.tsx` — a loop over the key list), there is no product defect. But the fields render without
    a `name` attribute, while the spec looks them up via `getByPlaceholder(/стек технологий/i)` and
    `input[name*="tech"]` — these selectors never matched. This was hidden by two conditions:
    `if (isVisible)` on the fill and `if (body.techStack)` on the check. The fix requires tying the label to the field
    or adding `data-testid` — that is a product edit, which is why it is raised here.

20. **A check that cannot fail in the payouts spec.**
    `apps/e2e/tests/drop-confirm-payout-rbac.spec.ts` —
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
    (`resume-typst.service.ts`).
    **The task is not "write a test", but first to decide whether the accessor is needed.** Writing a test just to call
    a function nobody calls means pinning dead code as live — the same class as
    the rest of this list.
    **Closed by #544** — the accessor was deleted rather than tested; the symbol no longer exists in the repo.

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

38. **The `/collect` throttler counts per address, not per user** (`app.module.ts`).
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
    code-review on #532 (2026-08-16), `apps/api/src/job-sourcing/job-sourcing.service.ts`.
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
    code-review on #540 (2026-08-17). `apps/web/app/styles/globals.css` —
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
    - **The project surface** (`projects.service.ts`): member rows are
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

71. **"0 surviving mutants" says nothing about the uncovered ones.** `check-mutation-tally.mjs`
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
    while the "Date" column goes through `fmtDate()` (`finance/constants.ts`) — `toLocaleDateString`
    **without** `timeZone: 'UTC'`, i.e. in the browser's zone. The rationale for the round 2 fix
    was "truncate to the day the column shows" — when the zones diverge, this rationale
    stops being true.
    **No practical harm to the owner right now:** Kyiv is east of UTC, and UTC midnight for
    a date-without-time renders as the same day. **The real hidden defect is wider than sorting** —
    for any operator west of UTC, `fmtDate` will show a date-without-time as the **previous day**.
    The fix belongs in `fmtDate`, not `dayOf`: dates-without-time need an explicit `timeZone: 'UTC'`.
    **Not provable by tests:** the project environment is pinned to `TZ=UTC` (see the comment in
    `SettleSeniorPayoutDialog.tsx`), so the divergence physically cannot be reproduced
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
    `resume-render-responsiveness.spec.ts` — `Math.max(...samples)`. `samples` is filled by
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
    `transactions.service.ts`, "the previous hard guard blocked legitimate mixed-currency
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
    for that. With such a cleanup, the FK `ON DELETE SET NULL` (`schema.ts`) will null out
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
    (`pending-settlement.service.ts`) they refuse **loudly** on an invariant that is unreachable today.
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

On the integrator's stand `notifications-bell-trigger` was not found even on `origin/main` (isolation by file substitution). The spec is tied to the default `localhost/3001`; agents bring stands up on 30xx. Behavior: the spec reads addresses from `baseURL`/env, like its neighbors. Check: the spec is green with `API_PORT=3084`/web 3085.

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

## 196. `pnpm test` from the root pulls the full E2E on `localhost/3001`

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

## 227. The worktree-ownership ledger records before the command runs — a PostToolUse companion would close the residual (from PR #1025, 2026-10-18)

(orchestrator + code-reviewer delta on PR #1025; severity LOW, disclosed by the author rather than found). `pre:bash:cross-agent-blast` now decides whether an agent may remove a scratchpad checkout from a ledger it writes itself: it appends the calling `agent_id` against the literal path when it watches `git worktree add`, and `remove` permits only what is recorded against that same id. Because the hook runs **before** the command, a `git worktree add` that then fails for an unrelated reason (a bad commit-ish) still leaves a line for a path that was never created; a sibling agent later choosing the **same literal absolute path** could have that tree removed. The recording rule already narrows this hard — the target must be literal, absolute, strictly below the scratchpad root by at least one component, and must not already exist — so a live sibling checkout is never recordable, and the damage is bounded to one scratchpad directory. **Why it is a note and not a blocker:** it needs two agents to independently choose one name, and the isolation rule now asks each agent for a name of its own instead of the shared `$SCRATCH/checkout`. **The closing shape:** a PostToolUse companion that records only after git reports success, which removes the "recorded but never created" state entirely. **Check on closing:** a hook copy whose `add` is made to fail must leave no ledger line, proven by a case that goes red without the companion.

## 228. Agents cannot remove their own scratchpad checkouts until #1025 merges — three in one day, and they accumulate (2026-10-18)

(orchestrator, observed by fact; severity LOW, self-closing). Three review agents in one session reported that `git worktree remove` on their **own** checkout was refused by `pre:bash:cross-agent-blast`, so each left a registered worktree behind. This is the defect PR #1025 fixes, observed in the wild rather than in a test: before that PR the hook recognised only an agent's primary worktree, so a reviewer's legitimate cleanup of a checkout it created itself was indistinguishable from an attempt on a sibling's tree. Agents correctly declined to force it. **Consequence while it lasts:** registered-but-unused worktrees pile up in the session scratchpad, which is the same accumulation already recorded in [[226]] item #19, and the sweep is the owner's prerogative because removing a worktree from the main checkout is itself refused by the isolation hook. **Partly closed by #1025, and the remainder is measured, not assumed.** After that merge an agent's own recorded checkout is removable, because the ledger keys ownership on the `agent_id` the harness supplies. The **orchestrator's** own checkouts are not: the main thread has no `agent_id`, so nothing is ever recorded for it, and removing a checkout it created itself is refused with `WORKTREE-REMOVE` — "not your worktree" — rather than with the unrecorded-path refusal. Verified by running it on the merged hook. So the sweep stays owner-only for orchestrator checkouts. **The closing shape** is whatever makes a main-thread checkout attributable; the PostToolUse companion in [[227]] is the natural place, since it would record after git reports success and could key on the session rather than the agent. **Check on closing:** the orchestrator creates a checkout in its own scratchpad and removes it in the same session without a refusal.

## 229. The "Label PR on CI failure" step fails on PRs that touch `.github/workflows/**` (2026-10-18)

(orchestrator, observed by fact; severity LOW). On a PR whose diff includes workflow files, the aggregating `Typecheck · Lint · Unit Tests` job showed two failed steps: `Aggregate leg results`, which is the honest reflection of another red leg, and `Label PR on CI failure`, which is the labelling step itself erroring. On a sibling PR with no workflow files in the diff the `ci-failed` label was applied normally. The likely cause is the same `GITHUB_TOKEN` restriction that already prevents auto-merge on workflow-touching PRs, surfacing here as a failed label write rather than as a skipped one. **Why it matters beyond noise:** a failing labelling step adds a second red entry that does not correspond to a defect, which trains readers to discount red checks — and the `ci-failed` label is what the orchestrator uses to tell a real failure from a stale one. **The closing shape:** let the step fail soft, or skip it when the token cannot label, so the only red is the leg that actually failed. **Check on closing:** a PR touching a workflow file reaches exactly one red check for one real failure, and the aggregator reports no step error of its own.

## 230. Input and button outlines fail the non-text contrast criterion across the CRM (from the Task 0.1 design, 2026-10-18)

(ui-ux-designer, found while specifying the vacancy-queue screen; severity MED — accessibility, CRM-wide, inherited).
The outline of form inputs and outlined buttons measures **1.17:1** against the card background in the dark theme.
WCAG 2.2 success criterion 1.4.11 (non-text contrast) asks for **3:1** for the boundary of a component a user must
identify in order to operate it — an input whose edge cannot be seen is an input a low-vision user cannot find.
**Why it is a backlog item and not a fix inside that PR:** it is not introduced by the queue screen; it comes from the
shared shadcn/ui components and the border token in `globals.css`, so a local override on one screen would make the
CRM inconsistent rather than accessible. The fix belongs at the token level, where it reaches every form at once.
A related pairing the same design forbade locally: `muted-foreground` text on a `secondary` surface measures
**4.23:1**, below the 4.5:1 for body text. **Check on closing:** the border token used by inputs and outlined buttons
reaches 3:1 against every surface it sits on, measured from the token values, and `muted-foreground` on `secondary`
either reaches 4.5:1 or the pairing is banned in the design-system notes.

## 231. The deploy-freshness guard has never fired in the wild, and the one outage that should have tested it closed first (2026-10-19)

(orchestrator, observed by fact; severity MED — an alerting guard whose working state is unverified). The guard exists
because a deploy was once red for sixteen consecutive runs and nobody noticed. It is scheduled `23 */3 * * *` and
fails when the newest deploy run is a failure streak older than two hours. On the night of 2026-10-18/19 the deploy
failed twice in a row and `main` was undeployable for **three hours and sixteen minutes** — exactly the condition it
is built for. **It never fired.** Its 23:23Z run saw a failure only 1h08m old and correctly passed; the next
scheduled run was 02:23Z, and the fix merged at 01:30Z, so the streak was green again before the guard looked. The
guard is therefore still **unproven against a real outage**, and a three-hour production-blocking window produced no
alert — it was noticed only because the orchestrator was reading deploy runs by hand.

**The closing shape.** Two parts, the second mattering more:

1. **Prove it deliberately** instead of waiting for the next outage: drive it by `workflow_dispatch` against a history
   whose newest deploy run is an old failure, and confirm it reports. A guard whose alerting path has never executed
   is a guard in name only — the standard this repo already applies to hooks, each of which must have a negative case.
2. **Reconsider the two-hour threshold against the three-hour window it just missed.** Either shorten it, or treat
   "the newest run is a failure" as reportable immediately at a lower severity and keep two hours for escalation. As
   set, it cannot see an outage repaired inside its own sampling gap, which is most of them.

**Check on closing:** a deliberately synthesised old-failure history makes the guard report, demonstrated by a run;
and a failure repaired within three hours still produces one notification.

## 232. `db:seed` is refused on any development database that has run the append-only spec (2026-10-19)

(orchestrator, from the 1.3b fix round; severity MED — it blocks a routine developer action, and the
obvious fix would weaken an audit guard). The seed truncates `users … CASCADE`; the cascade reaches
`job_queue_actions`; the append-only trigger refuses it with SQLSTATE `23001` and the message
"job_queue_actions is append-only: TRUNCATE refused". Measured both ways: with the triggers installed the
seed fails, with them dropped it completes. **The guard is doing exactly its job.** CI is unaffected
because it seeds before any spec installs the triggers, and production is unaffected because production
never seeds. What it hits is every developer and QA database that has run the 1.3b integration spec and
is then re-seeded.

**The reason this is a backlog entry rather than a commit in that fix round:** giving the seed path the
ability to disarm an append-only audit guard is a security-relevant change to a tool that runs with owner
privileges. It wants its own PR and a security review, not a tail-end commit. The sanctioned shape
already exists in the 1.3b spec's own teardown — disable the two action triggers as the owner, truncate,
re-enable in a `finally` — so the work is to lift that into the seed deliberately, with the review that
deserves.

**Check on closing:** `db:seed` completes on a database that has the triggers installed, and a test
proves the triggers are re-enabled afterwards even when the seed fails midway.

## 233. The integration suite's verdict depends on Cloudflare being reachable (2026-10-19)

(orchestrator, from a CI failure on an unrelated PR; severity MED — a third party can turn the suite red).
`TurnstileService.verify()` makes a live HTTPS call to Cloudflare's siteverify endpoint on every
application submit, and converts **any** failure — network error, timeout, non-2xx, `success: false` —
into `false`, which the caller turns into a 400. The integration specs have no stub and no bypass: even
the "always passes" test secret needs the round trip to succeed.

Observed: one apply out of ten in a single CI run failed with `APPLICATION_TURNSTILE_FAILED` while the
other nine passed, including `contact.integration.spec.ts`'s deliberately-live siteverify test two
minutes later. That distribution is what rules out an environment or configuration cause — those would
have failed all ten.

**Closing shape:** stop calling Cloudflare from the integration suite — stub `TurnstileService`, or gate
the live call behind an explicit opt-in flag and keep **one** deliberately-live test if that path is
worth covering. Do not instead pin a sequencer order or resize a spec file: that restores the
concealment rather than removing the dependency.

**Check on closing:** the suite passes with outbound network to Cloudflare blocked.

## 234. The isolation hook cannot record a checkout created through an unexpanded variable, and four briefs have not fixed it (2026-10-19)

(orchestrator, observed four times in one day; severity MED — it leaks worktrees and the mitigation is
discipline, which measurably does not hold). The hook records `<agent_id> <path>` only when it sees a
`git worktree add` whose path is a literal absolute path below the scratchpad root. An agent that writes
`git worktree add "$S/co-pr1026-sec"` creates a tree the hook has no record of, and the later
`git worktree remove` is refused (`WORKTREE-REMOVE` / `WORKTREE-UNRECORDED`). **The refusals are correct** —
an unrecorded path in a shared scratchpad is one the hook cannot prove is free — and every agent
respected them rather than working around it.

What does not work is the instruction. Four reviewer and coder agents left orphans this way, including
one whose brief spelled the correct pattern out verbatim ("expand the variable once with `echo`, then use
the literal for both `add` and `remove`"). Four for four. **An instruction ignored four times is not an
instruction problem.**

**Candidates, in order of preference:** have the hook record the _resolved_ path — it sees the expanded
argv, so the variable is already gone by the time it runs, which makes this look feasible and removes the
failure mode entirely; or give agents a wrapper to call instead of raw `git worktree add`. Do not add a
fifth paragraph to the briefs.

**Check on closing:** an agent that creates a checkout through a variable can still remove its own, and a
sibling's tree is still refused.

## 235. The health endpoint reports healthy throughout a database outage (2026-10-19)

(from the pool-error-listener task; severity LOW-MED — it misreports during exactly the incident it would
be consulted in). `HealthController.check()` does not touch the database and always returns
`status: 'ok'`. So while Postgres is down or refusing the API's credentials, the endpoint says the service
is healthy.

This did not matter much while the API crashed on a database restart, because the crash was itself the
signal. Now that the pool logs idle-client errors and survives (entry: the listener landed 2026-10-19),
the process stays up through an outage and the endpoint is the only thing a human or a monitor would ask —
and it answers wrongly.

Deliberately **not** widened into the listener's PR: changing what readiness means can change deploy
behaviour, and the ADR's deploy ordering relies on `docker compose up -d` rather than a health gate, so
this needs its own reasoning about who consumes the endpoint before its semantics move.

**Check on closing:** with the database stopped, the endpoint reports unhealthy; and the deploy's own
ordering is shown to still behave as the ADR describes.

## 236. The telemetry exception filter stores bound query parameter values (2026-10-19)

(raised by code review on PR #1042, confirmed by security review; severity MED — data minimisation, not
disclosure). `TelemetryExceptionFilter` stores `exception.message` and `exception.stack` of every 5xx.
For a Drizzle query error **both carry the bound parameter values**, and `sanitizeAndTruncate` redacts
only Bearer tokens, cookie headers and passwords. So values a request supplied are written to
`telemetry_errors` and forwarded into the issues the digest files.

**Calibrate the severity correctly, because the first report of this got it wrong.** The digest files
issues in a **private** repository — every `gh` call in `telemetry-digest.yml` targets `PRIVATE_REPO`, and
the header carries an explicit "NEVER point this workflow at the public". The first report claimed a
public issue because a **comment in the filter said "public GitHub issue pipeline"**, which was untrue;
PR #1042 corrects that wording in three places. So this is "more stored than needed, in a channel
designed for it", and the cost is what a later leak, a stale retention window or an over-broad token
would expose.

**The reusable pieces already exist** (with PR #1042): `findPgError`, `describeDbError` and
`safeErrorStack`. The filter receives the thrown `DrizzleQueryError`, so `safeErrorStack(exception)` gives
a frames-only stack and `describeDbError(exception) ?? exception.message` a value-free message.

**Two decisions the task must make, both named by the author:** grouping shifts once, because
`fingerprint.ts` hashes the normalised message plus top frames and the replacement uses statement
placeholders; and a non-database error whose own message embeds a value is **not** covered by these
helpers, so that needs its own rule.

**Check on closing:** a 5xx caused by a Drizzle error stores no parameter value, proven with a
recognisable marker; and the digest still groups errors usefully after the fingerprint input changes.

## 237. `integration-db-guard.ts` shares the socket-URL bypass (2026-10-19)

(found by code review on PR #1043; severity MED — the primary guard, not a second lock). For a socket-form
URL that carries the database in a `db` query parameter, `pg` takes the database from the parameter and
**ignores the path**. The guard reads only the path, so it allows the URL while `pg` connects to the live
database.

This is the **primary** guard — it runs on every integration invocation — so the reassuring sentence
written during PR #1043 ("the live database was never reachable through this, because the primary guard
decodes") is **not true**. The primary guard closes the percent-encoding route and shares this one.

**The fix is known and already proven in the sibling:** PR #1043's `assertNotLiveDb` refuses if either
`extractDbName` **or** `new Client({ connectionString }).database` says live — `pg`'s own parse, so the
guard follows what would actually connect instead of reimplementing its rules. It also refuses a URL `pg`
cannot parse at all, which was a separate design gap found by hand mutation.

**Do not delete the path check as redundant.** Measured during #1043: a fuzz of 71,400 URL shapes found
**1,974** where the path says live and `pg`'s parse does not, and `pg` parsed 1,414 of those fine — for
instance a socket URL with three slashes, where `pg` resolves the OS user. Both signals are load-bearing.

**Check on closing:** all four socket forms are refused by the primary guard, and a URL `pg` cannot parse
is refused rather than allowed.

## 238. The mutation gate cannot see `apps/api/src/test/**`, and one file there now deserves it (2026-10-19)

(raised by the author of PR #1043 against its own evidence, endorsed by its reviewer; severity MED — a
guard whose green is not evidence). `src/test/**` is in the `@crm/api` exclude list in
`scripts/devops/mutation-gate.mjs`, so the gate exits 0 on a diff confined to that directory **because it
found nothing to mutate**. On PR #1043 that produced a green gate on a change to a live-database guard,
and the author said so in its own PR body rather than letting the green stand as proof.

**Do not drop the exclusion wholesale.** The reviewer's reasoning: that directory also holds the
integration `globalSetup` guard, which a unit-suite gate cannot kill, plus fixtures and mocks — all of
which would report as survivors or no-coverage noise.

**The shape to implement:** a **narrow, named re-include** for `assert-not-live-db.ts`, pinned by a test
so the re-include cannot be dropped silently — the schema-exclude test is the model. It is **two places**,
not one: the pattern list and the changed-file filter.

**Why it earns the work:** both PRs that touched that file had to substitute hand mutation for the gate,
and in both cases the hand pass left survivors the tool would have caught — three on #1043's second pass,
one of which was a design gap rather than a test gap.

**Check on closing:** a deliberate mutation of `assert-not-live-db.ts` makes the gate red, and a change
confined to fixtures still does not.

## 239. Twelve agents were cut by the stream watchdog in one evening (2026-10-19)

(orchestrator, counted; severity MED — process, and the instruction demonstrably is not the fix). On the
1.3 chain, twelve agent runs ended with "no progress for 600s". The common factor every time was a long
**quiet** stretch, never a long step: a mechanical sweep across many fixtures, a full suite run, a
large-output command, and — twice — an agent that had correctly backgrounded a command and then waited
with nothing printed between probes.

`.claude/rules/common/stream-watchdog.md` already prescribes the four moves, and the orchestrator
restated them in **every** resume message. That is the point of this entry: **the instruction was given
twelve times and the outcome did not change.** An instruction repeated and ignored is a mechanism problem.

**What the cuts cost** was small each time, and only because of the `wip:` cadence — the work survived on
`origin` in most cases. Where nothing had been pushed, a whole stretch was lost, three times.

**Candidates, roughly cheapest first:** a wrapper that prints a heartbeat while a long command runs, so
waiting is never silent; a sentence in the rule saying that **backgrounding is not enough** — the wait
itself is the silence, which the current wording does not say; and a dispatch-time default that puts the
first `wip:` push before any long step rather than after the first cluster.

**Check on closing:** a run that spends ten minutes on one command is not cut, and the mechanism that
prevents it does not depend on the agent remembering to print.

## 240. The live-db hook cannot see a `PGDATABASE` inherited from the session (2026-10-19)

(stated by the author of PR #1044 at the code, deliberately rather than as an oversight; severity LOW-MED
— a known blind spot in a guard's coverage). `pre:bash:live-db-guard` now checks an **inline**
`PGDATABASE` assignment through the same name rules as the URL, because an inline assignment in front of
a dev-server command is an idiom it would otherwise wave through. But a `PGDATABASE` exported earlier in
the session is invisible to it: the hook sees only the command line.

So the guard watches two of the three doors into the same room — the URL path and an inline environment
assignment — and the third, an inherited environment, is open by construction. An AutoTest agent measured
the equivalent on the application side: a path-less database URL with that variable exported really does
land in the live database.

**What a fix would need:** the hook would have to read the invoking shell's environment, which a
`PreToolUse` hook does not receive. So this may be closed not in the hook but by the thing it guards —
for example a dev-server preflight that prints `current_database()` and refuses on the live name, which
is the same device `live-db-access.md` already requires of agents by hand.

**A false positive of the same hook, found while writing this entry.** Appending this text with a shell
heredoc was **refused**: the hook read an example command inside the document as a launch in command
position. Its own refusal message claims that reading about a launch no longer trips it, so that
boundary does not hold for heredoc content. Harmless here — the entry was written with a different tool
and nothing was bypassed — but it is evidence for the same conclusion as the blind spot above: this hook
decides from the command text alone, which is both why it misses an inherited variable and why it
mistakes documentation for an action.

**Check on closing:** exporting the variable and then starting a dev server is refused or fails loudly
before it connects; and writing a document that quotes such a command is not refused.

## 241. `cmdscan` decides whether a heredoc body is code, and gets it wrong in both directions (2026-10-19)

(two findings of one cause, from security reviews on PR #1044; severity MED, raised to near-term by how
often it fires). `lib/cmdscan.py` is shared by the command-inspecting hooks. It answers one question —
when does the text inside a heredoc or a here-string count as a command — and it answers it wrongly in
both directions.

**The bypass.** A shell fed from a heredoc or a here-string is **not re-read**, so the whole guard is
skipped with no encoding trick at all. The live-db guard, including every check added on PR #1044, does
not see a launch written that way. Confirmed identical at the merge-base, so it predates that PR.

**The false positive.** A heredoc body with a **quoted** delimiter containing a backticked or `$( )`
launch **is** refused, although the shell expands nothing there. Bare launch lines, apostrophes,
single-quoted `echo` and `git commit -m` all pass, so the trigger is narrow and specific.

**Why near-term rather than someday: it fired four times in one evening**, on four different actors —
the orchestrator writing a backlog entry that quoted an example command, an architect's `sed` script
text, and a security reviewer's own heredoc **twice while writing the review that reported it**. Each
time the refusal was respected rather than bypassed, which is the system working; but the refusal text
then recommends prefixing a database URL, which trains exactly the reflex the hook's own header warns
against. A guard that obstructs correct work teaches people to disable it, and that costs more than the
bypass it is guarding.

**They are one task, not two.** Fixing the bypass alone makes the false positive worse, because both
follow from the same decision about heredoc bodies. A regression test for either half, written before
that decision is made, would pin the wrong behaviour — so do not add one first.

**What the fix has to decide, stated as behaviour:** a heredoc body is code when the shell will expand
or execute it, and data when it will not. An unquoted delimiter expands; a quoted delimiter does not. A
shell reading its script from a heredoc executes it. Those three facts are the whole rule.

**Check on closing:** a launch written through `bash <<'EOF'` or a here-string is refused; a document
quoting a launch inside a quoted-delimiter heredoc is not; and both directions have a test.

**Update 2026-10-21 — the deferral is now backed by five measured divergences, not by principle.**
PR #1067 narrowed the launcher gates over six rounds, and in each round closing a divergence in one
place opened one somewhere else: a comment-hidden opener, a quote-state difference between the two
readings, a substitution-depth counter that miscounted nested and case-pattern parens and ignored
`$(` inside double quotes, a physical-line check walked past by a backslash-newline continuation, and
a hand-rolled word boundary wider than bash's (`isspace()` accepting `\r`/`\v`/`\f`). Each was a
fail-open found by an automated review of the fix before it.

That is what two independent readings of one text do under local patching, and it is the argument for
unification: the final form only converged once the opener-line test was **inverted from a denylist to
an allowlist**, which fails closed on constructs nobody enumerated. The adjacent `PKG_QUERY_SPEC`
grant, an allowlist from the start, converged in a single round. Whoever picks this up should read the
six-round history in #1067's body first — it is the cheapest available argument for doing the rewrite
rather than a seventh patch. Note also that the interpreter-consumed-heredoc hole is **not** this
entry: see [[266]], different cause.

## 242. The alert pattern crosses a language boundary as ERE and is consumed as a JavaScript regex (2026-10-19)

(named by the author of PR #1042 as a latent risk, not a defect today; severity LOW-MED — a silent
divergence mode in a contract that two PRs now depend on). `check-api-permission-denied.sh` publishes its
patterns through `--print-contract-pattern` and `--print-pattern`, and #1042's test helper consumes them
with `new RegExp(output, 'i')`. The published text is **ERE**, written for `grep -E`.

For the current patterns the two dialects agree exactly — `\[`, `.*`, a group and an alternation mean the
same thing in both — and a syntax error would be caught by the constructor, which a test exercises. What
neither catches is **ERE-only syntax that JavaScript reads differently**: a POSIX class such as
`[[:alpha:]]`, or `\<`. Those would parse on both sides and mean different things, so the test would stay
green while the two sides stopped agreeing.

**Why it is worth recording rather than fixing now.** The published interface is otherwise sound and was
measured: each flag prints exactly one non-empty newline-terminated line, byte-identical across
invocations, and both outputs are accepted by the constructor. The risk only materialises if the shell
side's patterns grow beyond the shared subset — which is plausible, since they have changed in every one
of four fix rounds.

**The closing shape, from the same author:** pin with **golden sample lines** checked by both the shell
tests and the TypeScript tests, rather than by sharing the pattern text. Then the two sides agree about
inputs and outputs instead of about syntax, and a dialect divergence fails a test.

**Check on closing:** a pattern using a POSIX class is either rejected at publication or proven to mean
the same thing on both sides.

## 243. `zone-of-write.md` does not anticipate a corpus data file that expresses a hook's semantics (2026-10-19)

(orchestrator, from a judgement call on PR #1044; severity LOW — a rule gap, not a violation). The rule
grants the architect, inside `scripts/devops/`, only `check-guard-tests-exist.sh` and
`tests/test-pre-*.sh`. `tests/lib/command-corpus.txt` is neither, yet it **encodes the expected behaviour
of the hooks the architect owns**: a deliberate change to a hook's refusal necessarily changes a row in
that corpus.

On PR #1044 the architect hit exactly this, raised it rather than quietly editing, put the one changed row
in its own commit and flagged it in the PR body. I accepted it, because refusing to touch the corpus
would mean shipping a hook whose own corpus contradicts it — worse than the boundary the rule protects.

**What to decide:** whether the corpus counts as part of the hook (architect's, which is what the
behaviour implies) or as DevOps test data (which is what the paths imply). Either answer is fine; the
present state, where the honest action requires stepping outside the stated zone, is not.

**Check on closing:** the rule names the corpus explicitly, one way or the other, and the reasoning says
why.

## 244. The local prettier push gate fails open when it cannot resolve the diff base (2026-10-19)

(orchestrator, from reading the hook after a CI failure it had passed; severity MED — a guard whose green
is not evidence). `pre:bash:prettier-gate` exists to mirror the CI formatting gate before a push. Its own
comments state the behaviour plainly: when `origin/main` is unresolvable it **allows** the push, "rather
than block on infrastructure we lack".

In a fresh agent worktree that base is often unresolvable, so the gate passes without checking anything —
which is how an unformatted file reached CI on PR #1041 after a local push the gate had allowed. Note the
asymmetry: if **prettier itself** is unreachable the gate fails loud and blocks, which is the right
direction. Only the diff-base resolution fails open.

**Why it matters beyond the one file:** a local gate that passes what CI then fails teaches people to stop
running it, and this one is advertised as a mirror. Either it is a mirror, in which case an unresolvable
base must block or fetch, or it is best-effort, in which case it should say so where the reader sees it —
and the agent brief should stop treating its green as evidence.

**This is the fourth guard this evening whose silence meant "could not check" rather than "clean"** — the
others being the isolation ledger inversion (entry 234's cousin), the deploy-freshness guard (231), and
the mutation gate on an excluded directory (238). The shared remedy is the same in each: refuse, or
report loudly, when the check could not run.

**Check on closing:** with `origin/main` unresolvable, a push carrying an unformatted file is refused or
the base is fetched first; and the hook's header states which of the two it is.

## 245. The privilege-denied signal needs to leave the log stream — the journal channel (2026-10-20)

(decided by the orchestrator on the DevOps agent's recommendation, after four security rounds on the log
channel; severity MED as work, HIGH as a design conclusion). The `42501` watch and the chokepoint that
feeds it are both on production and working: detection is in place and the line it matches is now
deployed. What is **not** in place is a channel a stranger cannot forge.

**Why the log stream cannot be the channel.** Four rounds established it by measurement, each time a new
spelling of one fact — **the log mixes attacker-influenced text with trusted text**. An anonymous request
forged the contract line through a decoded path parameter; Docker's 16 KiB chunking plus `--timestamps`
made a record unparseable so the filter kept it verbatim; and the anchor added to stop the first route
needed only `%20` and `%5B` to satisfy. Each fix was right and none converged.

**Why a nonce was rejected.** `deploy-stack-on-vps.sh` prints `docker compose logs --tail=50 api` into a
**public** Actions log on a health-check failure, GitHub masks only registered secrets, and one published
bearer line makes the scheme forgeable by replay. A MAC over the fields survives that, but still ties the
guarantee to a secret.

**The decided shape: unforgeable by construction, not by secret.** The chokepoint appends one validated
JSON line to a journal file inside the container; the scanner reads it with a fixed
`docker compose exec -T api cat`. A request cannot write files, the table name is already restricted to a
safe character class, there is no secret to leak or rotate, and it survives the 10 MB × 5 log rotation
that the grep never did.

**Two costs accepted, both to be written down in the runbook rather than discovered:** the journal is lost
when the container is recreated, which the deploy's own scan covers; and the scanner key gains `exec`
where it had only `logs`. That second one is a real widening — `exec` runs arbitrary commands — so the
planned dedicated key must pin the **exact** `cat` invocation through `restrict,command=`. That is a
precondition of the journal, not a later nicety.

**Brief it as one task across both sides.** The write side is the chokepoint, the read side is the
scanner. Every cross-side detail negotiated between two PRs this round went wrong at least once — the
`table=-` versus `table=unknown` spelling, a copied regex that was already stale against the pattern it
copied, and a contract that neither side's comments described the same way. One task, one author, both
sides.

**Check on closing:** a forged contract line in the log stream produces no hit; a genuine one in the
journal does; and the deploy gate can fail on a genuine privilege error again, which it currently cannot.

## 246. Three agent prompts each carry their own copy of the scratch-stack launch (2026-10-20)

(from the architect's own refusal to refactor during PR #1044, which was the right call in that PR;
severity LOW-MED — a maintenance multiplier with a measured history). `coder.md`, `manual-qa.md` and
`ui-ux-designer.md` each spell out how to start a scratch dev stack. That one command needed **five**
corrections in a single evening:

- the bare form, which both the live-db guard and the TTL gate refuse;
- the `dev-ttl.sh` argument order — an assignment after `--` becomes a command word and exits 127, and
  that broken form was in the live-db hook's own refusal message, where no gate could ever catch it;
- an unbounded `until … sleep` wait, which the unbounded-wait hook refuses;
- `lsof -ti:<port> | xargs kill -9`, which killed the owner's live servers;
- a shared example port pair, which would have had two concurrent agents killing each other's stack —
  and whose first fix re-introduced the kill problem at a different scope.

Each correction had to be made in up to three files, and the sixth will too.

**The shape the architect proposed and I accepted as the right one:** a script, for example
`scripts/devops/start-scratch-stack.sh`, that picks a free port pair, applies the scratch-database and
wrapper rules in one place, and prints the ports it chose. Each prompt then shrinks to one line, and the
port collision stops being a matter of instruction.

**The verification method that found all five, and should be the standard:** extract every executable
line from a prompt **as written** and run each through the `pre:bash` gates. A prompt that carries a
command is code, and it had never been tested as code.

**Check on closing:** the launch exists in exactly one place, and every executable line in the three
prompts passes the gates.

## 247. P1 — the live-database check moves into the API's own boot; the hook becomes advisory (2026-10-20)

(the orchestrator's stated stopping rule, fired by the fifth security round on PR #1044; severity HIGH as
a design conclusion, P1 as work). Five rounds hardened `pre:bash:live-db-guard` and each one closed real
routes to the live database — percent-encoding, a `#` fragment, the `dbname` query key, libpq's user-name
fallback, shell expansion before the hook reads the value, and an argument decoy that disabled a check.
Every fix was correct. None converged.

**The fifth round named why, and it is structural.** Inside a launch the hook recognises, the fail-closed
model now holds: no spelling of `env`, no computed command word and no unmodelled wrapper gets a
recognised launch past it. But **the answer to "is this a launch" still defaults to allow.** The hook is
fail-closed about _how_ a launch is written and fail-open about _whether_ a command is one. All five
remaining HIGHs live in that gap:

- only the **first** launch in a command is judged, so a second one after `&`, `;` or `&&` is unexamined;
- package scripts that boot the API are not launches — and the repository's **own CI** boots it that way,
  so an agent mirroring CI locally gets no pin and no port check;
- the repository's own TTL wrapper, run through an interpreter, passes with no pin at all — which is the
  shape of the 2026-08-05 incident;
- **the literal command word is not necessarily the program that runs**: a function or alias named like
  the launcher, a `PATH` shim, `NODE_OPTIONS=--require` and `BASH_ENV` all pass with a safe-looking pin;
- an interpreter with an unlisted value-taking flag is not recognised.

The fourth of those is the divergence the stopping rule was written for: **a hook can never be bash.** It
reads text; bash resolves functions, aliases, `PATH`, and startup files. No amount of text analysis closes
that, and five rounds of evidence is enough.

**The decision.** The authoritative check moves to where the connection is actually made — the API's own
boot, and the dev server's. At startup it reads the database it has genuinely connected to
(`SELECT current_database()`), refuses to continue on the live name unless an explicit, inline escape
hatch is present, and says so loudly. That check cannot be fooled by how the command was written, because
it runs after every layer of shell, wrapper, script and flag has had its say. The hook stays as a fast,
early, **advisory** refusal — valuable because it fails before anything starts, not because it is
complete.

**What this does not mean.** PR #1044 is still a strict improvement on what preceded it and should land:
it closes six real routes. Holding it for a problem it cannot solve would leave the more permissive
version in place. Its remaining HIGHs are recorded as superseded by this entry rather than fixed, and the
two that **are** closable in its layer — judging every launch rather than the first, and the recognition
list for package scripts and interpreted wrappers — belong to it.

**Check on closing:** with the API started by any route — a package script, an interpreted wrapper, a
shell function named like the launcher, a `PATH` shim — a connection to the live database refuses at boot
with a message naming the database; and the hook's header says it is advisory.

## 248. P1 — a change to a shared parser needs a blocked-to-allowed differential, not a green suite (2026-10-20)

**The measurement that makes this P1.** On `lib/cmdscan.py`, **three of the last four defects were
introduced by a fix**, not found in the original code. Each arrived with the suites green, because each
fix was verified against the finding it closed rather than against the invariant it touched.

- A fix to the comment stripper, built for the two launcher hooks, removed a refusal from the third
  consumer. The fail-closed second reading it added lived inside the launch-question entry point, so the
  hook that asks a different question inherited nothing.
- The first repair of that took a payload-carrying interpreter flag and its payload out of the scan
  entirely: the string the shell would actually execute stopped being read at all.
- The second repair guarded one token position, and the same payload moved one position over.

**Why a green suite cannot see this.** A hook's suite asserts the verdicts it knows to ask about. A
refusal that disappears from a _different_ consumer, or a payload that stops being scanned, is not a
failing assertion — it is an assertion nobody wrote. The verdict moved; no test moved with it.

**The check.** A change to a parser shared by several guards arrives with a differential: replay a fixed
adversarial command corpus through **every** consumer at the base commit and at the new one, and fail on
any `(command, consumer)` pair whose verdict moves **blocked → allowed** unless that pair is explicitly
listed as intended. The reverse direction is reported as a false-positive risk, not a failure. This is
mechanical, so it belongs in the guard runner rather than in a reviewer's attention.

**And the instrument needs two payload families.** A sweep run with a database-client payload found zero
holes and was wrong: a text reading of a mis-parsed segment matches the client's name anyway, so that
payload cannot distinguish a parsed refusal from a textual one. The same sweep with a filesystem-
destructive payload found holes at seven placements per interpreter. A differential whose payload is
caught by the fallback text layer measures the fallback, not the parse.

**Check on closing:** a shared-parser change cannot reach main without the differential having run over
every consumer of that parser, and a `blocked → allowed` pair fails the run rather than appearing in a
report nobody reads.

## 249. Three narrow gaps left open in the live-db guard, deliberately (2026-10-20)

All three were measured and placed below the bar during the round-5 review, and are recorded so they are
not rediscovered as new. The guard is **advisory** by the decision in entry 247, which is why none of
them blocks.

- **Degraded mode recognises fewer launch spellings than the analyzer.** When the shared library is
  unavailable the guard falls back to a pattern, and that pattern misses a package-script launch with a
  directory-selecting flag, the long form of the script-running subcommand, and one alternative package
  runner. The analyzer recognises all three.
- **A comment that contains an operator and a launch is refused.** The fail-closed comment-free reading
  splits such a line, so a line whose launch exists only inside a comment is treated as a launch. This is
  a false positive by construction and the cheap price of failing closed.
- **The owner-session case is the one launch-shaped assertion still pinned only as allowed**, rather than
  also asserting it is recognised as a launch. It sits outside the gated context by design.

**Check on closing:** degraded mode recognises the same spellings as the analyzer, or the header states
which it does not; and the comment-free reading distinguishes a launch after a comment from one inside
it.

## 250. Residuals the pre-merge differential surfaced on the live-db guard (2026-10-20)

The differential described in entry 248 was run by hand before merging the guard's sixth round: 561
command shapes across five interpreters and three payload families, times three consumer hooks — 1683
pairs, compared at the merge base, at the then-current main and at the head, with no pair dropped. It
answered its question (nothing structurally refused became allowed; the only loosening was textual
false positives, proven so by the payload-family split). It also left three residuals, all of which
refuse **more** than before rather than less, which is why none blocked the merge.

- **An inconsistency between option operands.** A payload in the operand of the two single-letter
  option flags and of the init-file flag is now allowed when the TTL wrapper follows it, while the same
  payload in the run-commands-file flag's operand stays refused for both payload families. Both
  verdicts are defensible — none of those positions is code — but they disagree with each other, and a
  guard whose answer depends on which operand-taking flag was used is a guard whose rule nobody can
  state.
- **Roughly seventy newly refused package-script launches**, including wrapped forms. This is the
  recognition list widening, which is the intended direction, but some of those forms may be refusals
  of commands that were always safe. Nobody has looked at them one by one.
- **Three coverage gaps in the differential itself**, recorded so the next run does not believe it
  covered them: the launcher hooks were exercised with a fabricated agent-worktree working directory,
  so the outside-a-worktree gating was never entered; payload text was placed only in operand and code
  positions, with no quoting or escaping variants inside the payload; and the two less common
  interpreter names are textual to the hooks, so their real shell semantics were never compared.

**Check on closing:** the operand-flag families give the same verdict as each other or the header states
why they differ; a sample of the newly refused launch spellings has been judged safe-or-not by a human
reading; and a differential run records which of the three gaps it closed.

## 251. The local prettier gate runs whatever prettier is installed, so its green says nothing about CI (2026-10-20)

The local pre-push gate exists to be a mirror of the CI format check — catch it before the push so the
PR never goes red. It resolves the formatter from the local install, and the local install is whatever
a past `install` happened to put there. The declared range and the version CI resolves from the
lockfile can therefore both differ from it, silently.

**Observed.** A backlog-only PR went red on the format check with the local gate green. The local
install was two minors behind the declared range; the newer formatter indents the continuation lines of
an ordered list item differently. The affected lines were in an entry written months earlier — latent
all along, surfaced because the check reads every changed **file**, not only the changed lines.

**And the two gates can be mutually unsatisfiable.** Formatting the file with the version CI runs made
the local gate refuse the push; satisfying the local gate would have made CI refuse the merge. There is
no file content that passes both while the installs disagree, so the only repair is to the environment,
and nothing told the author that — the gate reported a formatting problem, which is not what it had.

**Why this is the same defect as the rest of this section.** A gate whose silence or approval means
"the thing I happened to load is satisfied" is not a gate on the property anyone cares about. The fix
is for the gate to assert the version it is mirroring — compare the resolved formatter against the
version the lockfile pins and fail loudly on a mismatch, naming both — rather than to report a
formatting verdict computed with the wrong tool.

**Check on closing:** with a deliberately stale local install, the pre-push gate refuses with a message
naming the installed and the expected version, and does not report a formatting verdict at all.
set, it cannot see an outage repaired inside its own sampling gap, which is most of them.

**Check on closing:** a deliberately synthesised old-failure history makes the guard report, demonstrated by a run;
and a failure repaired within three hours still produces one notification.

## 252. Two stale `api-errors.ts` coordinates the gardener could not fix in its own zone (2026-10-20)

(codebase-gardener; severity LOW — a dead coordinate an agent follows). The i18n stage-4 wave replaced
`packages/shared/src/schemas/api-errors.ts` with the directory `api-errors/` and deleted the file. Six live
code comments still pointed at the dead path; they are fixed by this run's PR. Two references remain, each
outside the Coder zone:

- `.claude/rules/common/russian-language.md` — the always-on language rule tells every agent that the error
  codes "live in `packages/shared/src/schemas/api-errors.ts`". Architect zone (`.claude/rules/**`), and it is
  the worst of the two: it is loaded into every session, so every agent reads a coordinate that resolves to
  nothing. The live coordinate is the directory `packages/shared/src/schemas/api-errors/` (barrel `index.ts`).
- `docs/superpowers/plans/2026-10-04-vacancy-sourcing-plan.md` — instructs the vacancy epic to "check before
  writing" whether an error code already exists, at the dead path. Left alone deliberately: the plan file is
  appended to by the running epic (#1030, #1032), and a one-line path fix inside it is a merge conflict for no
  functional gain. Fix it when the epic next touches that file.

The historical plans under `docs/superpowers/plans/2026-09-20-*` that _describe_ the deletion are correct as
history and must not be "fixed" (`doc-durability.md`). **Check on closing:**
`git grep -n 'schemas/api-errors\.ts' -- .claude docs/superpowers/plans/2026-10-04-vacancy-sourcing-plan.md`
is empty.

## 253. The Phase 4-B comment block in `payout.ts` documents a service deleted in #262 (2026-10-20)

(codebase-gardener; severity LOW-MED — a comment that misdescribes the live design, not a coordinate typo).
`packages/shared/src/schemas/finance/payout.ts` carries a block headed "Phase 4-B — Payment Channels
(crypto / bank / cash)" whose first sentence names `PaymentChannelService`
(`apps/api/src/finance/payment-channel.service.ts`) as "the entry point for drop-projects that need to settle
a validated `DROP_INCOME` with the company". That file was **removed** by #262 ("drop payout settles to
company account + senior PENDING obligation; remove legacy payment-channel"), so the paragraph describes an
entry point that no longer exists, while the schemas underneath it (the crypto-channel recipient shape and the
spec-aligned $3500 arithmetic) may well still be live.

**Why the gardener did not touch it.** Deciding what the block should now say requires knowing which of the
three channels survived #262 and which of the schemas below are still consumed — a finance-domain judgment,
on the surface where this repo requires a security-reviewer. Rewriting it blind would replace a comment that
is wrong about one coordinate with a comment that is wrong about the design. Needs a reader who can answer
"does the crypto channel still exist, and who consumes `pendingObligationSchema`'s neighbours".
**Check on closing:** the block either names the live settlement entry point, or the dead paragraph is gone
and the surviving schemas keep only the invariants that are still true.

## 254. The 225 unreferenced exports in `packages/shared` are forward contracts, not dead code (2026-10-20)

(codebase-gardener; severity INFO — recorded so the next run does not re-discover it as a sweep). A
whole-repo scan finds 225 exported symbols in `packages/shared/src/**` with **zero** references outside their
defining file. The number invites a dead-code PR. It should not get one: the distribution says what it is —
**79 of them are in `schemas/job-sourcing.ts`**, 17 in `resume.ts`, 7 in `vacancies.ts`, i.e. roughly half sit
in the contract surface of the vacancy-sourcing epic that is still being built (open PR #1026, r5 Task 1.3b).
Those exports are contracts written ahead of their consumers on purpose.

The remainder spreads thinly over mature modules (`teams` 13, `projects` 12, `telemetry` 11, `contracts` 9,
`users` 8, `pending` 8) and is mostly `z.infer` type aliases for endpoints whose API side uses the schema and
not the alias — individually harmless, collectively a contract-documentation style this repo has chosen.
**Re-measure after the vacancy epic ships**; a sweep before then would delete the epic's own interface.
**Check on closing:** the scan is re-run post-epic and the residual (non-epic) count is triaged module by
module, not in bulk.

## 255. Gardener run of 2026-10-20 — what was found, what was deliberately left (2026-10-20)

(codebase-gardener, weekly). The base is converging as the runbook predicted: the two large wins of the
2026-10-05 trawl and the always-on rules trim (#1014, 143 KB → 95 KB) hold, and this run found little to do.

**Opened this run (merge gated on green CI + clean reviewers):** the `undici` CVE chain closed by a bounded `pnpm.overrides` entry (22 of the 23
advisories, all through `apps/web > jsdom > undici`); and six stale `api-errors.ts` coordinates re-pointed.

**Measured and found clean:** `TODO`/`FIXME` across `apps/**` + `packages/**` = **2**, both dated deferrals
with a reason; `.find()` inside a `map()` in `apps/api/src` = **0**; CI wall-clock on `main` = **7–10 min**;
prod `any` = 42, flat; giants > 800 lines = **6**, and every one of them is either the resume/autosubmit
cluster the owner deferred until after rollout or the brand-new privilege generator from #1027 — nothing
newly grown.

**Deliberately not done, with the reason** (so the next run does not re-litigate it): a second trimming pass
over `.claude/rules/common/**` — #1014 stopped at 95 KB on the stated ground that the residual is mechanism
whose removal would drop a gate, and a week is not evidence that it was wrong; compressing the live agent
docs (`coder.md`, `code-reviewer.md`) — same deferral as item [[226]], these agents are running the vacancy
epic right now; the two unfixable advisories `braces` (via `@lingui/cli`) and `sprintf-js` (via `mammoth`,
see [[224]]) — both report `patched: <0.0.0`, no release exists to move to; `.claude/tasks` has grown to
**2.3 MB** but is not loaded into any session, so the ROI is in archiving it, not in a PR.

## 256. A control that cannot fail proves nothing — pair every pin with a negative control (2026-10-20)

**CLOSED the same day it was written, by doing it.** Recorded because the method generalises, not because the item is open.

Host-key pinning was added to every deploy step that reaches the VPS, and the deploy went green. That
green was close to worthless for most of those steps: **a successful step cannot distinguish "the
pinned value matched" from "the action silently ignored an input it does not declare."** Fifty of the
fifty-five steps ran on two action versions whose support for the input had been established by reading
their source — twice, independently — and never by running anything.

**The method that settled it.** A manually triggered workflow runs a **pair** of controls per version
against the real host: a deliberately wrong value, which must FAIL, and the correct value on the same
target, which must SUCCEED. A separate step then checks that the positive control's file **landed** and
the negative control's file is **absent**, which proves not merely that the step failed but that no data
crossed on a mismatch. An assertion step turns the outcomes into one readable verdict and names any
control that misbehaved.

**The positive half is the one people skip, and it carries the argument.** A step that fails because of
a typo'd path, a missing secret or a wrong user looks exactly like a step that fails because the pin
caught a mismatch. Without the positive control, a negative control proves only that something is
broken.

**Two traps worth carrying forward.** A negative-control step needs `continue-on-error`, so its
_conclusion_ reads `success` while its _outcome_ is `failure` — judge such a run by the assertion step,
never by eye over the step list. And a canary carrying a deliberately wrong literal trips any guard that
requires every step to agree on the value, so the exemption must be enumerated and tested, never silent.

**Check on closing:** any security control added to CI or deploy whose success path looks identical to
its absent path ships with a negative control, or the PR says why one is impossible.

## 257. Reviews that run find things; reviews that read confirm what the author already believed (2026-10-20)

Across one feature in one day, every finding of consequence came from executing something, and reading
produced confident wrong answers at the same rate — including the orchestrator's own.

- A handshake against the real host found that the pinned key was the wrong algorithm: the client
  negotiates one type while the pinned value named another. The value was genuine, the YAML valid, the
  guards green, and the pin would have failed every deploy.
- Mutating a guard eight ways found three weakenings its own tests did not kill; the tests had looked
  comprehensive.
- Replaying a command corpus through three consumers at two commits found that a batch of apparent
  regressions were false positives being removed — a distinction no amount of reading the diff would
  have produced.
- Forcing a process id across a digit boundary turned a latent random failure into a reproducible test.
- Read-only claims that proved wrong the same day: a call-site count given from memory, a variable
  declared unused when a second workflow read it, and the expected format of a value.

**What follows for dispatch.** A review brief should say what the reviewer is expected to **run**, and a
review that reports only what it read should be treated as a partial pass, not a clean one. Where
running is genuinely impossible, the report says so, and that sentence is the finding.

**Check on closing:** review briefs on security-surface changes name an expected measurement, and a
report without one is returned rather than accepted.

## 258. Third-party deploy actions are pinned by mutable tag, which also undermines the host-key guard (2026-10-20)

Every `appleboy` ssh/scp step in the repository — roughly sixty across the deploy, the canary and two
smaller workflows — references its action by **tag**, not by commit SHA. A tag is mutable: whoever
controls the repository can move it, and the next run of our deploy would execute different code with
the production SSH key in its environment.

Raised twice on 2026-10-20: by the security review of the rollout as a low-confidence item, and by the
automated commit review against the canary file. **The automated report named only the canary**, which
is the misleading part — the canary is six steps and the deploy is fifty-one. Pinning the flagged file
alone would leave the real exposure untouched while making the warning disappear.

**The part neither report mentioned, and the reason this is more than hygiene.** The host-key guard
(`check-ssh-action-host-key-pinned.py`) classifies each action **by tag name** to decide whether that
version supports fingerprint pinning, and the canary proved enforcement **for those tags**. If a tag
moves, both the classification and the proof silently describe code that is no longer what runs. The
guard would keep passing. So SHA pinning is not an independent improvement — it is what keeps the
host-key work true over time.

**What closing it involves**, so nobody underestimates it: resolve each tag to its SHA, keep the tag in
a trailing comment for readability, and teach the guard to key its version table by SHA with the
comment as the human label. A plain find-and-replace would leave the guard unable to classify anything
and, with discovery now failing closed, would turn the whole deploy red.

**Check on closing:** no workflow references a third-party action by a mutable ref; the host-key
guard's table is keyed by SHA and fails loudly on an unknown one; and the canary is re-run so the
enforcement proof is attached to the SHAs that actually run.

## 259. The `pre:bash:*` refusal texts are Russian, and no gate covers the hooks at all (2026-10-21)

The refusal paragraphs of `pre-bash-devserver-ttl-gate.sh`, `pre-bash-live-db-guard.sh` and
`pre-bash-safety.sh` are written in Russian, against the repository's English policy
(`.claude/rules/common/russian-language.md`). PR #1067 added more of it, consistent with the
surrounding block, and declared the deviation in its body rather than shipping it silently.

**Why it cannot be converted a hook at a time.** `ДЕГРАДИРОВАННЫЙ РЕЖИМ` is a cross-hook contract
token: `test-hook-command-corpus.sh` asserts it generically for every `narrowed` row across all three
hooks. Convert two hooks and that assertion breaks for them. `cmdscan.py` is not a usable
language-neutral substitute, because it appears in ordinary refusal text too, not only in the degraded
path. So the conversion is one atomic change over all three hooks, their coupled `--contains`
assertions and the `why` strings that `cmdscan.py` embeds in every hook's labels.

**The finding underneath the finding, and the more important half.** `check-no-russian-letters.mjs`
scans only `apps/api/src`. It exists to keep Russian out of the **product**, so `.claude/hooks/**` is
outside its scan entirely — nothing would have reported this, and nothing will report the next line
added. The conversion therefore holds only until somebody edits a refusal message, unless that scan is
widened to the hooks in the same change.

Test-case **labels** in the hook test files are deliberately out of scope: nothing asserts against
them, so there is no coupling argument, and translating them would bury a guard change under
translation noise.

**Check on closing:** no Russian remains in any `pre:bash:*` refusal text or in the `why` strings;
the corpus assertion keyed on the degraded-mode token still passes for all three hooks; and
`check-no-russian-letters.mjs` covers `.claude/hooks/**`, proven by a case that goes red when a Russian
line is added to a hook.

**Update 2026-10-21 — the count rose again and the branch is named.** The follow-up is
`architect/pre-bash-refusal-text-english`, and its scope table lives in PR #1067's body —
**re-derive the figures from there rather than from this entry**, because round six of that PR added
two more Russian refusal lines after the first measurement. The structure of the work is unchanged:
one atomic change across all three hooks, their coupled `--contains` assertions and the `why` strings,
plus widening `check-no-russian-letters.mjs` to `.claude/hooks/**` — without that last part the
conversion holds only until somebody edits a refusal message, since nothing scans the hooks today.

## 260. The senior-share override spec is flaky at 320px, proven rather than suspected (2026-10-21)

`projects-senior-share-override.spec.ts` asserts that the share row does not overflow its own box at
320px. On PR #1063 that assertion **failed and then passed on the identical head**, which is what makes
this a flake rather than a regression: two CI runs, one commit, different verdicts.

Worth recording how it was _not_ diagnosed, because the wrong method was tempting. A local run on a
scratch stack reproduced neither the failure nor a clean pass — 48 passed and 6 failed, different
tests, one of them on a Ukrainian catalog string — so that stack was not CI-equivalent and the agent
holding it correctly declined to call the CI failure a flake from it. The evidence is the CI-versus-CI
comparison on one SHA, not a local re-run.

The project's rule is zero tolerance for flaky E2E, so the answer is a diagnosis, not a re-run badge.

**Check on closing:** the overflow assertion either becomes deterministic or is replaced by one that
is, and the reason for the original non-determinism is written down rather than inferred.

## 261. The three external-URL guards are kept in step by hand (2026-10-21)

`externalHttpsUrlSchema` (shared), `isSafeExternalUrl` (web, the last barrier before `window.open`)
and `HTTPS_URL_PATTERN` (the CHECK on every stored navigation URL) must agree on one property: https
scheme, non-empty authority, no embedded credentials. Nothing tests that they agree. Each names the
others in its comment and asks the next editor to change all three together.

That this is a real risk rather than a theoretical one is already on the record: the guards diverged
once — the shared schema accepted `https://user:pw@evil.test/a` while the column refused it — and a
comment describing the schema by its old pattern outlived the fix by a whole review round.

The mechanism that would close it was built and deliberately removed: one corpus of inputs with an
absolute expected verdict **per guard**, consumed by the shared spec, the web test and the DDL
integration spec. Absolute per-guard verdicts rather than an agreement assertion, because an agreement
assertion stays green when a change makes both guards wrong in the same direction. It came out of
PR #1063 because keeping the corpus out of mutated source needed build configuration — a rename plus a
`tsconfig.build.json` — which is not a coder-zone edit and did not belong inside a fix round. The work
is preserved as an ancestor of that branch and the follow-up starts from it.

Closing it needs the architect, because the honest form of the change is "test data must not be
mutated source", which is a statement about the mutation gate's exclusion predicate rather than about
code.

**Check on closing:** one corpus, imported by all three test surfaces, carrying a per-guard expected
verdict for each input; a new input is added in one place; and the corpus is not a public export of
`@crm/shared`.

## 262. The auto-merge workflow dispatches post-merge CI without a retry (2026-10-21)

`auto-merge-on-label.yml` squash-merges and then dispatches CI on `main`, because a `GITHUB_TOKEN`
squash raises no push event and would otherwise leave `main` untested. On the #1063 merge that dispatch
returned **HTTP 500** from GitHub and the job went red after the merge had already succeeded.

Nothing was lost that time — CI and Deploy both ran on the merged SHA anyway — but the shape of the
failure is what matters: a transient server error on an unretried call turns a successful merge into a
red workflow, and with slightly worse timing into a `main` whose post-merge CI never ran. That is the
safety net that catches a semantic conflict between two PRs each of which was green alone, so losing it
silently is the expensive outcome.

A red run that nonetheless merged is also the hardest signal to read correctly: the natural reading is
"the merge failed", which is wrong, and the second-natural reading is "ignore it", which is worse.

**Check on closing:** the dispatch retries a transient failure and fails loudly only when the
post-merge run genuinely did not start; and the job's conclusion distinguishes "merge failed" from
"merge succeeded, dispatch did not".

## 263. `job_queue_actions.created_at` is writer-settable, and the purge now makes that load-bearing (2026-10-21)

The column is `defaultNow()` with no CHECK, and the only `BEFORE INSERT` guard in the queue DDL is on
`job_queue_generation_entries`. PR #1062 turned the end-of-retention purge on, which converts a
backdated audit row into evidence that **deletes itself within twenty-four hours**.

The append-only trigger cannot compensate, and this is the part worth reading twice: its two-year shape
bound reads that same untrusted column. So the assurance in the DDL header that misuse "cannot delete a
row that is not yet due" holds exactly as far as `created_at` is trustworthy, and no further.

It is deferrable only because no code path writes that table yet. The remedy is a `BEFORE INSERT`
trigger forcing `now()`, needing no schema change; it belongs with r5 Task 1.4b, and it **must land
before the first writer to `job_queue_actions` ships** rather than before any particular merge. The day
a writer ships without it, this stops being MED.

**Check on closing:** a supplied `created_at` cannot survive an insert into that table, proven by a
test that inserts a backdated row and finds `now()`; and the DDL header's claim is restated to rest on
the trigger rather than on the writer's good behaviour.

## 264. Two standing root overrides exist that `version-pins.md` does not record (2026-10-21)

PR #1066 added `pnpm.overrides` for `follow-redirects` and `vite` to close a gating advisory pair.
`.claude/rules/common/version-pins.md` is the single source of truth for versions and overrides — it
documents the Fastify override by name and reason and carries a forbidden-overrides section — so two
live overrides that exist only in `package.json` make that file quietly incomplete.

Each entry needs its advisory ids, the reason it exists, and a **checkable** drop condition. The
original wording offered was "when the dependency tree no longer resolves below the patched version",
which is true by definition and gives a reader nothing to verify; the concrete conditions are that
`follow-redirects` goes when the lockfile's own `axios` requires the patched range, and the other goes
when the two app specifiers are bumped.

Which is the second half: `vite` is a **direct** dependency of `apps/web` and `apps/landing`, so
bumping those two specifiers would have closed the advisory without a standing root override at all.
That was declined deliberately — the PR was unblocking the advisory gate for every open PR in the
repository, and swapping an override for specifier bumps changes what two apps resolve — but the
override is the less honest shape, because a root override hides from whoever reads an app manifest.

**Check on closing:** `version-pins.md` records both overrides with ids, reason and a condition
somebody can check; and either the direct specifiers are bumped and the `vite` override dropped, or the
reason for keeping it is written where the pins live.

## 265. The retention cron is missing from the repo-wide swallow-and-log registry (2026-10-21)

`swallowing-handlers-db-error-log.spec.ts` lists every cron that catches a database error, logs it and
does not rethrow, and asserts the shared contract on each: the SQLSTATE reaches the log through the
driver error on `.cause`, and no parameter values go with it.
`JobQueueActionRetentionCronService`, added by PR #1062, honours that contract and has an equivalent
assertion in its own spec, but is absent from the registry — the implementing agent made the local
assertion rather than reaching across zones, which was right.

The registry is the thing that catches the _next_ cron written without the contract, so a member that
is compliant but unlisted weakens it as a census even while the behaviour is correct.

**Check on closing:** the registry's case list includes the retention cron, and the duplicated local
assertion is either removed or marked as deliberately redundant.

## 266. A heredoc body handed to an interpreter bypasses both launcher gates (2026-10-21)

Measured with a marker script on `PATH`, so execution is a fact rather than a reading. Four shapes
**execute** while **both** launcher gates allow them — the TTL gate and the live-db guard, on the
pre-PR revision and on the post-PR one alike:

```
sh <<'EOF' … EOF          executes · allowed by both gates
bash <<'EOF' … EOF        executes · allowed by both gates
zsh <<'EOF' … EOF         executes · allowed by both gates
cat <<'EOF' | sh          executes · allowed by both gates
the same launch, plainly  refused by both gates   (control)
```

**Root cause, and it is not a parser disagreement.** A heredoc body becomes the segment's `payload`,
while `CODE_CAPABLE` re-reads a segment's **arguments** — so the body never reaches the code path and
**no consuming command is ever consulted**. An unquoted delimiter leaks identically, which is how we
know the literal-span exemption is not what carries it. This is explicitly a different hole from the
two-tokenizer differential in [[241]], with a different cause; neither entry should absorb the other.

**Why it went unseen for so long is the part worth keeping.** The module docstring asserted that _"the
consuming command is what decides, not the text"_ — false for `sh`, `bash` and `zsh`. The file said the
case was handled, so nobody looked. That sentence is now corrected in two places and the gap is listed
in the module's canonical **STATED GAPS**, marked **not accepted**, unlike the three gaps beside it —
so a reader looking for "what this scanner does not do" finds it where they look rather than where it
bites them. The same shape as every other defect found on PR #1067: the claim was true of an intention
and false of the code, and only a check that ran the code could tell.

**Not a regression, and that is why PR #1067 was merged over it:** the hole is equally open before that
PR, which also closed two real leaks that the previous revision allowed. Holding a false-positive fix
hostage to a pre-existing hole would have cost the measured false positives — including one that
refused a reviewer's own harness-authoring heredoc with 37 bogus "launches" — and closed nothing.

**Check on closing:** the four shapes above are refused by both gates while the plain-launch control
stays refused; a body consumed by an interpreter reaches the same code path as an argument would; and
the entry moves out of the STATED GAPS list rather than being re-described as accepted.

## 267. The hook refusal texts are a third converted, and the honest measure is the guard, not a number (2026-10-21)

PR #1073 converted the three launcher hooks' refusal text and `cmdscan.py`'s `why` strings to English,
with their coupled `--contains` assertions. **Four of twelve files are done — 85 of 257 refusal-text
lines** — and the rest sit behind `AGENT_EXCEPTIONS` in `check-no-russian-letters.mjs`.

**Do not trust the counts in this entry.** They were accurate when written and will drift with every
conversion, which is the defect this backlog keeps recording. The stable check is to run the guard:
`node scripts/devops/check-no-russian-letters.mjs` prints the live tally in its success line (files
scanned, hooks still excepted). A command that recomputes beats a number that decays — the same device
as the `Findings: … (N)` control line, and the reason this entry names the command rather than
restating the figure. Note also that "a third" describes **files**, not volume: the remaining eight are
smaller on average.

**Why the exception list is a ratchet rather than a carve-out**, and worth understanding before editing
it: a new hook is not on the list, so it is covered from its first line; and an excepted file that has
become clean **fails** the guard, so an entry cannot outlive its reason. Its review round found the
ratchet weaker than its own description in two ways — an excepted file could still _grow_, and a
removed entry was not detected though the message claimed it was — both closed in that PR. If you
extend the list, preserve both directions.

**Check on closing:** the guard's success line reports zero hooks excepted, `AGENT_EXCEPTIONS` is
empty or gone, and no `.claude/hooks` file contains Cyrillic.

## 268. Who owns a guard whose subject is another zone (2026-10-21)

`scripts/devops/check-no-russian-letters.mjs` is **DevOps-owned by location** and was extended by the
Architect in PR #1073 to scan `.claude/hooks/**` — which is **Architect territory by subject**. The
edit stands on an explicit Master instruction, the documented exception, and the architect flagged the
boundary rather than crossing it quietly.

The question is left deliberately open rather than answered by adding a glob: does ownership follow the
**file** or its **subject**? Both readings are defensible, and the comparable case decided differently
for a good reason — `scripts/devops/tests/lib/command-corpus.txt` _was_ added to the Architect zone in
#1067, because it is test data for tests the Architect already owns, so listing it described a boundary
that was already true. This is not that: it is a DevOps-owned guard being extended. Settling it inside
a translation PR is how two zone descriptions drift apart, which is the failure `zone-of-write.md`
already warns about in its own text.

**Check on closing:** `zone-of-write.md` and `.claude/agents/architect.md` say the same thing about
guards whose subject is `.claude/**`, and the rule states which of the two readings was chosen and why.

## 269. The Cyrillic scan is enforced in CI by wiring, not by a structural pin (2026-10-21)

`check-no-russian-letters.mjs` runs in CI only because it happens to sit in the `guard-test` runner.
Nothing ties it there the way `check-guard-tests-exist.sh` ties each hook to a negative test case: that
meta-guard reads the hook list from `.claude/settings.json` and **fails** when a hook has no test, so a
missing test cannot pass silently. The Cyrillic scan has no equivalent — change the runner's wiring and
the scan goes quiet **without failing**, leaving a guard that reports nothing and looks healthy.

Raised by the architect against their own work, which is the reason it is here rather than discovered
later. It is the same shape as the defect PR #1073 exists to prevent: a check whose absence is
indistinguishable from a pass. One more instance of the pattern that ran through this whole epic — a
guarantee that holds because of a fact nobody re-reads.

Adjacent and worth deciding together: a PR changing only `.md` files under `.claude/hooks` currently
gets `code=false` and skips the step entirely, caught only by the post-merge push run.

**Check on closing:** removing the scan from the runner makes a test go red, and a documentation-only
change under `.claude/hooks` is still scanned in the PR run rather than only after merge.

## 270. A claim contradicted by the author's own evidence, because the false sentence was the better sentence (2026-10-20)

A dependency review measured a parser's full option surface, identified two options as
entity-bearing, wrote a section naming them "load-bearing" and requiring they be pinned — and then
opened the same document with the headline claim that the parser had **no option** that could
resolve an entity. Both statements were in one file, by one author, in one sitting. The
contradiction was free to notice and went unnoticed for the length of the review.

The mechanism is not haste and not missing evidence. The false sentence was **stronger**: an
absolute reads as more authoritative than a qualified one, and the qualified version ("two options
bear on entities, but neither grants the library a capability it lacks") takes three clauses to
say. The author had already paid for the evidence, then discarded it at the summarising step
because the summary sounded better without it. That is the opposite of the failure in 256 and 257:
there, the gap was between what was measured and what was assumed; here the measurement was
correct and the **prose** contradicted it.

**Why review does not reliably catch it.** A reviewer who reads an absolute headline and its
supporting section together tends to **harmonise** them — reading the strong claim as a shorthand
for the careful one — rather than noticing they disagree. The two statements are far apart in the
document and each is locally plausible. It took a reviewer deliberately trying to **falsify** the
headline, treating it as a claim rather than a summary, to surface it.

Two further consequences showed up in the same document once the habit was looked for: a
competitor rejected as "slowest, lax" turned out to hold the worst advisory record on the
shortlist, and another rejected by characterising a third party's CVE history when the package's
own record was both measurable and sharper. In each case a measured fact was available and a
characterisation was shipped instead.

**What follows.** A claim stated as an absolute ("no option can", "it is impossible to", "nothing
in X does Y") is a **falsifiable assertion, not a summary**, and the cheapest guard is to attempt
the falsification before writing it — the attempt is usually one command against an already-
installed package. Where the honest claim is narrower, prefer the argument that survives an option
flip (a capability the dependency does not have) over one that rests on a current default. And
where a number or a measured fact exists, it belongs in the sentence instead of an adjective: a
characterisation cannot be re-derived by the next reader, and a count with a stated basis can.

**Check on closing:** in a long-lived decision document, every absolute claim either carries the
command that failed to falsify it, or is rewritten as the narrower claim that is true; and
rejections cite measured figures rather than adjectives where a figure was obtainable.

## 271. `apps/api` never typechecks its spec files, so a spec can assert against values that do not exist (2026-10-21)

Established by command, not by reading: `tsc -p apps/api/tsconfig.json --showConfig` resolves
`exclude` to `['node_modules', 'dist', '**/*.spec.ts', '**/*.test.ts']`, and **zero** of the 384
files in the program are specs.

**What it already cost.** Two specs in the `ApiJsonProvider` work used the literal `'DOU'`, which is
not a member of `JobSourceType` — the member is `'DOU_RSS'`. Nothing caught it but a runtime test,
because the compiler never looked at the file. This holds for every spec in the package.

**Why it belongs in this family of entries.** `pnpm typecheck` reads as covering the package, and its
green is indistinguishable from a green that checked the specs too. A spec asserting conformance to a
domain value that does not exist is the strongest form of a check that cannot fail: it is not merely
weak, it is about nothing.

**Closing it is not free, which is why it is an entry and not a fix.** Putting specs in the program
surfaces an unknown number of pre-existing errors across the package at once. Options, cheapest
first: a second tsconfig that includes specs, run as its own CI step, leaving the build config alone;
or include them in the main program and fix the fallout; or decide to leave it, recorded, so nobody
relies on spec-side types.

**Check on closing:** introduce a deliberate type error in any `*.spec.ts` under `apps/api` and
confirm the typecheck step fails. If it passes, the gap is still open — and that probe is its own
negative control, because a green from the current configuration proves only that it looked nowhere.

## 272. A guard test that asserts a timing property will be retried rather than fixed (2026-10-21)

The CI job `Guard Tests` failed one file of 46 — `[script] SIGTERM to the parent is forwarded to the
child` — on a branch that touches **only** `apps/api/src/job-sourcing/providers/`, with `Guard Tests`
green on main's four preceding runs and the separate guard-over-guards workflow green at the same
commit. A provider-only diff cannot affect signal forwarding in a devops script, so this is the test.

**Why it needs a fix rather than a retry.** The assertion is about **timing**: the parent must still
be alive, have installed its handler, and forward before the harness looks. Under CI load those
orderings drift. "The forwarding is broken" and "the test looked too early" are indistinguishable
from outside, and that ambiguity is what guarantees a retry next time somebody meets it.

The repair is to wait on an **observable fact** — the child recording receipt, with a bounded wait —
rather than on elapsed time. Whoever takes it should check whether the sibling cases in that file
share the shape.

**Check on closing:** run the file 50 consecutive times under artificial load. A single green run
proves nothing here, because a flake's green and a fix's green are the same green.

## 273. The meta-guard over hooks cannot require a test for a `post:` hook (2026-10-21)

`check-guard-tests-exist.sh` reads the registered hook list and requires, from every hook that can
refuse, a negative case in a test file. It locates that file by a **naming convention that encodes
the `pre:` family only** — so a `post:`-phase hook satisfies the meta-guard by having no required
test path at all, rather than by having a test. The zone-of-write rule has the same shape: the paths
it grants the architect for hook tests are named for the `pre:` family, so a test for a `post:` hook
would have no owner path either.

**Why it is a gap and not a style point.** The meta-guard exists because a hook without a negative
test is indistinguishable from a hook that never refuses. For the `pre:` family that reasoning is
enforced; for the `post:` family the same reasoning is stated and not enforced, and the difference is
invisible from a green run. Two `post:`-phase hooks are registered today, so this is not hypothetical.

**Closing it** means deciding whether the convention should be widened (one glob covering both
phases, plus the matching zone-of-write grant) or whether `post:` hooks are deliberately exempt
because they cannot block — and if the latter, saying so in the meta-guard itself, where the next
reader will be standing.

**Check on closing:** register a `post:`-phase hook that can refuse and give it no test. The
meta-guard must fail. If it passes, the gap is still open.

## 274. The swallowed-failure hook reads a command's position, and an option that takes a value shifts it (2026-10-21)

The advisory hook added for the swallowed-failure class decides by **argument position** — which
token is the command, which is its subcommand — and it recognises a fixed set of commands whose exit
code is worth warning about. An option that takes a separate value (the directory form of a version
control invocation is the common one) inserts a token before the subcommand, so position-based
reading can identify the wrong token and the hook stays silent.

**Why this is the predictable failure of the design rather than a bug in one line.** A reader keyed on
position is correct exactly while the shapes it meets match the shapes it was written against. The
only durable fix is to consume options-with-values explicitly, the way the shared command analyser
already does for the patterns it knows, instead of assuming the subcommand sits at a fixed offset.

**Scope note.** This is the hook, not the rule: the always-on rule covers the class, and the hook is
advisory, so a miss costs a missing warning rather than a wrong refusal. That is why it is an entry
and not a fix.

**Check on closing:** issue the same swallowing command twice, once plain and once with an
option-that-takes-a-value before the subcommand, and confirm both produce the warning. A silent
second form is the open gap.

## 275. The swallowed-failure class has a second half that no command-phase hook can see (2026-10-21)

A command-phase hook sees what is launched. It does **not** see the interior of a committed shell or
Node script, so the same swallowed-failure shape written inside a repository script is invisible to
it — and scripts are where the shape does the most damage, because a script's exit code is what a CI
step reports as a pass.

**Why it belongs with the rule rather than with the hook.** The rule names the class: an instrument
that reports a negative or a success when it did not look. The hook catches the half that passes
through the command line. The other half needs a **static scan over script interiors**, run in CI,
and that is a different instrument with a different false-positive profile — a deliberate suppression
of a known-harmless swallow is legitimate and must have a way to be written down, or the scan will be
switched off within a week.

**The sequencing matters.** The scan should be built only after the advisory hook has run long enough
to show what it warns about in practice, because its warning log is the cheapest available estimate
of the scan's false-positive rate.

**Check on closing:** commit a script whose interior swallows a failing exit code, with no
suppression note. CI must fail. A green CI means the second half is still unguarded.

## 276. A read-only reviewer is exempted from isolation, and therefore inherits the orchestrator's live workspace (2026-10-21)

The isolation rule deliberately does not force a worktree on a read-only agent: a reviewer reads the
diff through the forge, not through a local tree, so paying for a worktree would buy nothing. That
reasoning is sound and the exemption should stay. What the rule does not say is **where a reviewer
without a worktree actually stands** — and the answer is the dispatcher's own directory, which for
an orchestrator is a live write workspace with a branch checked out and, often, uncommitted work.

**Observed, not theorised.** A security reviewer dispatched during this cycle reported its worktree
as the orchestrator's own path, sitting on a branch the orchestrator had just created for unrelated
work. It did no harm — it read every reviewed file at the PR head through the object store rather
than trusting the tree it was standing in, and said so — but nothing in the rule required that. A
less careful reviewer reads the local tree, believes it is reading the PR, and reports on the wrong
content with no way for anyone to tell from the report.

**The sharper version of the same hazard.** The rule already forbids issuing a reviewer a path built
from the PR number, because that path is shared by construction between all reviewers of one PR. The
exemption reintroduces sharing by a different route: not between siblings, but between the reviewer
and its dispatcher. The second is worse, because the dispatcher is the one party that is certainly
writing.

**What closing it does not mean.** Not "give reviewers worktrees" — that spends the cost the
exemption exists to avoid. The candidates are to have the reviewer read at an explicit commit rather
than from whatever tree it inherits (which the careful one here did unprompted), or to make the
inherited directory's identity part of the report so a mismatch is visible, the way the existing
`Worktree:` line makes a lost worktree visible.

**Check on closing:** dispatch a read-only reviewer for a PR whose head differs from the dispatcher's
checked-out branch, and have it state which content it reviewed. If its report cannot distinguish
the PR head from the tree it was standing in, the gap is still open.

## 277. A reviewer's checkout can be removed by nobody, and the documented escape route does not exist (2026-10-22)

A reviewer that needs to run something makes its own checkout in the shared session scratchpad. The
cross-agent guard permits removing only a worktree it recorded as yours, and it records one only when
the path given to `git worktree add` was a **literal**. A reviewer that creates its tree through a
shell variable — the natural thing to do, and what the skill's own example suggests — is then refused
when it tries to remove it, correctly, because the guard cannot expand the variable and so cannot
establish whose tree it is.

The rule answers that case by saying: a tree you cannot remove is reported to the orchestrator, who
sees all agents while the reviewer sees none. **That route does not exist.** The orchestrator is
refused too, by the predicate that a tree outside its own worktree is not its to remove — and that
refusal is right as a rule and total in effect. Measured today: two reviewers asked the orchestrator
to remove their checkouts, the orchestrator was refused on the first, and the scratchpad now holds
**18** such trees, most of them marked prunable, from reviews closed days ago.

**Why this is worth fixing rather than sweeping.** The accumulation itself is cheap — disk, and a
noisy `worktree list`. What is not cheap is that the rule tells agents to do something that silently
does not work, so every reviewer that follows it believes the tree will be cleaned and it never is.
A rule whose remedy is unavailable trains the reader to stop reporting.

**What closing it does not mean.** Not loosening the guard: refusing to remove a path whose owner
cannot be established is exactly right, and the incidents behind it were three worktrees of live
agents destroyed by a sweep that looked safe from inside. The candidates are to make the recorded
form the easy one (so a reviewer's natural invocation is the one that gets recorded), or to give the
owner a documented sweep that the guard recognises as theirs, or to have the trees carry their own
expiry the way the dev-server launcher already does.

**Check on closing:** have a reviewer create a checkout the way the skill's example shows, finish,
and attempt removal. If neither the reviewer nor the orchestrator can remove it, the gap is still
open — and count the scratchpad's trees afterwards, because the symptom is accumulation rather than
any single refusal.

## 278. CLOSED (2026-10-23) — wall-clock ratio specs, superseded by the timing-job split

**Closed by the `test/wall-clock-ratio-tests` work.** Both wall-clock ratio assertions (this one and
`growth.spec.ts`'s R-5 exponent) moved into a dedicated `timing_specs` CI job that runs alone, and each
guarantee kept a DETERMINISTIC check in the unit suite — for this spec, a count of event-loop turns
(an `execFileSync` runner reads 0) plus a module-mock assertion that extraction never runs in-process,
neither of which depends on machine load. No threshold was changed and no `.skip` was added. Two
residuals are recorded as entry 306 rather than left inside a closed entry.

### Original entry, kept for provenance

## 278-orig. The resume-render responsiveness spec asserts a wall-clock ratio and fails on a slow runner (2026-10-22)

The API unit spec for resume rendering (`AC3 — API responsiveness during a resume render`, in the
resumes module's `resume-render-responsiveness` spec) measures the worst event-loop stall with PDF
extraction in-process and again in the sandbox, and asserts that the in-process figure exceeds the
sandboxed one by a factor of five. On a shared CI runner the ratio is a property of the runner's load,
not of the code: measured once, in-process `197 ms` against a threshold of `211 ms` (sandboxed
`42 ms` × 5), on a PR that touched no file under `apps/`. A re-run of the same commit passed.

**Why this matters.** The project's position is zero tolerance for flaky tests, and the newer Flow
Gate makes "all checks fire at 100 %" an explicit goal — a check that fails on unrelated PRs teaches
people to re-run red until it is green, which is the habit every other gate depends on people not
having.

**What closing it does not mean.** Not deleting the guarantee: off-thread parsing being kinder to the
event loop is the point of the sandbox. Candidates: assert an absolute ceiling on the sandboxed stall
alone, compare medians over several samples instead of single worst cases, or move the ratio check to
a nightly job where a single miss is a signal rather than a blocked PR.

**Check on closing:** run the spec repeatedly under synthetic CPU load (e.g. several parallel
`yes > /dev/null` processes) and confirm it does not fail; then confirm it still fails if the
extraction is forced back onto the main thread.

## 279. Retroactive review of the five unreviewed collaborator PRs — finding map (2026-10-22)

PRs #795, #809, #865, #866 and #867 reached `main` with zero reviews (the gap Flow Gate now closes).
A retroactive code-reviewer + security-reviewer pass produced **75** numbered findings, each checked
against `main` of 2026-10-22. Every identifier is accounted for here; the per-task files carry the
full text. Open PRs #868/#869 were deliberately not counted as fixes.

| Destination                                   | Identifiers                                                                                                                        | n   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --- |
| task `retro-mr-matcher-access`                | SR-865-H-1, CR-865-H-1, SR-865-M-2, CR-865-H-3                                                                                     | 4   |
| task `retro-mr-webhook-ingest`                | SR-865-M-1, CR-865-H-4, SR-865-L-1, SR-865-L-2, CR-865-M-5, SR-865-L-5, CR-865-M-7, CR-865-L-12                                    | 8   |
| task `retro-mr-en-catalog`                    | CR-865-H-2                                                                                                                         | 1   |
| task `retro-salary-ledger-integrity`          | SR-795-M-1, SR-795-M-2, SR-795-M-3, SR-795-M-4, SR-795-L-2, SR-795-L-3, CR-795-M-7, CR-795-L-2                                     | 8   |
| task `retro-salary-form-defaults`             | CR-795-M-2, CR-867-M-2, CR-795-M-4, CR-795-L-3, CR-795-M-3                                                                         | 5   |
| task `retro-manual-ddl-coverage`              | CR-795-H-1, CR-795-M-6, SR-866-M-1, CR-866-M-1, CR-866-L-1, SR-866-L-1                                                             | 6   |
| task `retro-txdate-policy`                    | SR-809-H-1, CR-809-M-3, SR-809-M-1, CR-809-M-1, SR-809-M-2, CR-809-H-1, SR-809-M-3, CR-809-L-3, SR-809-L-2, SR-809-L-3, CR-809-M-5 | 11  |
| task `retro-txdate-reporting`                 | CR-809-H-2, CR-809-M-6                                                                                                             | 2   |
| task `retro-business-day-clock`               | SR-809-L-1, CR-809-M-2, CR-867-L-3, CR-867-M-1, CR-867-L-1, CR-867-M-3, CR-867-M-4                                                 | 7   |
| backlog 280                                   | SR-865-L-3, CR-865-M-6                                                                                                             | 2   |
| backlog 281                                   | SR-865-L-4, CR-865-M-8, CR-865-M-9, CR-865-M-11                                                                                    | 4   |
| backlog 282                                   | CR-795-M-1, CR-795-M-5, CR-795-M-8, CR-795-M-9, CR-795-L-1, CR-795-L-4, CR-795-L-5, SR-795-L-1                                     | 8   |
| backlog 283                                   | CR-809-M-4, CR-809-M-7, CR-809-L-2, CR-809-L-4                                                                                     | 4   |
| closed — fixed on main (#866 / service split) | SR-795-H-1, CR-809-L-1                                                                                                             | 2   |
| closed — process, now enforced by Flow Gate   | CR-865-M-10, CR-866-L-2, CR-867-L-2                                                                                                | 3   |

Sum: 4+8+1+8+5+6+11+2+7+2+4+8+4+2+3 = **75**.

**Check on closing:** every task and backlog entry above is closed or carries a recorded decision.

### Progress, 2026-10-24 — 23 of the 52 task-bound identifiers closed on `main`

The map above assigns every identifier a destination; this says which destinations have landed. The
arithmetic is the point, so it is reconciled rather than asserted, and it is derived from merged PRs
rather than from anyone's recollection:

| Destination                        | PR          | ids | state                            |
| ---------------------------------- | ----------- | --- | -------------------------------- |
| `retro-mr-matcher-access`          | #1094       | 4   | merged                           |
| `retro-mr-webhook-ingest`          | #1097       | 8   | merged                           |
| `retro-mr-en-catalog`              | #1091       | 1   | merged                           |
| `retro-salary-form-defaults`       | #1093       | 5   | merged                           |
| `retro-txdate-reporting`           | #1108       | 2   | merged                           |
| carried by the collaborator's #868 | #868        | 3   | merged — see the note below      |
| `retro-salary-ledger-integrity`    | #1102       | 8   | open, `BLOCK`, 13-finding round  |
| `retro-txdate-policy`              | in progress | 9   | branch `fix/retro-txdate-policy` |
| `retro-business-day-clock`         | not started | 6   | waits on txdate-policy           |
| `retro-manual-ddl-coverage`        | not started | 6   | —                                |

Closed: 4 + 8 + 1 + 5 + 2 + 3 = **23**. In flight or pending: 8 + 9 + 6 + 6 = **29**. Sum **52**, which
matches the task-bound total in the map above (the remaining 23 of the 75 are the 18 deferred to
backlog 280-283 and the 5 already closed).

**The three ids carried by #868** are `SR-809-M-1` = `CR-809-M-1` (the "payment cannot predate its
source" check applying only when `txDate` is supplied) and `CR-867-M-1` (`periodToDates` building
local-midnight keys). The map's header says open PRs #868/#869 were deliberately not counted as
fixes, which was correct when written — **#868 merged 2026-10-23T20:17:53Z**, so they count now. The
two task files record the scope change; this row is what keeps the sum reconcilable across it.

**Not a closure:** `retro-txdate-policy`'s and `retro-business-day-clock`'s counts here are 9 and 6,
not the map's 11 and 7, for exactly that reason. If you reconcile against the map without reading this
paragraph the sum will look wrong by 3.

## 280. Meeting-recorder transcripts are kept forever and outlive their interview (2026-10-22)

`MeetingRecorderRetentionCronService` purges only webhook receipts. `interview_recordings.snapshot`
(transcript, notes, analysis — candidate personal data) is never deleted; deleting an interview sets
`interview_id` to NULL, which moves the transcript to the ADMIN unmatched queue instead of removing it.
The audit actions `recording-purged` / `media-purged` exist but nothing emits them; the unmatched list
has no pagination. (SR-865-L-3, CR-865-M-6.)

**Needs a decision before code:** a retention period (Legal) and whether deleting an interview deletes
its recordings. Candidates: an ADMIN purge endpoint that emits `recording-purged`, a snapshot retention
cron, cursor pagination on the unmatched list.

**Check on closing:** create and delete an interview with a linked recording on a scratch DB; the
transcript must be gone (or scheduled for deletion) by the agreed policy.

## 281. Meeting-recorder minor hardening (2026-10-22)

- SR-865-L-4 — `Aes256GcmHkdf.decrypt` does not pin `authTagLength: 16` (now shared by the credentials
  crypto v2 as well).
- CR-865-M-8 — admin connection dialogs and `LinkRecordingDialog` hold form state in `useState`
  instead of TanStack Form.
- CR-865-M-9 — `RelaxableThrottle` semantics changed for all callers (`Math.max(globalLimit, prodLimit)`
  with the relaxed TTL) with no test.
- CR-865-M-11 — `InterviewsService` defaults `new InterviewAccessPolicyService(db)` in its constructor,
  bypassing DI.

**Check on closing:** a short-tag ciphertext is rejected; `RelaxableThrottle` has a spec for both modes.

## 282. Multipart salary follow-ups (2026-10-22)

- CR-795-M-1 — `mySalaryState` / `mySalaryAggregateState` are computed per senior-summary request and
  read by no web code. Decide: wire a dashboard reader or delete the fields.
- CR-795-M-5 — salary unit specs pin Drizzle call shapes; behavioural coverage lives only in
  DB-skipping integration specs.
- CR-795-M-8 — `createAutomaticSalary` does three round trips and one transaction per employee; two
  set-based statements suffice.
- CR-795-M-9 — no E2E for "Add salary part"; the mocked funding-source E2E does not assert that
  `idempotencyKey` is sent.
- CR-795-L-1 — unreachable `BadRequestException` guard in `createSalary`; orphaned
  `FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH` error code.
- CR-795-L-4 — the multipart invariant (marker table, prepare/activate deploy) is not in
  project-state or the finance module doc.
- CR-795-L-5 — mandatory `idempotencyKey` breaks tabs open during a deploy with a plain Zod 400; a
  stable error code would let the client say "reload".
- SR-795-L-1 — between PREPARE and ACTIVATE a second manual part hits the legacy unique index → raw 500.

**Check on closing:** each bullet closed or explicitly declined in this entry.

## 283. Custom transaction date follow-ups (2026-10-22)

- CR-809-M-4 — `PaySalaryDialog` prefills the expected amount from today's rate even when the payment
  is backdated.
- CR-809-M-7 — no E2E for the eight dialogs that gained a date picker; no TZ matrix for date tests.
- CR-809-L-2 — the business-day idiom and the dialog clamp are copy-pasted (about eight and four
  places); one shared helper and one hook.
- CR-809-L-4 — the same "minimum date" hint has two msgids; unify.

**Check on closing:** one Playwright spec covers a date picker's min/max; the hint has one msgid.

## 284. A test derived from a defect inherits the defect's one-sidedness (2026-10-22)

**CLOSED as a lesson, not an open item** — recorded because it explains five separate defects in one
phase and the fix is a habit, not a change.

A finding says "X leaked" or "X was unbounded". The test written from it therefore asserts the
**refusal**: the secret is absent, the over-long input is dropped, the cap fires. The **acceptance**
side has no finding to prompt it, so nobody writes it — and a bound is exactly the place where only
the pair distinguishes `>` from `>=`.

Vacancy-sourcing phase 2 produced this five times: at the identity-key length cap, at the bounded
JSON depth bound, twice at the redaction caps, and at the redaction input budget. Each time the fix
was correct and its test was single-sided, so the next mutation round found it again in a new place.

The sibling variant: asserting that a value **changed** rather than **what it changed to**. A
redaction test passed on `changed === true` while the first 44 characters of a username sat in the
output.

**The rule:** the expected value comes from the **specification**, not from the bug report. Write the
acceptance-side assertion first, then the refusal side.

**Check on closing:** in a fix round's diff, every new bound has a case at the limit **and** one past
it. A diff with only refusal cases is the defect, whatever the finding said.

## 285. A true-but-incomplete claim survives the careful reader who would catch a false one (2026-10-22)

A false claim is caught by the first person who checks it against the code. A claim that is accurate
as far as it goes is **confirmed** by that person, and the part nobody thought to check stays wrong.

The clean example: a PR body stated that the response cache key included "source type, board, config
version, page and cursor". Every one of those five was true. It omitted `query` — so two sources on
one board, one searching `python` and one `java`, shared a cache entry; a `304` on the second
returned the first's body, and the batch reported `SUCCEEDED` with the wrong posting stored.

Same family, same phase: an exception file asserting that a dependency bump "would break" a spec,
true when written and false after the bump happened; a comment quoting a predicate that a later
commit had already replaced; and a decision record whose headline claim ("no option can resolve an
entity") contradicted its own supporting section two screens below.

**The repair is construction, not care.** Derive the claim from the thing it describes — build the
cache key **from the request** rather than from a list of fields someone must keep in sync, the way
the coverage floors are derived from `git ls-files` instead of a typed number. A claim that cannot
drift out of step needs no reader to re-check it.

### The same shape in this file's own numbering (2026-10-24)

**Measured.** Three unmerged branches each appended after the then-highest entry, 306, and **two
different findings were both numbered 307** — one on `docs/backlog-301-instances`, one on
`feature/r5-3.6-rss-adapters` — because two sessions read "the highest is 306" at the same moment. A
third branch's 308 avoided it only by accident: that agent had been told 307 was taken by information
the other session could not have had.

**The hazard is the resolution, not the collision.** Both appends land at the end of the same file, so
git conflicts — and the tempting resolution, keeping both sides, yields a file with two entries
numbered 307 and **no conflict markers left to notice**. One of the two branches carries seven
in-code `[[307]]`-style pointers, so a silent concatenation would leave some of them citing the other
session's entry. Whoever hits that conflict renumbers; they do not concatenate.

**Why it belongs in this entry rather than its own.** A hand-assigned sequential number in an
append-only file shared by concurrent writers is an enumeration maintained by care, which cannot be
re-derived and drifts the moment two people hold it — this entry's case exactly.

**What actually closed it, and what only looked like a cure.** The obvious candidate is a
collision-proof identifier: a date-plus-slug heading (`2026-10-24-scratchpad-flat-directory`) turns a
simultaneous append into a textual conflict in two places rather than a number race. That is a
**trade, not a cure**, and this entry is the wrong place to overstate it: it moves the collision to
two sessions choosing the same slug on the same day — less likely, not impossible — and it costs the
ability to order entries by eye. What genuinely closed the hazard in the measured case was something
else: **both sides removed their pointers' dependency on the identifier**, citing each entry by its
title instead of its number. After that a renumber costs one heading per side and the merge order
stops mattering for correctness, whatever the identifier scheme is. That is `doc-durability.md`'s own
rule — a symbol rather than a coordinate — applied one layer up, to the address of a record rather
than to a line in a file. Changing the file's heading convention remains a larger decision than any
one PR and is not taken here.

**Check on closing:** a sentence in a long-lived document that enumerates fields, versions or
behaviours is either generated from the source, or carries the command that re-derives it. An
enumeration maintained by hand is a future true-but-incomplete claim.

## 286. A fresh worktree cannot commit, and only the expensive fix is written down (2026-10-22)

A fresh agent worktree has no `node_modules`, so husky's `pre-commit` fails `ENOENT: lint-staged` and
**nothing can be committed** — including a branch whose whole diff is two markdown files.

The obstacle is documented, and so is the heavy fix (a full `pnpm install`, plus a web build for the
generated route tree). The **cheap** fix is not: put the main checkout's `node_modules/.bin` on
`PATH` for the commit, so the real `lint-staged` and `prettier --write` run against the worktree's
staged files.

That gap has already cost a policy violation. One coder, blocked by it, reflexively ran
`git commit --no-verify` — forbidden with zero tolerance — then caught itself, reset, and recommitted
through the hooks, disclosing the lapse. A second agent hit the same wall the same day and found the
`PATH` route on its own. The undocumented cheap path is where an agent under time pressure reaches
for the forbidden one.

**Check on closing:** cut a worktree with no `node_modules`, stage a markdown change, commit. If it
succeeds with hooks running and without an install, the cheap path is available. If the only
documented routes remain a full install or `--no-verify`, the gap is open.

## 287. `xml/growth.spec.ts` gates on a timing exponent and fails under load (2026-10-22)

The ReDoS/quadratic-growth gate for the XML port asserts a growth **exponent**. Measured during
phase 2: at one PR's base commit, with the change absent, the full `job-sourcing` suite failed **4 of
4** runs, a different exponent assertion each time; on the branch, 2 of 3; in another agent's run it
failed once at 2.02 against a 2.0 bound and then passed twice.

The gate is worth having — it is the only standing check on the class that dominates real XML parser
advisories — which is why the fix is **not** to raise the threshold. Raising it quietly removes the
protection R-5 exists to provide. The likely repair is warm-up plus best-of-N, or expressing the
assertion as a ratio against a same-run baseline rather than an absolute exponent, which is what the
port's own R-5 assertions already do after absolute ceilings proved unusable under the gate's own
4-way concurrency.

**Update 2026-10-23 — it is not a local-load artefact.** The same single assertion failed on a **CI
runner**, on a diff of two docstrings whose import closure is byte-identical to `main`: 1 failed of
9827, exponent 2.026 against the 2.0 bound. It also blocked one agent's pre-push gate six times in a
row before passing on the seventh with unchanged code. So the gate now costs merges as well as agent
time, and "under load from sibling agents" is no longer a sufficient description of when it fires.

**Check on closing:** 50 consecutive runs under artificial load, green. One green run proves nothing:
a flake's green and a fix's green are the same green.

## 288. A stale justification keeps a dead audit exception alive (2026-10-22)

`scripts/devops/pnpm-audit-exceptions.json` held an `@xmldom/xmldom` group covering ten GHSA ids.
Its text justified the exception by asserting that bumping to the patched version **would break**
`resume-text-extraction.service.spec.ts`. That bump had since happened, the spec had been rebuilt for
it, and it passes — so the justification had been false for some time, and `pnpm audit` no longer
reported any of the ten ids. The gate's own stale-exception warning named them; nothing acted on it.

This is worse than a stale comment. A comment misleads a reader; a stale **justification** is a
standing licence to ignore a real advisory, because the next person who finds the group reads a
reason and moves on. An exception file is the one place where "true when written" is not good enough.

**Check on closing:** every group in that file carries the date its reachability claim was verified
and the command that verified it (`pnpm why <pkg> -r`), and the gate's stale-exception warning is
treated as a failure to triage rather than noise.

## 289. Auto-merge cannot merge a draft, and says so only in the job log (2026-10-22)

A PR was labelled `merge-approved` with every required check green and did not merge. The
auto-merge workflow failed with `GraphQL: Pull Request is still a draft (mergePullRequest)`. The PR
then carried a red `Squash merge if CI green` check and a `ci-failed` label, so its `mergeStateStatus`
read `UNSTABLE` — which looks like a code problem and is not one.

Cost: one cycle, and a misleading signal while it lasted. The fix is trivial once known
(`gh pr ready <n>`, then re-apply the label to re-trigger), and the workflow did behave correctly —
it refused and named the cause.

**Check on closing:** either the auto-merge job states "draft" in its own check summary rather than
only in the log, or agents open PRs ready-for-review by default. The second is cheaper and is now in
the dispatch briefs.

## 290. A requirement deferred to a task that does not own it belongs to nobody (2026-10-22)

Task 2.4b found that the fetch port hands the collection loop an already-decoded **string**, so the
XML port's byte-level decoding never runs on a fetched feed: a mis-decoded feed arrives full of
U+FFFD and was parsed as a **successful** feed with corrupted titles. The PR deferred byte-faithful
decoding to Task 2.5.

But the plan puts charset in **Task 2.2**, and Task 2.5 has no bytes or charset item at all. So the
deferral pointed at a task that would never pick it up, nothing in the repository tracked it, and
2.2's extension was outside the phase's approved scope — the requirement would have fallen between
the two and stopped being anyone's.

A deferral names a **destination**, and an unchecked destination is indistinguishable from a decision
not to do the work. This is the planning-level form of entry 285: "deferred to 2.5" was a claim that
read as complete.

**Check on closing:** a PR that defers a requirement names the task that owns it **and** that task's
own description contains a matching item. If it does not, the deferral is a drop.

## 291. The meeting-recorder auto-match decides a safety question by comparing two different clocks (2026-10-23)

`matchMeetingRecording` admits an interview as an auto-match only when its match key changed **before**
the call started — the guard that stops a transcript being attached across candidates after somebody
edited a call URL. The two sides of that comparison come from **different clocks**:
`interviews.matchKeyChangedAt` is written from the application clock (`new Date()` at the two places in
`InterviewsService` that change the key), while the call's start time is the **provider's** reported
value, taken from the recording payload.

**Why that is a defect rather than a nicety.** The predicate asserts an ordering of events, and an
ordering is only meaningful inside one clock domain. If the provider's reported start runs ahead of our
server clock — ordinary skew, no adversary needed — a key changed _after_ the call still compares as
earlier, and the auto-match proceeds on exactly the state the guard exists to refuse. The failure is
silent: an auto-match that should have been declined looks like a successful one.

**Not trivially exploitable, and that is why it is an entry rather than an incident.** The payload
arrives over a signed webhook, so the start time is not freely attacker-chosen. The reachable case is
clock skew between our host and the provider.

**What a fix has to decide** (the shape, not the line): which clock is trusted, and how the other is
brought into it — comparing against the server's receipt time of the first event minus the reported
duration, or keeping the provider's value but requiring a margin, or writing `matchKeyChangedAt` from
the database's `now()` so at least our half has one source. A margin alone moves the boundary without
removing the differential, so whichever is chosen should say what it does about the other half.

**Found by** the automated security review on a merge commit, attributed to the already-merged work that
introduced the column, not to the PR that merged it.

**Check on closing:** set the host clock behind the provider's reported start by more than the intended
margin, edit a call URL after the call began, and confirm the auto-match is refused. A test that only
exercises the ordering within one clock cannot see this.

## 292. The grant tuple bounds how many exceptions exist, not which columns they name (2026-10-23)

The privileges manifest's column-write exceptions are typed as a fixed-length pair, so adding a **third**
exception requires a type change a reviewer will see. That property holds and is what the prose claims.
What it does **not** bound is the column list inside each exception: appending a seventh column to the
evidence-row INSERT grant is the likelier widening, and it is gated only by exact-value tests rather
than by the type.

**Why it is worth an entry.** The type was chosen precisely so a widening cannot arrive as an appended
line. That reasoning applies with equal force one level down, where it is not enforced. Three tests
currently catch it, which is why this is a follow-up and not a finding — tests are a weaker gate than a
compile error, not an absent one.

**Check on closing:** append a column to the evidence grant's column list and confirm the build fails,
not merely a test.

## 293. `[:print:]` admits invisible and direction-overriding characters (2026-10-23)

The redaction function refuses a request id containing a non-printable character, because that id is
written into the server log that serves as the evidence channel for redactions. Measured during review:
the class rejects the line separators and the C0 controls — so a forged **line** is impossible, which is
the threat the guard was sized for — but admits zero-width space and the right-to-left override.

**The residual is a reader problem, not a log-integrity one.** Those characters cannot break a log line;
they can mislead a human reading one in a terminal. Narrowing the id to a strict character set would
close it.

**Locale note, because it changes the direction of any drift:** `[:print:]` semantics for non-ASCII
depend on the database's ctype. The databases measured are UTF-8; on a `C`-locale cluster the guard
becomes **stricter**, never looser.

**Check on closing:** pass an id containing a zero-width space and confirm it is refused.

## 294. `apps/api`'s typecheck builds only one of the two workspace packages it depends on (2026-10-23)

In a fresh worktree `pnpm --filter @crm/api typecheck` fails on unresolved types from `@crm/inference`,
because the script builds `@crm/shared` and not `@crm/inference`. The failure is unrelated to whatever
is being changed, which is the expensive part: every agent that provisions a new worktree meets a red
typecheck that points at files it did not touch, and has to discover the missing build step.

**The same shape with a different package** is already documented for the web route tree, so the gap is
the script's dependency list rather than one package.

**Check on closing:** provision a worktree, run that typecheck with no manual builds, and confirm it
passes or names the exact build it needs.

## 295. Byte-faithful decoding has an owner and no tracked item (2026-10-23)

Phase 2's feed ingestion receives **text** from the fetch seam, not bytes. So the XML port's decoder
never runs on a fetched feed, and a feed the fetch already decoded wrongly is caught only by a
heuristic: a body holding U+FFFD whose declaration is not UTF-8 is refused as drift. The deferral is
deliberate and now points at the task that owns content type and charset — but owning it in a plan
section is not the same as being tracked, and the carryover note states this extension sits outside
the owner-approved phase-2 scope. A requirement whose owner is a task nobody has started is a
requirement with no date.

Two consequences are already written into the code and the merged PR body, and they are what makes
this more than tidiness: a board declaring a legacy single-byte encoding refuses its **whole feed**
when one employer pastes one replacement character, and a feed declaring `utf-16` can **never**
collect, because the injected BOM and the declaration disagree by construction.

**Check on closing:** the fetch seam hands bytes plus a declared charset to the XML port, no BOM is
injected, and a `utf-16`-declaring feed collects.

## 296. The response cache stores a third party's validators unbounded and replays them as headers (2026-10-23)

The conditional-request cache keeps the `ETag` and `Last-Modified` a source returned and sends them
back as `If-None-Match` / `If-Modified-Since` on the next request. Neither is bounded or validated on
the way in, and both are attacker-controlled: a source can return a megabyte of header, or bytes that
are illegal in a request header, and the next request carries them.

This is the shape already documented for cursors — a value a third party chose, persisted and then
replayed into our own request — so the answer should be the same one: a length bound and a character
whitelist at the point of storage, in the store binding rather than at each call site.

**Check on closing:** an oversized or illegal validator is refused at storage, the next request omits
it rather than sending it, and a test asserts the refusal on both the store and the send side.

## 297. A readable cache slot is free-form, so an adapter can put a credential in it (2026-10-23)

Each cache entry is addressed by a one-way digest plus a human-readable **slot**, which exists so a
person reading the cache can tell what an entry is. The slot is supplied by the adapter as free text
and is stored as given. Nothing stops an adapter author from interpolating a query string, a token or
a signed URL into it, and unlike the digest the slot is not one-way.

No adapter does this today; the exposure is the next one written, which is why it belongs with the
other "the next author" items rather than as a defect.

**Check on closing:** the slot's type or its construction prevents free interpolation — a closed set
of labels, or a constructor that rejects anything but a short literal — and a test pins the refusal.

## 298. One hostile entry discards a whole page, and a feed is one document (2026-10-23)

Two independent refusals in feed ingestion are page-wide rather than entry-wide: a body holding
U+FFFD under a non-UTF-8 declaration, and a genuine identity collapse where two entries carry distinct
provider ids on one link. Both refusals are **correct as refusals** — this is not a false positive —
but a feed arrives as a single document, so the cost of either is the entire source for that run, and
it repeats every run until the offending posting rolls off.

The open question is availability, and it has two defensible answers: quarantine the offending entry
and collect the rest, or keep refusing the page because a document that cannot be trusted in part
cannot be trusted in whole. That is a product decision about whether partial coverage beats none, so
it was deliberately not settled inside a fix round.

**Check on closing:** the chosen answer is written down with its reason, and a test asserts the
behaviour for both shapes — not only for the one that was easier to reproduce.

## 299. The collapse gate is blind in one direction, and only the blind direction is undocumented behaviour (2026-10-23)

The loop's identity-collapse check runs **only** when identity fell back to the canonical URL. It
therefore catches an adapter whose URL is coarser than the provider's ids, and misses the reverse: an
adapter that pins a coarser native id than it reports makes identity key on that id, the check is
skipped, and two distinct postings collapse onto one key stored as a success, silently.

The justification "the adapter declared it" holds for the adapter's choice of **field**, never for the
feed's **values** in that field. The contract is now stated in the hook's own docstring, which is the
minimum; what is not decided is whether the loop should detect the second direction at all, since
doing so means comparing values the adapter told us to trust.

Latent today, verified against the tree rather than inferred: the only feed binding reads one field on
both sides and its mapper cannot set the id, and no adapter exists on the JSON binding. It becomes
live with the first phase-3 adapter that derives the two from different fields.

**Check on closing:** either the second direction is detected with a test that fails without the
check, or a written decision says it is the adapter's responsibility and the docstring is the whole
answer.

## 300. The cross-agent hook records worktree ownership only for an unchained `add`, so no reviewer can clean up after itself (2026-10-23)

The isolation hook permits removing a worktree only when a record ties that path to the agent, and it
writes that record when it sees the `add`. It does not write one when the `add` arrives as a chained
segment after a `cd`, or when the harness has since changed the agent's working directory — and in
both cases the later `remove` is refused as unverifiable, **even for a literal absolute path the agent
created itself**.

The refusal is the correct default: ownership that cannot be verified must not be assumed, and three
incidents are why. But the effect is that honest cleanup is impossible for a whole class of correct
usage, so scratch checkouts accumulate until the owner removes them by hand. Four were orphaned in one
day by four different reviewers, and the orchestrator is refused as well, so there is no in-session
escalation path.

**Check on closing:** an agent that creates a worktree at a literal path can remove that same path in a
later call regardless of how the `add` was composed or whether its working directory changed, while a
sibling's path stays refused — both arms asserted by the hook's own tests.

### A second, measured cause: the macOS `/tmp` symlink (2026-10-24)

Ownership also fails to record when the path is **correct, literal and the agent's own**. Measured:
`/tmp` on macOS is a symlink to `private/tmp` (`ls -ld /tmp` → `/tmp -> private/tmp`). The harness
issues the scratchpad to an agent as a `/private/tmp/...` path, so `git worktree add` is called with
`/private/tmp/...`, while the hook's recorded scratchpad root is the `/tmp/...` spelling. The two name
the same directory and do not match as strings, so nothing is recorded and the later
`git worktree remove` is refused with `WORKTREE-REMOVE` — on a tree the agent demonstrably created.

An agent that did everything the rule asks (literal path, own identifier in the name, inside its own
scratchpad) still cannot clean up after itself. The affected agent declined to force past the guard,
which is correct — "this looks abandoned" is not an observation it can make — so the refusal is working
as designed on the removal side while the recording side is the defect.

**The escape route is closed from both ends, measured 2026-10-24.** The rule's answer to a tree you
cannot remove is "report it to the orchestrator, who sees all agents". The orchestrator is refused
too, by `WORKTREE-REMOVE`: the path is not _its_ worktree either, and the refusal is correct as a rule.
Tried from the orchestrator with the literal path, after the creating agent had already been refused —
so neither the agent that made it nor the only party the rule names as the fallback can clear it, and
it genuinely falls to the owner. **Measured scale at the time of writing: 16 such checkouts across two
sessions' scratchpads**, most from reviews closed hours earlier.

**The app's own cleanup cannot reach these (measured 2026-10-24).** The obvious alternative to an
owner-run command is the desktop app's "Clean up inactive sessions" facility. It qualifies sessions by
**no activity for at least 30, 60 or 90 days** — those are the only accepted values — so a tree
stranded today is outside its reach by design, and will stay so for a month. It also cleans
_session_ worktrees, not the scratchpad checkouts reviewers create. So the escape route is closed from
a third end as well, and "just use the app's cleanup" is not an answer to this entry.

A related sharp edge found in the same attempt: passing the path through a shell variable gets
`WORKTREE-OPAQUE` instead, because the hook cannot expand it and refuses rather than guess. That is
right, and it means any batch cleanup must expand each path to a literal first — which is also why a
loop over `git worktree list` cannot be the fix.

**It is a leak with a rate, not a backlog of 16 (re-measured 2026-10-24, ~50 minutes later).** The
count went 16 -> 19 in that window, and the three new ones are exactly the three reviewer checkouts
dispatched in it: one per review that needed to run something. So the number in the paragraph above is
not a quantity to clear once; it is a reading of a meter. Whatever the figure says when you read this,
it is wrong and it is larger.

That changes the priority rather than the diagnosis. A fixed backlog of stranded trees is housekeeping
the owner can do when convenient; a leak of one tree per review is a cost on every review this repo
runs, and the registered-worktree total is already 81. Re-measure before acting, reading the producer
into a variable first so that an unread list cannot pass for an empty one:

```
wt=$(git -C <main repo> worktree list --porcelain)
printf '%s' "$wt" | grep -c '^worktree '                    # total registered
printf '%s' "$wt" | grep '^worktree ' | grep -c 'claude-501' # in session scratchpads
```

**Check on closing:** an agent creates a worktree at the `/private/tmp/...` path the harness issued it
and then removes it, with no intervening step. Both commands succeed. And a tree whose creator is gone
can be cleared by _someone_ without forcing past the guard.

## 301. A verification can be real but less precise than the claim it supports (2026-10-23)

`verification-integrity.md` distinguishes "did not look" from "looked and found nothing". The retro-PR
wave produced a third shape it does not cover: **looked at less than was then asserted.**

Measured. An agent reported `Pushed: <branch> @ cd23a486173f3b42c3d3e2a3e0c0ec2a4a1dbd3d`, with the
evidence "`git ls-remote` returns `cd23a486173f`, identical to local HEAD". The comparison was
genuine — and true, for the twelve characters it covered. The full forty-character sha printed beside
it does not exist in the repository; the real parent is `cd23a486173fb5957d3968c5b6a2e17b54f299a0`,
which shares exactly that twelve-character prefix. The orchestrator then passed the published sha into
a reviewer's dispatch, where the compare API answered 404 and the reviewer had to find the real parent
itself.

Nothing was lost, because the branch was genuinely pushed — but the artifact the project treats as the
checkable assertion (`stream-watchdog.md`'s `Pushed:` line, whose whole purpose is that a reader can
re-run it in one command) was not re-runnable. A reader who pastes it gets "object does not exist" and
cannot tell a mistyped sha from a lost push.

**Why this is worth a rule rather than a reminder.** Short-prefix comparison is the normal, correct way
to eyeball git output; the defect is only in stating the long form afterwards. So the cure is not "be
careful" but a form: compare and state the SAME object. Either print what the command printed, or
compare full shas (`git rev-parse HEAD` against `git ls-remote origin <branch> | cut -f1`).

**Check on closing:** take a report carrying a `Pushed:` line and run `git cat-file -t <sha>` on the
exact string it published. It resolves, or the line was never checkable.

### Two further instances, both within hours of the entry being written (2026-10-24)

The entry above was written from an agent's report. Both people who then read it committed the same
class — which is the argument for the mechanical cure rather than the attentive one.

**Instance 2 — the orchestrator, against another session's branch.** Printed a head sha truncated to
nine characters for a status line, then typed a full forty-character sha into
`gh pr merge --match-head-commit`. GitHub refused: _"Head branch was modified."_ Measured afterwards —
real head `a0a1d3410216dcd6d6044b12a2ed4f7047239dd1`, asserted
`a0a1d3410b65ba54eb4cd59f26ad7e0ee1ea2b1b`; nine characters shared, the rest invented. Nothing about
the branch had moved. The branch's own session first explained the refusal as a race with a PR-body
edit (a body edit does re-trigger Flow Gate), and then **withdrew that explanation**: it had a true
fact that fitted the symptom and offered the fit as the finding, without asking the one question that
settles it — _what sha did you pass?_

**Instance 3 — a sample asserted as a census.** A session briefed a devops agent that `zod` was
declared in **three** manifests (`apps/api`, `apps/web`, `packages/shared`), stated as a measured fact.
It is **five**: `apps/landing` and `packages/inference` also resolved the vulnerable entry. Three
places had been looked at; the look was reported as the count. The agent exceeded its brief and found
the other two, which is the only reason the advisory fix was not a _failed_ fix — a bump touching only
the obvious three leaves the gate red and looks like a bad patch rather than an incomplete search.

**What the three have in common, and the precision the cure needs.** Not carelessness: in each case a
real observation was made and then restated at a width it did not cover — twelve characters published
as forty, nine as forty, three manifests as "three manifests". Procedural rules in this repo are
observable only through an assertion a reader can re-run, and in instance 2 the published claim had no
re-runnable assertion beside it: the forty characters came from fingers, the nine from a command. So
the repair is a **substitution, not a discipline** — pass the thing the command printed
(`--match-head-commit "$(git ls-remote origin <branch> | cut -f1)"`), and for a count, publish the
command that produced it (`git grep -l '"zod"' -- '**/package.json'`) rather than the number alone.
"Be more careful" does not close any of the three; printing the instrument's own output closes all of
them.

**Instance 5 — a restoration verified against memory (2026-10-24).** After the scratchpad-filename collision recorded
in this file (the entry headed "The session scratchpad is one flat shared directory"), the agent that had overwritten another PR's body rebuilt it and declared it restored — having
verified by grepping for two strings it remembered writing, finding them, and stopping there. Two
lines added earlier by someone else were still missing and would have failed the Flow Gate again. The
shape is this entry's exactly, applied to a recovery rather than a measurement: a sample (what I
remember putting in) asserted as a census (the document is whole). The cure is the same substitution —
verify a restoration against the artifact's required contents, not against recall; for a PR body, the
Flow Gate's own step list is that contract and it is machine-readable.

## 302. Truncating a command's output hides what the command was run to find (2026-10-23)

`pre:bash:swallowed-failure` catches a discarded stderr piped into a counter. It does not catch the
adjacent move: reading a command's output through `tail -N` / `head -N` and acting on what survived.

Measured, same wave: an agent ran a merge, read the result with `tail -6`, and so did not see that
`deploy.yml` had ALSO conflicted — it noticed only because a wiring guard failed afterwards and
`git status` showed `UU`. Its own write-up names the lesson: truncating a command's output is
precisely how a second conflict hides. A merge reports one conflict per file; a window onto the end of
that report is a window onto some of the files.

Same family as form 1 in `verification-integrity.md` — the information that would have corrected the
reader went somewhere the reader did not look — but the channel here is truncation rather than
redirection, so neither the rule's text nor its hook mentions it.

**Candidates:** state in the rule that a command whose output is EVIDENCE is read whole (or filtered
by a predicate that cannot drop a case, e.g. `grep -c '^CONFLICT'` for the count and then the list);
extend the advisory hook to flag `tail`/`head` applied to `git merge` / `git rebase` / `git cherry-pick`
output. The hook half is optional; the rule half is the point.

**Check on closing:** a merge with conflicts in two files, read the way the rule prescribes, reports
both.

### Instance 2 — truncation plus an anchor that could never match (2026-10-24)

A PR body carried "E2E 866 passed, 0 failed". It was false, and the author diagnosed its own
instrument rather than its memory. **Two faults compounded:** the run was captured through
`| tail -40`, so only forty lines ever existed to search; and the search was
`grep '^\s+[0-9]+ failed'`, which cannot match Playwright's summary line because ANSI escapes
(`ESC[1A ESC[2K`) precede the whitespace. The absent match was read as zero failures — a count offered
as proof of an absence with no proof the input was read, which is `verification-integrity.md`'s form 1
reached by a different route.

Re-measured properly (full stdout to a file, ANSI stripped, pattern unanchored, reconciled against
`--list`): **866 passed · 238 failed · 26 skipped · 13 did not run = 1143**, matching the chromium
total exactly. The reconciliation against a known total is what turned a plausible number into a
checkable one, and it is the cheap habit worth copying: a count that does not have to add up to
anything is a count nobody can falsify.

### Instance 3 — a red step retried until green, with its reason truncated away (2026-10-24)

Reported verbatim by the agent on PR #1110, and it is worth preserving in its own words because the
honesty is what makes it usable: _"The first `git push` failed in the husky pre-push script (code 1),
and I did not capture why. A second attempt piped through `head` and its result was unclear, so I
discarded it. The third, redirected to a file, passed and pushed."_

Three separate failures of instrumentation in one sequence, and only the third attempt was
instrumented well enough to be believed:

1. **A red step whose reason was never captured.** A pre-push failure is the gate doing its job; a
   pre-push failure nobody read is indistinguishable from flake, and the only available response to
   it is to try again. That is the habit every other gate in this repo depends on people not having.
2. **`| head` on the diagnostic output**, which is this entry's own defect: the reason was probably in
   the lines that truncation discarded.
3. **An "unclear" result discarded rather than resolved.** Discarding an inconclusive measurement and
   re-running is the same move as re-running red until green; it differs only in that nobody can
   later tell it happened.

The agent reports no hook was bypassed, and the final push is independently checkable
(`git ls-remote origin` matched local HEAD), so the work itself is sound. **The defect is that
red -> red -> green across three attempts is on the record with no explanation, and that is exactly the
shape an intermittent gate failure and a real one share.** Nothing here distinguishes them.

**What would have cost one command:** `git push > /tmp/push.log 2>&1 || tail -50 /tmp/push.log` on the
FIRST attempt — redirect before you need it, not after two attempts have already failed. The agent
arrived at this form by the third try; the point of writing it down is that it is available on the
first.

**Check on closing:** a pre-push failure in any agent's report is accompanied by the reason, or by a
statement that the reason could not be obtained and why. A report that says a push failed and later
succeeded, with nothing in between, is incomplete on its face.

## 303. User-facing error text left over from the retro-PR wave (2026-10-23)

Five findings from reviews and QA that were deliberately not fixed in their PRs, because each touches a
shared string or a path outside the diff that produced it. Grouped because they are one sweep.

- `INTERVIEW_NOT_FOUND` («Співбесіду не знайдено») states the failure and no next step.
- The uk catalog mixes the ASCII apostrophe with the typographic one (78 msgids typographic against
  21 ASCII at the time of measurement). A catalog-wide sweep, not a per-PR fix.
- A 4xx with no canned status line falls back to «Не вдалося виконати запит…», which repeats «Не
  вдалося» directly under a title that already begins with it ("Couldn't" twice in en).
- An uncoded Nest 403 (`Forbidden resource`) is absent from the generic reason phrases, so it renders
  raw and in English beneath a localised title. Not reachable on the link endpoint today, whose guards
  return a coded 403 — reachable the moment an endpoint does not.
- Uncoded errors with a non-generic server message pass through verbatim (`connect ECONNREFUSED …`,
  `interviewId: Invalid UUID`). Not observed on a real path.
- The admin edit dialog surfaces a raw English `salaryMonth: Format YYYY-MM` for an invalid month; it
  needs a coded API error, not a cosmetic patch.

**Check on closing:** no user-facing surface renders an uncoded server message verbatim, and the uk
catalog uses one apostrophe.

## 304. Small UI and data defects observed during retro-PR QA (2026-10-23)

Each was seen on a real stack, none belongs to the PR that surfaced it.

- The salary Month input renders its value in English («September 2026») under a uk locale and clips
  slightly at 375px.
- A senior's own salary aggregate is computed for the CURRENT month while the create form defaults to
  the PREVIOUS one, so a part created with the default does not appear in the aggregate until the next
  month. Predates the multipart-salary work.
- The shared `Alert` separates title from reason only by font weight and a 4px gap, so a two-part
  message reads as one block.
- DROP balance figures render as `1 250,50 USD` where a spec expects `$1,250.50` — a locale-formatting
  change that an E2E spec still asserts the old way (surfaced as an unexplained E2E failure during an
  A/B run, in a component absent from the diff under test).
- Seeded `interviews.notes_domain` values fail `interviewSchema`, so the link-recording dialog shows
  its error state against a freshly seeded scratch database until the column is nulled. Either the seed
  or the schema is wrong; QA runs currently work around it.

**Check on closing:** each bullet fixed or explicitly declined in this entry.

## 305. `non_deleted_transactions` now has a third production definition site; the drift guard reads one (2026-10-23)

The view is re-created by more than one manual DDL file, and the consistency spec that exists to catch
drift between the schema and production reads only the 2026-08-03 file. The multipart-salary prepare
DDL already had this shape before the salary-creation-intent DDL added a third. So a change applied
through either of the newer files is invisible to the guard that exists for exactly that risk.

Not a defect today — the definitions agree — which is precisely why it will not announce itself when
they stop agreeing.

**Check on closing:** alter the view in ONE of the newer DDL files only, and the guard fails.

## 306. Two residuals from the timing-job split (2026-10-23)

Both were disclosed by the author of the split rather than found afterwards, which is why they are an
entry instead of a finding.

- **The quadratic-scan guarantee is no longer a merge gate.** The `timing_specs` job sits outside the
  `quality` aggregator by design — that is what makes a single miss a signal rather than a blocked PR —
  and it runs only when `apps/api`, `packages/shared`, the lockfile or `ci.yml` change. So nothing
  blocks a merge on it. **This repo has already been burned by the adjacent arrangement:** a nightly
  mutation run stayed red for twenty days because "the nightly checks it" is not the same as anyone
  reading it. So the open question is not "required or not" — making it required reinstates exactly the
  load-sensitivity the split removed — but **who notices a failure**. Candidates: fold its conclusion
  into the telemetry digest that already reaches a human, or alert on it the way `deploy-alert.yml`
  alerts, or accept it as advisory and say so in the job's own header.
- **The 2.0 exponent threshold has a false-negative range.** Measured during the split: a quadratic
  PI scan with a 64-character step fits BELOW 2.0 and the assertion stays green. So the original spec
  did not only fail under load — it also passed on a real regression. The split did not create this and
  did not fix it. A deterministic operation count would, but none was reachable without instrumenting
  the parser (product code, outside the test author's zone), so the seam has to be added deliberately.

**Check on closing:** a quadratic scan with a 64-character step is caught by something, and a failing
`timing_specs` job reaches a human within a day without anybody thinking to look.

## 307. The session scratchpad is one flat shared directory, so a plain filename is everybody's (2026-10-24)

**Measured, in another session, 2026-10-24.** Two agents of the same session each wrote their PR
description to `pr-body.md` in the shared session scratchpad. The second `gh pr edit --body-file` then
published **one PR's description onto the other PR**. It was noticed and rebuilt, but the rebuild was
itself incomplete (recorded as instance 5 of entry 301).

**Why no existing rule covers it.** `agent-isolation.md` learned this exact lesson for _worktrees_ —
the session scratchpad is shared by every agent of a session, so a scratch path proves nothing about
whose it is, and the cure there was a path derived from the agent's own identifier plus a record of
ownership. Nothing says the same for _files_. The hook enforces the worktree half; the file half is
unwritten, and the orchestrator-written briefs in this repo routinely tell agents to "write the body
to the scratchpad first" (the write-then-post pattern from `dev-flow-resilience`) without saying where.

**Why it is worse than a lost file.** A clobbered scratch file is cheap; a clobbered _published_
artifact is not. The failure surfaces as a PR whose description belongs to a different change — which
a reviewer may read as the author's claim about the diff in front of them, and which the Flow Gate
will judge on step lines that were never written for that PR.

**Candidates.** Brief agents to derive scratch filenames from their own identifier (the convention
`agent-isolation.md` already uses for trees), or have the write-then-post guidance in
`dev-flow-resilience` name the file rather than the directory, or — cheapest and mechanical — have
each agent write under a per-agent subdirectory so a plain basename is safe again.

**Check on closing:** two agents of one session, each told to write a PR body "to the scratchpad",
produce two files that cannot collide — verified by running it, not by reading the brief.

## 308. The account meter's spend record depends on six things no code does yet (2026-10-24)

Findings from the three review axes on the shared account-meter reservation store. None could be
closed inside the store: each needs either the port the collection loop sees, or a worker that claims a
run under a lease — and neither exists. They are one entry because they share that cause, and because
closing any one of them alone still leaves the meter's `used` unable to mean what a reader assumes.

**THE OPEN OWNER IS PLAN TASK 2.5, AND IT IS STILL OPEN.** Several bullets below name a role —
"whoever claims a run under a lease" — and that role is Task 2.5 of the vacancy-sourcing plan, which
owns the run registry, the collection cadence and durable work ownership, and which is not
implemented: no registry or run-worker file exists under the job-sourcing directory, and the service's
registry is still the in-process map holding the legacy provider contract. Registration was
deliberately cut from the manifest task on the same grounds — nothing in production builds a
`CollectionContext`, so there is nothing for a registered adapter to be handed. Written out here
because the task files that say so are gitignored, and an address a reader cannot open is not a
destination.

- **A reservation can be handed to two live executors of one attempt, and the second charge is
  silently dropped.** The store reuses a reservation that is still in the RESERVED state, reading that
  state as "the request never left". RESERVED is equally the state of a live worker about to send, and
  the store holds no evidence of which. Measured: six concurrent executors of one attempt received one
  reservation between them; two of them each sent a real request of cost 2 and the meter recorded 2.
  The second settlement was a no-op, so the second worker believed it had been charged. N overlapping
  executors cost N times the amount and are charged once — the overspend direction. The store now
  carries this as a stated CALLER precondition (at most one live executor per attempt identity), with
  a characterisation test named "TWO live executors of one attempt SHARE a reservation — the
  precondition, measured" in the store's integration spec: whoever fixes this will see THAT test fail,
  which is the signal to delete it and assert the fix. It cannot be enforced from inside: the distinguishing fact would have
  to arrive through the collection context, which carries no owner token, and whose fencing epoch is
  written by no code in the repository — the column defaults to 1 and the lease recovery that would
  advance it is unimplemented. So folding the epoch into the reservation key would separate nothing
  while making the file look fenced. **Whoever claims a run under a lease owns establishing the
  exclusivity and asserting it there.**

- **Nothing can record that a request left, so "release only provably unsent cost" has no caller that
  can honour it.** The store exposes a way to mark a reservation sent; the port the collection loop
  actually sees exposes only reserve and reconcile, and nothing in the repository builds that context
  yet. So in production the sent state is never recorded. Measured: a reservation whose request
  physically left, released because the send was never recorded, took the meter from a hold of 4 to all
  zeroes with 4 units really spent. What protects the loop today is that the JSON page collector marks
  the outcome uncertain _before_ it fetches — not the store's guard. Either the transport calls the
  mark at the moment the request leaves, with its transaction committed first, or the sent state is
  formally retired with a reason. Deciding it by silence is the one option not available.
  OWNER: the quota-adapter task, plan Task 3.5b — it is the first task with a transport that
  actually sends, and its own text carries the item. Named here because the task file that
  says so is gitignored.

- **Settlement charges the full reserved worst case, with no path to correct the row.** Reconciliation
  carries no actual cost, so a source billed per returned record is charged its whole page every time:
  a call returning 3 records against a worst case of 50 burns 50 credits in the ledger. Safe for
  overspend and wrong for accounting — on a money-denominated monthly meter the drift is permanent and
  compounding, because a second settlement is a no-op and the used amount is already written. Until the
  port can carry the incurred cost, `used` is an upper bound on spend rather than spend, and nothing
  downstream may report it to the owner as money actually billed. The store's docblock says so now.
  OWNER: the quota-adapter task, plan Task 3.5b — it is the first task with a source whose real
  cost differs from its reservation, and its own text carries the port change. Named here
  because the task file that says so is gitignored.

- **A crashed worker strands a reservation that nobody can classify or settle.** The plan's lease
  recovery is the named owner, but its text speaks only of uncertain reservations, and a crash mostly
  strands a RESERVED one: the settlement runs in a `finally` that a crash never reaches. With no record
  of the send, a stranded RESERVED row whose request was already in flight cannot be told from one that
  never left — so the safe reading (hold as uncertain unless provably unsent) is the only sound one,
  and it is not what "reschedule uncertain reservations" describes. The store also exposes no way to
  enumerate or settle a dead attempt's rows, so the recovery has no entry point to call.

- **The port's own comment describes a refusal shape that is no longer the only one.** The
  collection-loop-facing meter port documents its reservation call as returning `null` when the
  budget refuses — "a COST_STOP, not an error". Since the per-unit sanity ceiling was added, the
  store has a second refusal shape: an amount above the ceiling THROWS rather than returning
  `null`, because a cost estimate that large is a defect and not a budget condition. A loop author
  reading the port's comment would handle only the `null` and meet an uncatchable throw. The store's
  own class docblock now states both shapes; the port's comment is in a provider base, outside the
  zone of the task that introduced the ceiling, so the correction travels with the port change in
  the first item above rather than on its own.

- **Nothing proves a quota key reaches the redaction list.** The credential reader returns the key
  together with the list to append to the collection context's `secrets`, and that return value is
  where every assertion stops — because no code builds a collection context, there is no end-to-end
  path from the reader to a redacted report. The consequence is concrete: a caller that takes the key
  and ignores the `secrets` list passes every test in the credential spec and leaks the key into
  whatever it logs or reports. This belongs to the step that CONSTRUCTS the context, which is Task 2.5
  above and not the adapter task — the adapter task's own text names `secrets` only as a port, so
  pointing the deferral there, as an earlier edition of the credential spec's comment did, named an
  owner that did not hold the item.

**Check on closing:** two concurrent executors of one attempt each sending a real request are charged
twice, not once; a worker killed between sending and settling leaves cost held rather than released;
a per-record source that returns 3 records against a worst case of 50 is charged 3; a recovery
process can name and settle the reservations of an attempt whose worker died; the port's comment
names both refusal shapes, so a loop built from it handles the throw as well as the `null`; and a
configured quota key is provably absent from a report the collection loop produced, asserted on the
report rather than on the reader's return value.

## 309. A posting whose employer is withheld at the source has nowhere to live (2026-10-24)

**Open.** Found while reviewing the RSS adapters of r5 Task 3.6; it is the reason two of the three
sources yield nothing.

An observation with no employer is quarantined `MISSING_COMPANY`, a rule introduced with the shared
observation identity seam. That rule reads every empty employer as a defect. **Djinni's feed carries
no employer field at all** — the site withholds it until a candidate applies — so a correct adapter
over a healthy feed produces zero stored rows, and the source is worthless rather than partial.

"Withheld at the source" is a third value, distinct from "present" and from "we failed to parse it",
and the ingestion contract cannot express it. Settle, before writing code: what deduplication does
when one of two sources naming the same posting discloses the employer; what a per-senior company
exclusion means against an unknown employer, since an excluded company can arrive anonymously; and
whether an anonymous posting is worth a SENIOR's attention at all. The last is the owner's call.

**Second, separate requirement, same area:** the shared feed reader exposes only the common
RSS/Atom fields, so a feed's namespaced extension elements are parsed but unreachable by an adapter.
EU Remote Jobs' employer IS in its feed, as `job_listing:company`, and is lost to this; We Work
Remotely's region, country, type, skills and expiry are lost to the same gap, which is why the
enrichment item of that task shipped undone. An extension slot stays untrusted input: the port's
existing bounds on element count, depth and value length apply to it unchanged.

**Check on closing:** a Djinni-shaped item that is quarantined today produces a stored posting whose
employer is explicitly unknown; an EU Remote Jobs item produces an employer read from its namespaced
element; and no new bound ships with only a refusal-side test.

## 311. Flow Gate: three matcher and classifier gaps found by using it (2026-10-24)

All three surfaced while putting real PRs through the gate on the day it became required. None is a
false pass — each is a false FAIL, which is the cheaper direction, but each costs a review round and
teaches the author to distrust the gate.

- **A bolded step line is invisible.** `**Task:**` / `**Plan:**` do not match; the line must be plain
  at line start. Markdown bolding is the obvious way to write a labelled line in a PR body, so this
  will recur. The matcher tolerates a `- ` / `* ` bullet but not emphasis.
- **A vitest setup file is not a test file.** A PR whose only code hunk was `apps/web/app/test/setup.ts`
  reported `Tests: MISSING`. The file is listed in `setupFiles` of `apps/web/vitest.config.ts`, so it
  is test infrastructure by definition, and the author had to add a `Skip-Tests:` line for a change
  that is nothing but tests.
- **`Skip-Task:` silently waives `Spec-Review` too.** Spec-Review is required only when a `Task:` line
  is declared, so skipping Task removes the spec axis with no second reason and no visible trace — the
  gate's own table then reads `n/a` rather than `SKIPPED`, which is the one place a reader would look.
  One recorded skip quietly buys two.

**Candidates:** tolerate `**` and other emphasis around a step key; treat files under a package's
`test/` directory (or any file named in a vitest `setupFiles`) as test files; and make `Spec-Review`
read `SKIPPED (no Task declared)` rather than `n/a`, or require its own skip line when Task is skipped.

**Check on closing:** a PR body with `**Task:**` passes the Task row; a PR whose only code change is a
vitest setup file does not report `Tests: MISSING`; and a `Skip-Task:` PR shows Spec-Review as skipped
with a reason rather than as not applicable.

### A fourth gap, and it is not a matcher gap: a verdict is not pinned to the commit it was given on (2026-10-24)

Separated from the three above because they are cosmetic and this one defeats the gate's purpose.
Measured by reading the gate, not inferred:

```
git show origin/main:scripts/architect/flow-gate.mjs | grep -nE 'commit_id|head_sha|latest'
```

`latest` is selected by `ts(it.at)` among trusted-association markers. **`commit_id` and `head_sha`
do not appear in the file at all.** So a positive verdict stays positive across any number of
subsequent commits, and the gate reports the step `done`.

**The reviewed code and the merged code can therefore be different code, with nothing in the gate's
output distinguishing them.** This is the same shape as the defect the Flow Gate was built to close:
the gate exists because five PRs merged with no review, and this hole lets a PR merge with a review
of something else. Narrower, and not hypothetical — observed on PR #1110, where `Verdict: APPROVE`
and `Spec Review: PASS` were given on `abc3fa24c`, and a further commit followed. The gate would
have passed it on those verdicts; it was caught by hand, which is exactly the attentiveness a gate
exists to replace.

**What makes it fixable:** a GitHub review object carries `commit_id`, the commit it was submitted
against. A PR comment does not, so comment-borne verdicts have only `created_at` and are strictly
weaker — a fix must say what it does about them rather than treating them as always fresh.

**The trade to get right, and the reason this is not a one-line change.** If any follow-up commit
invalidates a verdict, then every PR-body edit forces a fresh review round, and a gate that expensive
is one people route around — worse than the hole. A docs-only exemption (every changed path ends in
`.md`) is the obvious relief and is consistent with the gate's existing docs-only rule. There is also
a reporting choice worth making deliberately: `MISSING` is strictest, but a distinct `STALE` status
tells the author whether they need to run a reviewer or get a fresh pass, and those are different
remedies.

### It happened in production while the fix was in review (measured 2026-10-24)

Not a hypothetical any more. **PR #1103 merged at 02:25:44Z carrying stale verdicts on all three
axes**, hours after this gap was written up and while the fix for it (#1116) was under review. The
fix's own blast-radius run had named #1103 as the one PR that would newly block — and it merged
before the fix did.

Measured, and the arithmetic matters because the raw diff grossly overstates it:

|                                                            | files | lines        |
| ---------------------------------------------------------- | ----- | ------------ |
| diff from the code/security verdict sha to the merged head | 53    | +6544 / −207 |
| of those, files the PR itself **owns**                     | 4     | +462 / −28   |
| same, measured from the spec `PASS` sha                    | 2     | +184 / −25   |

The 53-file figure is almost all base-branch movement — the branch merged `main` in between, which
brought three other PRs with it. **Quoting it as "merged without review" would be false**, and it is
the trap entry 301 describes: a real measurement, less precise than the claim it would support. The
honest number is the intersection of the drift with the PR's own net diff, which is exactly the
quantity #1116's rule computes (`drift ∩ P`) — the entry and the fix agree on what to measure.

What actually merged unreviewed: `account-meter.store.ts` and two of its spec files, **+462 lines of a
metering and quota store**, after `Verdict: APPROVE` and `Security Review: APPROVE` were both given on
`36c209006` and the head moved on. The spec `PASS` on `d1c2f578a` was stale too, by 184 lines of the
store itself. The PR had a `Security Review: BLOCK` earlier in its history, so this is not a surface
nobody worried about.

**The step this rests on, made explicit because it is the one that could be wrong.** "Merged on stale
verdicts" is only true if no fresh verdict landed between the last one and the merge. The full review
list (`--paginate`, so not a truncated page) ends at `Spec Review: PASS` at **00:52:25Z**; the merge is
at **02:25:44Z**. Nothing was submitted in that hour and a half, and the latest verdict on each axis
sits on a sha that is not the merged head: code and security on `36c209006`, spec on `d1c2f578a`, head
`f8afb7ab7`. Without that check the claim would rest on a snapshot taken earlier, which is a different
and weaker statement.

Reconstruct it with:

```
gh api repos/<owner>/<repo>/pulls/1103/reviews --paginate \
  --jq '.[] | select(.body | test("^(Verdict|Spec Review|Security Review):")) | "\(.commit_id[0:9]) \(.body | split("\n")[0])"'
gh pr view 1103 --json headRefOid,mergedAt
# then intersect: git diff --name-only <base>...<head>  vs  git diff --name-only <verdict sha> <head>
```

**The decisive fact, which is stronger than "the verdicts were stale".** The `Flow Gate` check run on
the merged head concluded **`success` at 02:14:04Z**, eleven minutes before the 02:25:44Z merge:

```
gh api repos/<owner>/<repo>/commits/f8afb7ab7/check-runs --jq '.check_runs[] | select(.name=="Flow Gate") | "\(.conclusion) \(.completed_at)"'
```

So the gate did not merely fail to notice. **It affirmatively certified every step as `done` for a head
whose code and security verdicts had been given three commits earlier.** A gate that stays silent is a
gap; a gate that returns a positive answer about something it did not measure is a false statement,
and it is the shape `verification-integrity.md` is built around — an instrument reporting a result when
it had not looked at the thing it was reporting on.

**Why this belongs in the entry rather than only in #1116's body:** it answers the objection that
head-pinning is ceremony. The gate reported every step `done` for this PR, and every step was `done` —
for code that is not what merged.

**Check on closing:** a PR with a positive review verdict on an older sha does NOT report that step
`done`; the same PR with only a subsequent docs commit still does; and the gate still fails closed on
a truncated or failed API fetch.

## 312. A read-only reviewer can check out a PR inside the orchestrator's own working directory (2026-10-24)

`agent-isolation.md` says a read-only reviewer is deliberately NOT forced a worktree, and the dispatch
gate passes it silently, on the sound grounds that it reads a diff rather than a tree. Rule 4 then
tells it to make its own checkout if it needs to run something, and `pre:bash:cross-agent-blast`
refuses it a _foreign_ tree. **Nothing covers the session's own directory**, which is the one tree it
shares with the orchestrator — so the protection is complete against siblings and absent against the
parent.

**Observed, from the reflog rather than inferred.** A reviewer on PR #1102 made its own checkout as the
rule prescribes, and also ran a checkout in the session working directory:

```
e445077d8 checkout: moving from docs/worktree-leak-rate to refs/pr/1102
```

The orchestrator was left on a detached HEAD at someone else's PR head, with no error and no notice.
It then appended to a long-lived file and committed. Measured consequence:

|                                                  | lines |
| ------------------------------------------------ | ----- |
| the file on the orchestrator's branch            | 4842  |
| the file at the PR head it was silently moved to | 4792  |
| the resulting commit                             | 4829  |

The commit was a clean `+37` on the wrong base. Pushed to the branch, it would have **reverted two
earlier entries** — `grep -c` for each returned 0 in that commit — while reporting "1 file changed, 37
insertions(+)" and nothing else. This is `verification-integrity.md`'s silent-revert hazard reached
without staging anything stale: the base itself moved underfoot.

**Why `git add` by name did not help, and what did.** The staged set was correct and the diffstat was
correct; both describe the change relative to a HEAD that was not the intended one. What caught it was
`git push` failing with "You are not currently on a branch" — luck, in that the detachment happened to
block the one command that would have done damage. Had the reviewer checked out a _branch_ instead of
a ref, the push would have succeeded.

**Candidate answers, in increasing cost:**

1. Extend `pre:bash:cross-agent-blast` to refuse `git checkout` / `switch` / `reset` with a revision
   argument when the agent is non-isolated and the target tree is the session working directory. Cheap
   and precise; it does not restrict an agent's own scratch checkout, which is what the rule wants it
   to use.
2. Have write-capable commands assert the branch first. The orchestrator's own discipline already
   requires `git branch --show-current` before a write operation (`session_ops_lessons_2026_06_15`);
   this incident is what that line is for, and it was not run.
3. Dispatch reviewers with `isolation="worktree"` after all, which the rule rejects on cost grounds —
   and that reasoning still holds, so this is the fallback, not the fix.

**Check on closing:** a non-isolated agent that runs `git checkout <rev>` in the session working
directory is refused, and its own scratch-path checkout still succeeds.

## 313. The mutation gate reads a mutant killed only by rejection tests as surviving (2026-10-24)

**Open** — a tool fact with no mechanism behind it, measured independently twice. 313 was free when
taken and nothing has claimed it since; its sibling entry on the chain-directive quirk had to be
renumbered to 315, so the two no longer sit next to each other in the file.

Stryker's per-test attribution does not select a test whose assertion is on a **rejection** — that
the call under test throws, or that a promise rejects. A mutant whose only killers are such tests is
therefore reported as `Survived` while the suite does kill it: hand-mutate the line and the named
tests fail, every time. Found by the author of an account-meter store and confirmed by a reviewer,
which is the only reason anyone believed it rather than suppressing harder.

Two instances, with their numbers, so a later reader can re-run them rather than trust this entry.
Both are in the store's settlement path, and both were measured by applying the mutation by hand and
running the unit suite:

- the meter-lock `catch` that converts only a not-found error into a foreign-reservation refusal,
  forced always-true: **2 unit tests fail** ("an error that merely LOOKS like METER_NOT_FOUND ..."
  and "a plain failure inside the meter lock ..."), both of which assert on a rejection;
- the no-op arm of the settlement state machine, forced always-true: **2 unit tests fail**, the two
  refused-transition cases, which assert on a rejection for the same reason.

Why it costs more than the chain-directive quirk of entry 315: that one fails toward a red gate and
merely wastes time, while this one invites the wrong repair. The natural response to a survivor you
cannot explain is a suppression, and a suppression here hides a line the tests were already
guarding — so the gate stops watching a line that was never unwatched, and the file now tells the
next reader not to look.

The honest handling is a suppression whose reason carries **the measurement** — which mutation, which
tests fail, how many — so a later reader can re-run it instead of trusting it, and can delete the
directive the day the tool is fixed. Both suppressions in the account-meter store that cite this
quirk are written that way.

**Check on closing:** hand-mutate a line whose only coverage is a rejection assertion and compare the
suite's result with the gate's report. If they agree, the quirk is gone and every suppression citing
it can be deleted.

## 314. Readiness is stated in two places, and nothing reconciles them (2026-10-24)

**Open.** Introduced with the first four JSON source adapters, deliberately, as the lesser of two evils.

A source's readiness — whether we are permitted to collect from it — is recorded in its fixture's provenance
file, as the `permission` field with its evidence. One adapter now also carries a readiness constant in its
provider module, because a provider that reads as fully live while a JSON field alone calls it blocked is a
source that goes live by omission.

Two statements of one fact are only safe while something reconciles them. Today one spec asserts that the
constant's permission equals the provenance's, which covers that pair and nothing else: a second adapter
adding its own constant inherits no such check, and the fields the provenance has no counterpart for are
pinned by literals rather than derived. The manifest task is where the reconciliation belongs — it must fail
the manifest build when a constant and its provenance disagree, rather than preferring either — and until
that exists, the enforcement is a spec per adapter that someone has to remember to write.

**Check on closing:** flip a provenance `permission` to UNCLEAR for a source that also has a readiness
constant, and the build fails rather than the entry quietly staying ready. If the only thing that fails is
one hand-written spec, the reconciliation does not exist yet.

## 315. A Stryker directive inside a method chain is silently not honoured (2026-10-24)

**Open** — a tooling fact with no mechanism behind it, so it will be rediscovered unless it is written
down. Renumbered from 312 to 315 before merge: another session's entry 312 reached `main` first, and
by the cross-session protocol the second to merge renumbers. 313 is the entry below, and 314 is
claimed by a branch in flight.

A `// Stryker disable next-line <mutator>` comment suppresses the mutants of the statement below it.
Placed inside a multi-line method chain — above a chained call, or trailing the line before it — it
suppresses nothing: the mutant survives and the gate's `ignored` count does not move. Measured twice
independently on the same day: once by the author of the code, by arithmetic on the gate's own
`ignored` count across two placements, and once by a reviewer in an isolated Stryker sandbox, where
the identical directive above a single-line statement did remove its mutants.

Why it matters more than an ordinary tooling quirk: the failure is **silent in the direction of a
false red**, and the natural response to a survivor you believe you have suppressed is to suppress it
harder, or to excuse it in prose. The honest answers are to assert the line, or to restructure so the
directive sits above a statement rather than inside a chain.

Worth holding beside its opposite. This quirk fails toward a red gate, so it costs time and hides
nothing. A suppression whose stated reason has gone stale — because a test was later added that does
cover the line — fails the other way, toward green, and hides live signal. Both are about
suppressions and they point in opposite directions, so a review of one is not a review of the other.

**Check on closing:** place such a directive inside a chain and confirm the gate's `ignored` count
moves. If the count is unchanged, the directive is decoration and the line is still gated.

## 316. `.mjs` is formatted by nothing: outside lint-staged AND outside the CI formatting gate (2026-10-24)

Surfaced by the architect while writing PR #1116, reported as "`lint-staged` globs do not cover
`scripts/**/*.mjs`, so the pre-commit hook never formatted them and the CI prettier gate would have
failed". **The first half is right and the second half is wrong**, and the correction is the finding:
nothing would have failed.

Measured on `origin/main`:

```
# the pre-commit side — no glob matches scripts/architect/flow-gate.mjs
python3 -c "import json,fnmatch;d=json.load(open('package.json'));print([k for k in d['lint-staged'] if fnmatch.fnmatch('scripts/architect/flow-gate.mjs',k)])"

# the CI side — the file-type filter in check-no-skip-hooks.yml
git show origin/main:.github/workflows/check-no-skip-hooks.yml | grep -E "grep -E '\\\\."
```

`lint-staged` declares seven globs, all under `apps/`, `packages/` or the repo root, and **none
matches**. The CI gate collects PR-changed files through
`grep -E '\.(ts|tsx|js|jsx|json|md|yml|yaml)$'` — and `\.js$` does **not** match `.mjs`, because the
dot is followed by `mjs`. So `.mjs` is outside both.

**Why the wrong half matters more than the right half.** "The hook misses it but CI catches it" is a
gap with a loud failure at the end, and it needs no action beyond widening a glob. "Neither checks it"
is silence: the extension the project uses for its own gate scripts — `scripts/architect/flow-gate.mjs`
is 43k and is what decides whether code may enter `main` — is formatted by nobody, and a reader
reviewing a diff in it cannot tell formatting noise from intent. The author reports having run prettier
by hand and the files being clean, which is true and is also the point: it held because someone
remembered.

This is also a second instance of the shape in `verification-integrity.md`: a gate reported as covering
something it does not. The author inferred CI coverage from the existence of a formatting gate rather
than from its file filter.

**Candidate fix, both ends, because fixing one reinstates the asymmetry:** add a `lint-staged` glob for
`scripts/**/*.{mjs,cjs,js}` (and `.claude/**` / `.github/**` scripts if they are formatted at all — not
checked here), and add `mjs|cjs` to the CI filter's alternation. Decide deliberately whether `.claude/`
and `.github/` shell and JS are in scope; this entry measured only `.mjs`.

**Check on closing:** a deliberately mis-formatted `scripts/**/*.mjs` committed with hooks active is
either reformatted by the pre-commit hook or fails the CI formatting gate — today it does neither, and
that is the assertion to re-run.

## 317. The integration-run model is a dichotomy; reality has a third case that reports a confident pass (2026-10-24)

`isIntegrationRun` in `apps/api/vitest.config.mts` is
`process.argv.some((arg) => arg.includes('integration.spec'))`. When it is false,
`INTEGRATION_SPEC_EXCLUDE_GLOB` removes every `*.integration.spec.ts` **from discovery** — the files
are never parsed, so the summary reports no skip count.

**A correction to this entry's own first draft, measured independently by two reviewers.** It said
"nothing is reported as skipped", which overstated it: a generic `console.warn` does fire once at
config load. It fires on **every** unit run, says nothing about the files the user named, and the
run summary still shows no skip count — so the defect stands and the sentence did not. Recorded
because an entry about a misleading instrument should not itself overstate its evidence.

**None of that is new or undocumented.** It is stated in the config, in spec-file headers
(`transactions.drop-self-feeds.spec.ts`, `job-sourcing-budget-race.integration.spec.ts`), in
`.claude/rules/common/mutation-gate-integration-specs.md`, and `task-integration-db-guard-any-run.md`
is a whole task about one of its consequences. **The gap is that every one of those describes a
dichotomy** — an _unfiltered_ run (specs excluded) versus a run _filtered on `integration.spec`_
(specs run, guard attached, `fileParallelism: false`). The task file's own verification list has
exactly those two cases plus a variant of the second.

**The third case is the dangerous one and nothing names it:** a run filtered by a path that does not
contain the substring. You intended an integration run, your filter matches the files you want, and
they are excluded anyway — and the run exits 0 with a count of whatever else matched.

**Measured instance (PR #1102, round 1).** Filter `src/finance/salary-month-gap` matched two files, a
unit spec and an integration spec. The integration spec was dropped from discovery, the run printed
`Test Files 1 passed` where two matched, and the body reported "gap suite 40 passed" — a **true count
of the wrong file**. The two new integration cases had never executed. CI, which runs the filtered
`integration.spec` form, failed them. The body and CI disagreed for a whole review round, and the
author found it by finally reading `Test Files 1 passed` rather than the pass count.

**Why this is worse than an ordinary missing warning.** The other two cases announce themselves: the
unfiltered run visibly skips, the properly filtered run visibly runs. The third produces a green
number with no symptom. "0 passed" and "nothing ran" are distinguishable in this repo's rules;
"40 passed" and "40 passed of the files you did not ask about" are not.

**A second hazard in the same predicate, found by a reviewer hitting it by accident.** Because the
check is `argv.some(...)`, `vitest run integration.spec <other-path>` **ORs** the filters: it runs every
integration spec in the repository rather than the intersection. One reviewer did this unintentionally
and wrote to a scratch database for ~100 s before killing the run by PID. So the predicate has two
failure modes in opposite directions — a filter without the substring runs too few files and says
nothing, and a filter with it runs far too many.

**Candidates, cheapest first:**

1. Make the exclusion loud when a filter was supplied: if `argv` carries a positional filter, no
   element contains `integration.spec`, and the filter would otherwise match an excluded file, print
   one line naming the excluded files. The data is available at config time.
2. Reconcile counts rather than trusting them: teach whoever runs a narrowed suite to compare
   `Test Files N passed` against the number of files the filter matches (`vitest --list` or a glob).
   Procedural, and it is what actually caught this one.
3. Widen the predicate so an explicit path to an `*.integration.spec.ts` file counts as an
   integration run. Attractive and the riskiest of the three: it silently attaches the DB guard and
   `fileParallelism: false` to runs that do not have them today, so it needs the same scrutiny as
   `task-integration-db-guard-any-run` and probably belongs with it.

**Check on closing:** a run filtered by a path that matches an `*.integration.spec.ts` file either
executes it or says in one line that it did not — and in neither case does it exit 0 having silently
counted only the other files the filter matched.

## 318. A hostile JSON body stalls the event loop before the byte cap can refuse it, once a per-source cap is raised (2026-10-24)

**Open** — found by the security review of the ATS A adapters (SR-M-1); the fix belongs to the shared
bounded-JSON reader, not to the adapters, so this entry is the deliverable and the next task to touch
that reader owns the repair. Number chosen by measurement: the highest `## NNN.` heading across all
574 fetched `origin` refs was 317 (a different entry, on `origin/docs/integration-run-third-case`;
this one first took 317 when 316 was the highest and was renumbered), so 318 was the next free one.
If another branch has claimed it since, renumber at merge.

The reader bounds a body in this order: bytes, then nesting depth (a pre-parse scan of the raw text),
then `JSON.parse`, then a node count after parsing. A body inside the byte cap and inside the depth
limit is therefore parsed in full before the node count can refuse it. At the default 2 MiB that is
cheap. The Greenhouse and Ashby adapters declare a **10 MiB** response cap (the plan's ceiling for a
per-source cap, justified by three measured real boards of 2.7, 5.6 and 8.0 MB and an Ashby board of
13.9 MB), and at that size the order matters.

Measured by feeding the reader a hostile 10 MiB body that fits the cap and the depth limit:

- 10 MiB of `[0,0,0,…]` parses in **1.6 s** at about **+310 MB RSS**, synchronously, so nothing else
  on the event loop runs meanwhile; the node-count limit then refuses it, after the cost is paid;
- 10 MiB of `[{},{},{},…]` parses in **2.8 s**;
- for contrast, a deeply nested body and a body one byte over the cap are both refused in about
  **2 ms**, because those two bounds fire before parsing — the bound that is missing is the one
  that matters for a flat body.

Compare the legitimate case: the real 8.0 MB Cloudflare board parses in 51 ms at +26 MB, so the
hostile cost is two orders of magnitude above the honest one, which is the room a pre-parse bound
has to work in.

Suggested cure (the reviewer's): count the commas of the raw text inside the existing depth-scan
pass and refuse a body whose element count already exceeds the node limit, so the flat case is
refused for the price of one scan, like the depth case is. A count of separators over-estimates
nodes slightly (strings with commas), which is the safe direction for a refusal.

Until it is fixed, the exposure is bounded by who can choose the body: the three public ATS
providers, reached only through a manifest the owner enables source by source, and not before the
transport carries a per-source byte cap at all (the entry titled "An adapter's declared byte cap
cannot reach the transport …", number 319) — until then the transport refuses anything over 2 MiB
and the 10 MiB is not reachable.

**Check on closing:** parse a 10 MiB `[0,0,…]` body through the shared bounded-JSON reader under a
10 MiB limit and a 200,000-node limit. Today it takes about 1.6 s and +310 MB before refusing; closed
means it is refused in single-digit milliseconds without allocating the parsed tree.

**Sequencing constraint, added 2026-10-24 — this entry must close before the transport is wired.**
Plan Task 2.5 builds the production `CollectionContext` and must call `transportOptionsFor` for an
adapter's declared cap to reach the transport at all. The moment it does, Greenhouse and Ashby's
declared **10 MiB** becomes live and this entry's window opens for two real sources at five times the
shared default. So: **fix this entry, then wire the transport.** If anyone wires first, that is a
decision to be stated and justified, not a step to be taken quietly.

Measured independently on 2026-10-24 by the security axis of PR #1119, **on Node v20.15.1 rather than
the pinned 22**, so the figures are indicative and not the pin's behaviour: 3.56M `{}` elements in a
10.2 MB body took ~679 ms and ~291 MB, synchronously on the event loop. A `[0,0,…]` body of similar
size took ~66 ms — that run **did not reproduce** the ~1.6 s figure recorded above for the array shape.
Both measurements are kept rather than reconciled, because which one is right is itself unresolved, and
a single averaged number would hide that.

## 319. An adapter's declared byte cap cannot reach the transport, so a source whose pages exceed the transport's default is refused before its own cap is consulted (2026-10-24)

**Open** — found while measuring the ATS A adapters; the work belongs to the task that owns the quota
adapters (Task 3.5b), whose adapters are the next to need a cap above the default. Distinct from entry
318: that one is the event-loop cost of parsing a large body and only exists once this one is fixed;
this one is why a large body never arrives at all today.

An adapter can declare its own response cap (`limits.maxBytes` on the JSON spec, up to the plan's
10 MiB ceiling), and the body decoder honours it. But the request an adapter hands to the loop,
`FetchRequest`, carries no per-request cap, and the transport (`http/bounded-fetch.ts`) applies its
own default of 2 MiB per response (ceiling 10 MiB, reachable only through its `maxBytes` option,
which nothing can set per request). So a source whose single response is larger than 2 MiB is refused
by the transport before the adapter's own cap is ever consulted, and the adapter's declaration is
inert. The plan already asks for the missing mechanism: Task 2.2's text says "per-source byte caps
from MP-02 within the 10 MiB ceiling or list-plus-detail mode", and that task is marked landed
without it.

Four measured cases, so this is not hypothetical (all 2026-10-24, single GET each):

- Greenhouse `content=true` list: airbnb **2.7 MB**, stripe **5.6 MB**, cloudflare **8.0 MB**: every
  board measured is over the default;
- Ashby job board: one board at **13.9 MB** (past even the 10 MiB ceiling, which is the honest
  `PAYLOAD_TOO_LARGE` for that board), three others at 2.6-3.0 MB;
- Arbeitnow page 1: **4,209,793 bytes**, with `per_page`, `limit`, `page_size`, `size` and `perPage`
  all ignored by the provider, so the page size cannot be lowered to fit.

The shape of the fix (not a decision): an additive optional `maxBytes?` on `FetchRequest`, honoured by
`bounded-fetch` when present, still bounded at the default when absent and refused when above the
hard ceiling; each adapter then passes its own declared cap into the request it builds, instead of
repeating a literal.

**Check on closing:** fetch a response of 3 MiB through the transport with the adapter's declared cap
at 10 MiB and see it delivered; fetch the same with no declared cap and see it refused at 2 MiB;
declare 11 MiB and see the declaration refused. Today the first is refused.

## 320. A board carrying a permanent unlisted posting never reaches the full-inventory claim, so absence-based closure never fires for it (2026-10-24)

**Open** — a consequence of quarantining Ashby `isListed: false` postings, which is the right
treatment and the plan's; it currently belongs to nobody. Owner to be named by whoever owns the
disappeared-postings sweep (the consumer of the coverage claim).

The base derives a batch's coverage from its counts, and any quarantined item makes the coverage
`PARTIAL` instead of `FULL_INVENTORY`. In the code comments of the lifecycle work `FULL_INVENTORY` is
the closure signal: only a complete inventory entitles the collector to treat a posting that is no
longer listed as gone. An Ashby board that permanently carries one unlisted posting (documented as
reachable by direct link only) will therefore be `PARTIAL` on every run, and none of its vacancies
will ever be closed by absence. Measured behaviour, pinned by a test in the Ashby spec: a board of one
listed posting is `SUCCEEDED` with coverage `FULL_INVENTORY`; the same board plus one unlisted posting
is `SUCCEEDED` with coverage `PARTIAL`.

Not observed in practice yet: none of 10 non-empty Ashby boards (1,612 postings) held an unlisted
posting, so the public listing appears to omit them and the case may never occur. If it does, the
options are a base-level adapter exclusion that is counted but does not weaken the claim, or accepting
`PARTIAL` for such a board. That choice belongs to the owner of the sweep.

**Check on closing:** a board with one deliberately unlisted posting is collected twice, and the
postings that disappeared between the runs are either closed (exclusion kept out of the coverage
claim) or the loss of closure is documented as accepted.

## 321. The Task 3.1 provenance specs list four providers by name and keep their own copy of the schema; consolidate onto the shared helper (2026-10-24)

**Open** — raised by the spec review of the ATS A adapters. The ATS A change added one shared
provenance schema and reader (`src/test/fixture-provenance.ts`) and a spec that walks every directory
under `__fixtures__` (`fixture-provenance.all.spec.ts`), which already covers the RSS captures that
had no hash check. It left Task 3.1's two older specs alone, to avoid conflicting with work in flight:
`fixture-provenance.spec.ts` still enumerates four providers by name and carries its own copy of the
schema with slightly different rules (status 200 required, raw and file hashes required to differ),
and `native-id.spec.ts` keeps its own table next to the new `ats-native-id.spec.ts`.

Two schemas and two provider lists describing one contract is a seam that will rot: a field added to
one is silently absent from the other, and a new provider is protected only if somebody remembers to
add it to the right list. Owner: the next task that touches either spec (Task 3.7 reads every
`*.provenance.json`, so it is the natural one).

**Check on closing:** `grep -rn "provenanceSchema" apps/api/src` finds exactly one definition, and
adding a provider directory with a fixture and no provenance file fails a spec without anyone editing
a list.

## 322. A stranded worktree's documented destination is an agent who is refused the same command (2026-10-24)

`agent-isolation.md` rule 6 says: "Your own — remove it, a foreign one — report to the orchestrator."
`pre:bash:cross-agent-blast` says the same thing in its own refusal text: "Чужой стух? Не трогай: сообщи
оркестратору, он видит всех агентов, а ты — нет." Both name the orchestrator as the party who resolves it.

**Measured: the orchestrator is refused that command too.** On PR #1120 the code reviewer finished, reported
its checkout clean, and said plainly that `git worktree remove` had been refused as `WORKTREE-UNRECORDED` and
that it had not bypassed the hook — exactly the behaviour the rule asks for. The orchestrator then ran the
removal itself, from its own worktree, with a fully expanded literal path and no variable anywhere in the
command, and was refused `WORKTREE-REMOVE`: the path is not recorded against the orchestrator either, because
the hook's record is written only to the agent that created the worktree.

So the escalation path terminates nowhere. The reviewer is right not to remove it, the orchestrator cannot, and
the rule's sentence describes a handoff that no code permits. **This is a rule naming a destination that cannot
act** — the same defect class as a deferral pointing at a file nobody tracks, one level up: the destination
exists as a role rather than as a file, and is equally unable to receive the item.

**What the orchestrator genuinely does and does not know.** It knows the agent is finished (its task notified
completion) and that the tree is clean (checked by `--git-dir`/`--work-tree`, which the hook does not intercept).
It does not know this from seeing the agent, which the hook correctly assumes; it knows it because the agent
reported and then stopped. That distinction is why extending the hook's trust to "any orchestrator" would be
wrong, and why the fix belongs in the record rather than in the predicate.

**Candidate answers, in increasing cost:**

1. **Record the dispatching session alongside the creating agent.** `git worktree add` under a session's
   scratchpad already identifies the session in the path; writing `<session_id> <path>` next to
   `<agent_id> <path>` would let the orchestrator of that session remove what its own children stranded,
   while a sibling agent stays refused. This keeps the predicate's shape and only widens the ledger.
2. **A `--released` handshake.** An agent that finishes with a checkout it cannot remove writes one line
   releasing it; the hook then permits removal by anyone in that session. More faithful (the agent asserts it is
   done rather than the orchestrator inferring it) and more machinery.
3. **Let the harness remove the scratchpad.** The session scratchpad is the harness's to clean, and a worktree
   inside it is only awkward because the main checkout holds a `.git/worktrees/<name>` administrative entry
   pointing into it. A `git worktree prune` on the main checkout after the session ends would collect them,
   and nothing in the rules says who runs it.

Until one of them lands, the correct behaviour for both agent and orchestrator is what happened here: leave it,
record it, and let the owner sweep — which is a running cost of roughly one stranded checkout per review round,
tracked in `.claude/tasks/SWEEP-stranded-checkouts-2026-10-24.md` (untracked file; its count was 15 before this
one).

**Check on closing:** an agent that creates a worktree in its session scratchpad and exits without removing it
leaves a tree that the dispatching orchestrator can remove in one command, while an agent of a different session
is still refused the same path.

## 323. Four small findings from the PR #1119 review rounds, each too small for its own entry (2026-10-24)

Three review axes passed PR #1119 (Task 3.5b, quota-metered adapters) and raised sixteen identifiers. The
MED ones were fixed in the PR. These four are what is left: none blocks, each is checkable, and each would
otherwise live only in a review thread that nobody re-reads.

**`observedAt` is validated by shape and never read.** The TheirStack billing observation carries an
`observedAt` instant checked only against a format regex, so `2026-13-45T99:99:99.000Z` is accepted. The
field is recorded and no code consumes it. Two honest answers: validate it as a date, or drop it and let
the record say when the smoke happened in prose. **Check on closing:** an impossible calendar date is
refused, or the field no longer exists.

**`accept-language` is on the JSON header allowlist with no caller.** Measured at the time: every `headers`
literal across the five quota adapters and the five JSON providers on main sends only `accept` —
plus `content-type`, `authorization` and the RapidAPI pair where a scheme needs them. The allowlist's own
comment justifies itself as "what the adapters were MEASURED to send", and this member was not. It is the
same no-user problem that removed `from`, and the exact-set test pins it either way, so the test passing is
not evidence that it is used. **Check on closing:** the allowlist contains no member that no caller sends,
asserted by a search over the callers rather than by the allowlist's own test.

**A mutation-gate tool failure is reported without naming the mutant.** Runs on this branch report 712
mutants, 711 killed, 0 survived and **1 tool failure**, and the tool failure is attributed to a module-load
quirk in `muse.provider.ts`. A tool failure is neither a pass nor a survivor — a distinction this project
has already paid for once, by counting `[Survived]` mentions in a log instead of reading the gate's own
classification. The figure is only trustworthy if the one failure is named and shown to sit outside the
code whose mutants matter, in this case the secret-redaction floor and the billing derivation. **Check on
closing:** the gate's own output names the failing mutant, or the count is reported as 711 of 711 with the
twelfth excluded for a stated reason.

**The 8-character secret floor in `env.ts` is a boot-time refusal.** A key shorter than eight characters
stops the process rather than being rejected at use. That is the right direction and it is currently
unreachable, because no provider key is provisioned and none may be — so there is no deployed short key to
break. It becomes real the day the owner provisions one, and a provider that issues a short key would
present as a boot failure rather than as a configuration error. **Check on closing:** a short key produces
a message naming the variable and the floor, at whatever point it is rejected.

## 324. Flow Gate's MISSING bucket means two different things, and its legend asserts the wrong one (2026-10-24)

A step's status can be `done`, `STALE`, `MISSING` or `n/a`. Measured on PR #1119 within one hour, the same
`MISSING` was printed for two unrelated situations:

| What was true                                   | What the gate printed |
| ----------------------------------------------- | --------------------- |
| no spec review existed at all (verdict count 0) | `Spec-Review          | MISSING | no "Spec Review: PASS" review`    |
| a spec review existed and said `ISSUES`         | `Spec-Review          | MISSING | the latest verdict … is negative` |

The detail text does distinguish them. The **status does not**, and the gate's own explanatory section in
the same output says: "unlike **MISSING**, which is a step nobody has looked at yet." That sentence is false
in the second case — someone looked and rejected it.

**Why it matters rather than being cosmetic.** The two call for opposite actions. "Nobody looked" means
dispatch the axis. "Reviewed and rejected" means address the findings, and dispatching a fresh reviewer
instead invites it to re-derive what the first one already said. The orchestrator read this exact line on
#1119, concluded no spec review had ever run, and was right — but only because it separately counted the
verdicts and got zero. The status alone did not support the conclusion it appeared to support.

**Candidate answers:** a distinct status for a negative standing verdict (`REJECTED` reads naturally beside
`STALE`), or, at minimum, correcting the legend so it stops claiming something the classifier does not
guarantee. The first is better; the second is nearly free and removes the false sentence.

**Check on closing:** a PR whose only spec review is negative prints a status distinguishable from a PR with
no spec review at all, and no explanatory text claims MISSING implies nobody looked.

Related: entry 311 (three other matcher and classifier gaps found by using the gate).

## 325. The critical-path zone list omits secret handling and committed personal data, so Security-Review reads n/a where the axis finds real defects (2026-10-24)

`contracts.md` §2.1 is the canonical list that makes `security-reviewer` mandatory, and Flow Gate implements
it faithfully. Verbatim, the five zones are auth/sessions/JWT/OAuth; finance/calculation logic/split
math/rates; RBAC/role visibility/data masking; wallets/transactions/company-account (USDT); Drizzle
migrations/new tables.

**Two PRs on 2026-10-24 printed `Security-Review | n/a` while carrying a real security surface:**

- **PR #1119** handles five providers' **API keys** and the redactor that keeps them out of logs, traces and
  errors. The axis was dispatched on the orchestrator's judgment, not by rule, and returned two MED
  findings — including the one that mattered most, verified by running it: that the exception `withSecrets`
  raises _about_ a too-short secret does not itself leak the secret, checked through `.message`, `.stack`,
  `JSON.stringify` and `util.inspect` with `showHidden`.
- **PR #1120** commits captured third-party pages as fixtures. An earlier head of it had to have 462
  e-mail addresses removed. A later change moved the capture directory, which would silently have dropped
  those files out of a personal-data scan had the executor not noticed unasked.

Neither surface is named by the list. "Data masking" is the nearest member and is about role visibility,
not about what lands in the repository or what leaves it in a request header.

**So the gate is correct and the list is incomplete** — which is the worse failure of the two, because a
faithful implementation of an incomplete rule reads as an authoritative `n/a`. Both dispatches happened
because someone remembered, which is the mechanism this project replaces with gates everywhere else.

**Candidate members, phrased as behaviour rather than as file paths:** code that places a credential in an
outbound request or formats one for a log; code that commits or relocates captured third-party content; and
code that defines or relaxes a redaction boundary.

**Check on closing:** a diff that adds a credential to an outbound request header, and a diff that commits a
captured third-party page, each make Security-Review required rather than `n/a`.

## 326. In zsh a variable named `path` is tied to `$PATH`, and clobbering it destroys the shell's commands (2026-10-24)

`verification-integrity.md` already records that this environment's Bash tool runs **zsh**, and names the
`${VAR}:path` modifier trap. This is a second, independent zsh trap in the same family, measured on
2026-10-24 while verifying PR #1120.

`path` is one of zsh's special parameters: it is an array **tied to `PATH`**. So an ordinary-looking
assignment inside a loop —

```sh
for f in a b; do path="some/relative/dir/$f"; ...; done
```

— replaces the command search path with one relative directory, and every subsequent command in that shell
fails with `command not found`, including `git`, `grep` and `wc`.

**Why it belongs with the swallowed-failure family rather than being a curiosity.** The failure arrives in a
shape that reads as a clean negative. In the measured case the loop printed field labels with empty values
and the commands' `command not found` lines appeared **before** the loop's own `echo` header, because the
command substitutions ran first in the environment that had just been destroyed. A field reading
`email-shaped strings: ` next to a label is one glance away from being read as zero. "Nothing matched" and
"nothing could run" were again indistinguishable at the consumer.

**The cure is a naming rule, not vigilance:** never name a shell variable `path`, `cdpath`, `fpath`,
`manpath`, `PATH` or `PROMPT`. For a file being examined in a loop, `blob`, `file` or `target` all work.

**Check on closing:** `grep -nE '(^|[^A-Za-z_])path=' ` over `scripts/`, `.claude/hooks/` and
`.github/workflows/` finds no assignment to a bare `path` in a zsh-executed context.

## 327. An unboarded JUNIOR crashes the production build on `/` (React #185) — and the two tests for it are `fixme` (2026-10-24)

Found while gating the 54 previously ungated E2E specs (PR #1121). **A product defect, deliberately
not edited around:** the author left two tests as `test.fixme` rather than making them pass, which is
the right call and the reason this entry exists.

**Symptoms as reported.** An unboarded JUNIOR landing on `/` crashes the **production build** with
React error #185, "Maximum update depth exceeded" — a render loop, not a blank screen. It reproduces
on the real stack, not only under mocks: seed user `ivan.petrenko` gets an empty `<main>` on
`/project` and never reaches `/onboarding`. Under mocks, 13 of 15 cases in the affected spec fail.

**Suspected cause, and it is a hypothesis rather than a diagnosis:** the JUNIOR redirect in
`index.tsx` racing the onboarding gate in `route.tsx`. React #185 is minified, so reproduce in a
production build and get the real component stack before changing anything — `diagnosing-bugs`
applies and its gate is "no red command, no hypotheses".

**The part that makes this urgent rather than merely open: the defect is invisible in CI.** Both
tests are `test.fixme`, so they report as skipped on every run. Un-skipping them is part of the fix,
not a follow-up — without that there is nothing to confirm a fix against.

- `onboarding-flow.spec.ts` › "JUNIOR: unboarded user …"
- `onboarding-regression-pr110.spec.ts` › "Unboarded JUNIOR: …"

**Why this is in the backlog and not only in a task file — a lesson worth more than the bug.** The
reporter wrote its notes to `.claude/tasks/<task>.blocked.md`, and the spec reviewer filed it as a
finding because that path is **gitignored**: the notes live in one worktree and die with it. I then
wrote a task file for the fix and it had the identical defect, for the identical reason. **A follow-up
recorded in a gitignored path is not recorded.** `BACKLOG-followups.md` is committed and is the only
durable home in this repository; every `.blocked.md` any agent writes has this property, and the rule
that tells agents to write one does not say so.

**Also worth checking when this is fixed:** seed senior B (`dmytro.marchenko`) is deliberately not
onboarded, so the unboarded path is reachable for more than one role and may have more than one entry
point. State whether any other role is affected rather than fixing only the JUNIOR route.

**Check on closing:** an unboarded JUNIOR reaches `/onboarding` from `/` and from `/project` without
a render loop in a production build; both `fixme` markers are gone and both tests are green twice; and
a test fails if the race returns, since a redirect race fixed by reordering two effects is the kind of
fix that comes back silently.

## 328. Deferred non-blocking items from the PR #1119 / #1120 / #1122 review rounds (2026-10-24)

These are LOW items the review axes raised on the three Task-3.x adapter PRs and that I (Master) chose not to
hold a merge for. Each is a sentence or a bounded, non-urgent fix; each has a verification condition so a
reader can tell whether it is still live. Grouped because none is worth its own heading and the shared
context is that all three adapter PRs are blocked, unkeyed, and inert in production.

**From #1119 (TheirStack quota adapter):**

- **The `BillingObservation` docblock's worked example writes "limit 100, reserve 25"**, where `limit`
  elsewhere in that block means the configured `L` (25 there). A reader can take `L` as 100 and compute
  `N = 1` instead of 38. The next sentence defines `B` and `L`, so it is ambiguous rather than wrong.
  **Check:** the example names `B` (account budget) and `L` (reservation) by the same symbols the formula
  uses.
- **A stale round-labelled line** ("Item 10") in the PR body carried the pre-correction 304-hazard wording;
  it is superseded by the round-7 entry and round-labelled, so it was left. **Check:** if that body is ever
  consolidated, the superseded line is removed rather than read as current.

**From #1122 (ATS-B adapters):**

- **Workable's `robots.txt` carries `Content-Signal: ai-train=no`.** The vacancy text this adapter collects
  must never be used to train or fine-tune a model in the inference layer. This binds `@crm/inference`, not
  the adapter, and there is nothing to enforce in #1122. **Check:** the inference layer's data-source policy
  names Workable-sourced text as train-excluded before any such text reaches a training or fine-tuning path.
- **The report redactor over-matches on English words**, rewriting prose like "token from" or a company
  name containing "Token" to `[REDACTED]`. It touches only reports, errors and invalid-sample messages,
  never stored vacancies, and leaks nothing — it destroys prose. It is shared code outside #1122's diff.
  **Check:** the redactor keys on a secret _value_ registered for redaction, not on a word.
- **The shared report redactor misses unregistered credentials** in `Bearer: x`, `X-…-Token: x` and
  `Token=x` shapes. Existing shared code, not introduced by #1122. **Check:** a credential in those shapes,
  not separately registered, is redacted from a report.
- **Recruitee's `description` and `requirements` are joined with no separator**, and Workable's `sameName`
  uses a locale-default `localeCompare`. Both LOW, both cosmetic. **Check:** the joined text has a boundary;
  the comparison uses a fixed locale.
- **Copyright of committed third-party job text and XML** in a public repo is a question for the legal
  agent, not a code fix. **Check:** legal has given a disposition on committing captured vacancy text as
  fixtures.

**From #1120 (free-JSON-B adapters), carried from earlier rounds and not re-raised as blockers:**

- **The personal-data scan reads addresses and profile links, not names.** Named individuals in free text
  (for example a managing director beside an Impressum address, or a first name beside a redacted profile
  link) are outside it by construction, and the spec header now says so. **Check:** the header's NOT COVERED
  list still names "personal names in free text".
- **The profile-link test covers `/in/` paths only** — a `/pub/` profile, `lnkd.in`, or a non-LinkedIn
  profile URL would pass. None is in the corpus. **Check:** either the test covers those forms, or the
  header lists them as not covered.

**A durability gap the spec axis raised on #1122, recorded here because it outlives that PR.** Two
decisions made during these rounds live only in gitignored task files, where a PR reader and the repo's own
history cannot see them: the loosening of Task 3.4's "`ats-config.ts` additive only" to "behaviour-preserving
extension", and the closure of the Recruitee-deadline manifest finding by deferral to Task 3.7. The
adapter-level fact is durable — `RECRUITEE_TOKEN_DEADLINE` is an exported constant the adapter enforces — but
**the manifest's obligation to import and assert against it lives only in the untracked 3.7 brief.** If that
brief is lost or reworded, nothing in the repository records that Task 3.7 must derive readiness from the
date rather than re-type it. **Check:** Task 3.7's PR, when it lands, carries that requirement in a tracked
file (its own code, a spec, or an ADR), not only in `.claude/tasks/`.

**The one that is not mine and not deferrable the same way:** the convergent integration-run defect is
already tracked as entry **317** ("The integration-run model is a dichotomy; reality has a third case that
reports a confident pass"), filed by a parallel session. The security axis found the same thing on #1119
independently; #1119 closed its instance by recording an actual filtered run with the executed count. No new
entry — 317 holds it, and this line exists so the #1119 provenance points at it.

## 329. Two follow-ups from PR #1122's round-2 review — the next layer of the SmartRecruiters dormancy guard (2026-10-24)

Both found by the code axis on PR #1122 at `b747340c`, both correctly judged non-blocking there, both the
_next_ layer of a guard that is sound for every path reachable today. Recorded so they are not lost when
that PR merges.

- **`createSmartRecruitersProvider(bounds, { liveDespiteRobots: true })` is a public export.** The provider
  is dormant by construction — the live loop (`collectSmartRecruiters`) is unexported, and the only route to
  it is the `liveDespiteRobots === true` option, which parsed config cannot supply, so the default export
  and every config refuse. But a **future non-spec caller** could arm the factory directly, and every
  current test would stay green, because the dormancy specs exercise the default export rather than forbid
  the armed one outside tests. The fix the reviewer proposed is a **source-scan test that no non-spec file
  contains `liveDespiteRobots`**. This belongs with registration — the first place such a caller could
  appear is plan Task 2.5 / Task 3.7 — and SmartRecruiters is `BLOCKED(robots)` with no authentic capture,
  so there is nothing to register today. **Check:** a test fails if any non-spec file references
  `liveDespiteRobots`, added no later than the change that first registers a phase-3 adapter.
- **The Personio host-declaration assertion compares two copies of the same template**, so it catches drift
  between the declared host and the request but not a mistake shared by both. The real protection is the
  slug-and-`tld` validation (`board` a single DNS label, `tld` limited to `de`/`com`), which is tested
  against hostile spellings. **Check:** the host assertion derives the expected host from something other
  than the same template the code uses, or the review note explains why the slug/tld validation makes that
  unnecessary.

Both are on the SmartRecruiters path, which cannot run in production until registration (Task 2.5) exists —
the same keystone every phase-3 adapter waits on.

## 330. The privacy scan's own controls are unguarded by CI, so a later loosening would be caught by nothing (2026-10-24)

Raised by the spec axis on PR #1120 at `abc12d1b` as outside its own axis, and it is right that it needs a
home rather than a verdict.

`fixture-provenance.spec.ts` carries the personal-data scan for the job-source fixtures: a decode-first
`@`-token check, a decode-first `linkedin.com/in/` check with 13 planted-form controls, a whole-value
`isPlaceholder`, a root guard and a recommitted-raw guard. Those controls are real — during PR #1120 they
found two named individuals' e-mail addresses and three personal profile slugs that four hand-written scans
had missed, and one control (`/in&#x2Fbob`) exposed a genuine greedy-hex bug that read `&#x2Fb` as U+02FB.

**The gap: nothing mechanically proves the controls still bite.** The mutation gate loads spec files in its
dry run but does **not mutate them**, so a 0-survivor gate result says nothing about whether the scan's
regexes still catch anything. The only evidence they work is a **hand-mutation the author performed once**
— reverting the slug class to ASCII and making the entity read greedy, observing four controls fail, then
restoring the file. That is good practice and it is **not re-runnable by anyone**, so it does not survive
into the future. A later simplification of the scan — widening `isPlaceholder`, shortening the decode
rounds, narrowing the slug class back to ASCII — would pass CI green.

This is the same shape as the defect the whole PR was about, one level up: a property established by an act
rather than by an instrument.

**Candidate answers, in increasing cost:**

1. **Mutation-test the scan helpers by moving them out of the spec.** If `decodeDelimiters`, `PROFILE_LINK`
   and `isPlaceholder` lived in `src/test/` as a module rather than inside the spec file, the gate would
   mutate them and the 13 controls would become the thing that kills those mutants. Cheapest real fix, and
   it uses machinery that already exists.
2. **A meta-test that mutates the scan in-process** — apply a known loosening to a copy of the pattern and
   assert the control fails. Self-contained but writes a mutation harness by hand.
3. **Leave it and rely on review.** This is the status quo and is what the twelve rounds of #1120 show does
   not reliably hold.

**Check on closing:** a loosening of the slug class, the decode-round cap or `isPlaceholder` fails a check
in CI without anyone re-reading the spec.

Related: entry 328 (the scan reads delimiters and addresses, not names in free text), and the #1120 history
for what the controls caught.
