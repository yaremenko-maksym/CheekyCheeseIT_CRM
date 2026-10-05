# HANDOFF — continuing the backlog, 2026-08-17

> **Historical document.** The handoff of 2026-08-17, superseded by
> `HANDOFF-architect-2026-08-22.md`. The claim below that the backlog is not
> versioned was true at the time of writing — the exception for `BACKLOG-*` /
> `HANDOFF-*` appeared later.

A handoff to the new orchestrator session. The source of truth for findings is
`.claude/tasks/BACKLOG-followups.md` (69 items, **not versioned**, lives only
on the owner's disk).

---

## What is already done (14 PRs merged 16-17.08)

`#530` Skill tool for all agents · `#531` summary sees obligations ·
`#532` three limiters · `#533` one topic · `#534` hygiene (3/6/7/12/13) ·
`#535` private root of the sandbox test · `#536` prod vulnerabilities + `pnpm audit` gate ·
`#537` landing frames + profile shell · `#538` GitHub blocks APPROVE too ·
`#539` honest 404 instead of the home page · `#540` CRM frames · `#542` four guards ·
`#541` junior masking closed everywhere · `#543` floor of money amounts

## Nothing left unclosed from the previous session

All PRs of the previous session are merged. Fresh items found at the very end and not yet started:
**70** and **71** (granularity of Stryker suppressions), **72** (pin a legitimate
zero salary with a test), **73** (no retry on reading branch protection in the automerge — it has already once killed
a merge during a GitHub outage).

## What waits on the owner (do not start without an answer)

- **item 2** — self-referential drop-share records: the profile balance counts `+amount`,
  the drop summary — net zero. Which representation is correct is the owner's decision.
- **item 4** — reconciling company-share amounts of drops in prod: needs his access.
- **A/B/C** — three items are closed at the moment the source filter is switched
  to blocking mode, not earlier.

## Owner decisions made 16-17.08 (do not revisit)

- There is no light theme → the requirement "check both themes" was lifted by a rule.
- 52/53/55 ("deliberate trade-offs") → fix, do not close.
- The design migration to Claude Design is **deliberately postponed**; UI defects are fixed **pointwise,
  without a redesign**, tier 3.
- Junior masking → **hide everywhere**, the "Team" tab was also a leak.
- CRM frames → a separate PR after the landing (done, `#540`).
- **Zero salary is a legitimate case.** Item 72: the behavior is correct, it needs to be PINNED
  with a test (one spec), not fixed. The floor rejects amounts below the scale unit, zero passes
  deliberately.

---

## Working rules derived during this session

They are worth more than the list of items: each cost us a real miss.

**1. A guard is verified by running, not by reading.**
Twice during the session a superficial match gave a wrong conclusion: the audit counted a file by name
(`app.module.spec.ts` exists → item closed, although the test deliberately does not build the container),
and I counted a line from a **docstring** as the implementation (`check-prod-ddl-wiring.py`).
Both times the truth came from running: forge the input and see whether it goes red.

**2. A mutant suppression is verified by removing it — and almost always covers more than the author thinks.**
Established by reading the Stryker source: `IgnoreRule.matches()` matches by the pair
**"line × mutator name"** and knows nothing of the specific replacement — `true` and `false` are
the same to it. Writing "suppress only this replacement" is **impossible**.
Within a day this fired three times: `#531` — eight mutants instead of two (six were killed by
existing tests); `#534` — proof about one, a directive for two; `#541` —
**9 of 12** suppressions silenced both, and on removal 16 of 32 mutants turned out killable.
There is one working form: restructure the code so that exactly the provable
mutant remains under the directive — a named constant on its own line, a split expression, or remove the reason
for the mutant's existence entirely (`#534`: the parameter was needed only by the test).
**And separately:** a directive right after the closing `}` before `else if` is **silently ignored**
by this Stryker version. There are none in the repository right now (all 100 checked), but no gate
checks this position. Backlog items **70** and **71**.

**3. A gate can count a kill it did not earn.**
On `#535` a mutant was "killed" because on Linux `tmpdir()` is `/tmp`, and the mutation failed on
permissions, taking down unrelated tests. On macOS the same mutant survived silently. In the report it looked
like an honest kill.

**4. An instrument that does not execute scripts does not see what scripts set.**
`curl` did not find a single `noindex` on the landing, and I almost closed the question as nonexistent.
In a browser with JS everything was in place (`#539`).

**5. A false positive costs trust, not a minute.**
Our `live-db-guard` blocks a harmless `grep` if the command text contains the word `vite`.
The workaround is cheap and printed in the refusal itself → the "bypass" reflex develops in a couple of times
and then fires on a real run (item 63).

**6. Local `main` goes stale in the middle of a session.**
It was 26 commits behind origin. Read facts via `git show origin/main:<path>`,
not through the working checkout. The same mine took out a table for us in August.

**7. Before dispatching on a backlog item — check against `origin/main`.**
An entry ages silently. Twice during the session I opened a task for something already fixed and caught it
at the last step.

**8. A reviewer who runs into a tool refusal must report the refusal, not bypass it.**
That is how it was found that GitHub with `author == reviewer` blocks **`APPROVE` too**, while three of our
files had been promising the opposite for years (`#538`). There is exactly one working form:
`event: COMMENT` + the verdict on the first line.

**9. Review findings are all closed, including MED and LOW,** before merge. Twice during the session
a MED turned out to matter more than the verdict.

---

## Mechanics worth inheriting

- Dispatch agents in waves of **≤ 3-4**; always `isolation: worktree`; after each —
  check that the main checkout is clean.
- Push of feature branches: `DATABASE_URL= git push`. Prettier — **a separate command** from the commit.
- A PR touching `.github/workflows/**` will not be taken by automerge (the token lacks the right) →
  manual `gh pr merge --squash`, without `--admin`.
- Merge — only on the owner's explicit "merge it"; the orchestrator sets the `merge-approved` label,
  CI does the squash. Remove `do-not-merge`/`awaiting-pm-review` **before** setting the label.
- Fresh worktree: `pnpm install --frozen-lockfile`, then `pnpm --filter @crm/web build`
  (otherwise the web typecheck fails on empty router types).
- Never connect to `crm_db`; set `API_PORT`/`DATABASE_URL` explicitly inline.
  > **Obsolete.** The absolute ban below was in force at the time of writing. The current rule —
  > `.claude/rules/common/live-db-access.md`: **reading is allowed, writing is forbidden.** The boundary
  > is drawn at "read / write" precisely because the absolute ban was violated for the sake of useful
  > work, and a violated rule breeds workarounds.
