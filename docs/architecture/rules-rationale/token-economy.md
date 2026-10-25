# Rationale — `token-economy.md`

Rule: `.claude/rules/common/token-economy.md` · Playbook: `.claude/skills/token-economy/SKILL.md`

## Provenance

Requested by the owner on 2026-10-24 after reading the DataCamp tutorial _How to Reduce Token Usage in
AI Coding Agents: 4 Tools That Can Help_ (published 2026-09-10): Caveman, Ponytail, RTK, Context Mode.

**Source caveat.** The cloud session's network policy denied `www.datacamp.com`, so the article itself
was not read. The four tool names come from the article's search snippet; the tool descriptions come
from secondary write-ups and mirrored READMEs found by search. Every figure below is third-party and
unverified against the primary repositories. Re-read the article and the four repos before treating any
number as ours.

## What each tool does, and what we took

| Tool         | Mechanism (as reported)                                                                                       | Reported effect                                                                        | What the repo now has                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Caveman      | Prompt-overlay skill; a SessionStart hook re-injects a terse-reply persona (lite / normal / ultra)            | Claims ~65% fewer output tokens; independent tests 12–25%; output is ~1–3% of a bill   | Lever 1: terse **narration** only, with an explicit never-compress list                 |
| Ponytail     | Restraint skill: a decision ladder (does it need to exist → stdlib → existing dep → minimum)                  | Claims 54% fewer lines, ~22% fewer tokens; maintainers later called 54% a task ceiling | Lever 2: the ladder, with a never-cut list (validation, RBAC, money, a11y, i18n)        |
| RTK          | Rust CLI proxy; a hook rewrites Bash commands (`git status` → `rtk git status`) to filter output              | Claims 60–90% on common commands; does not touch Read / Grep / Glob                    | Lever 3: the same idea by hand — bounded reads, quiet reporters, counts kept visible    |
| Context Mode | MCP server running code in a sandbox so only printed output enters context; SQLite index for post-compact use | Claims 98% on its own benchmark                                                        | Lever 4: park bulk output in a scratchpad file, then `grep`/`head`; fan-out for breadth |

## Why the first pass installed none (superseded — see Install status)

The first pass (same day) held back. Each installs executable third-party code into the agent
harness of a repository whose critical paths are auth, RBAC and money:

1. **Supply chain.** A SessionStart hook (Caveman), a Bash-rewriting hook plus a binary (RTK) and an
   `npx -y` MCP server (Context Mode) all run with the agent's privileges. Pinning and reviewing them is
   an owner decision (`autonomy-levels.md`: external send / irreversible → A3), not a drive-by add.
2. **RTK collides with our evidence rules.** The Bash hooks (`pre:bash:*`) analyse the command string a
   rewriter would change, and filtered output is exactly the "instrument that did not look" shape in
   `verification-integrity.md`. RTK also shares a name with an unrelated crate (Rust Type Kit);
   READMEs warn that installing the wrong one is common.
3. **Context Mode widens every agent's tool surface** (the reason `graphify-mcp` was declined in
   `mcp-first.md`) and executes code in a second sandbox next to `live-db-access.md`'s limits.
4. **Caveman's persona leaks into artifacts that must stay complete** (verdicts, briefs, legal/finance
   notes). A persona is global; the rule's never-compress list is local.
5. **Expected gain is low where it is not already taken.** Output is a small share of the bill; the
   large levers (tier choice, bounded reads, fan-out for breadth) already exist in `model-routing.md`,
   `mcp-first.md` and `orchestration-routing.md`. This rule adds the missing habits, not a second stack.

## Install status — owner decision 2026-10-24: "install all four"

The owner overrode the first-pass hold (A3 decision, recorded here). What was done, from primary
sources (cloned at the pinned tag/commit, not search snippets):

| Tool         | Pin                         | Licence                                         | State                                                                                                                                                                                    |
| ------------ | --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTK          | `v1.0.1`, `rtk-oss` edition | Apache-2.0 (the default asset bundles BUSL-1.1) | **Installed in the repo:** hook `pre:bash:rtk-rewrite` (fail-open) + `scripts/devops/install-rtk.sh` (sha256-verified). Binary must be installed per machine / environment setup script. |
| Caveman      | `v4.0.1`                    | Apache-2.0                                      | `.caveman.json` sets `lite` (reports stay readable). **Plugin enabled** in `.claude/settings.json` (pinned marketplace ref).                                                             |
| Ponytail     | `v5.3.2`                    | MIT                                             | **Plugin enabled** (pinned).                                                                                                                                                             |
| Context Mode | `v1.0.169`                  | **Elastic-2.0** (source-available, not OSI)     | **Plugin enabled** (pinned). Adds hooks on 6 events + 11 MCP tools + a local SQLite store.                                                                                               |

The three plugins were first staged: the session's auto-mode classifier refused the `settings.json`
edit that registers third-party plugin marketplaces ("Untrusted Code Integration"). After the owner's
explicit instruction (2026-10-25) the same block was applied and the runbook item closed.
Note `claude plugin marketplace add --scope project` rewrote the whole `settings.json` destructively
(dropped hook `id`/`description`, cache TTLs, and reset `permissions.allow`) — **do not use the CLI
command on this file; paste the JSON block.**

**Hook conflicts — found and resolved (2026-10-24).** A differential run of every `pre:bash:*` guard
over the 419-row command corpus plus push/commit/worktree cases, original vs RTK-rewritten (151 commands
rewritten), found 30 divergences when a guard sees `rtk <cmd>`: false negatives (`rtk git worktree
remove`, `rtk psql … COPY PROGRAM 'rm -rf /etc'` slipped through) and false positives (`rtk grep 'pnpm dev'`
blocked). Fix: `rtk` is a transparent wrapper in `lib/cmdscan.py` (and `rtk bypass` is unwrapped) and in
`pre-bash-cross-agent-blast.sh`; regression rows added to the corpus and the blast test. Re-run: 0
divergences. (A first "0" was a false green — a syntax error made both sides exit 2; the harness now also
checks the decision body and crashes.) Whether Claude Code hands guards the original or the rewritten
command no longer matters.

**Still not verified:** end-to-end ordering inside a live Claude Code session — the existing hooks carry
owner-machine absolute paths and cannot run in the cloud container. Smoke-test on the owner machine: `git push` with a bad `ac_verified` must still be
refused. The code of the four tools was not audited line by line; privacy claims (RTK telemetry off
by default, Context Mode local-only) are from their READMEs.

**Rules that bind the installed tools:** `rtk bypass <cmd>` whenever output is evidence to be read
verbatim; `ctx_execute` and friends are still bound by `live-db-access.md` (no writes to `crm_db`)
and `agent-isolation.md`; owner decision 2026-10-25: Context Mode is connected for agents too — the five `ctx_*` sandbox/search
tools (`mcp__plugin_context-mode_context-mode__*`) are in the `tools:` of the seven agents that read
large outputs; legal, copy-reviewer, architect and ui-ux-designer do not get them.

## Condition to reopen (removal / bump)

Bump a pin only after reading the changelog (never on green CI). Remove a tool when: a one-week A/B on
real sessions shows no measured saving net of lost evidence; a `pre:bash:*` guard is found not to fire
on an RTK-rewritten command; a licence or telemetry default changes; or the owner says so.

## Why the rule is short and always-on

Always-on files are injected into every request of every subagent — a token-economy rule that is itself
long defeats its purpose. The rule holds the five obligations and the violation table; examples and
commands live in the skill, loaded on demand (progressive disclosure, `writing-for-agents`).

## Why "mandatory for all agents" is procedural, not a hook

Whether an agent read "too much" is a judgement over a transcript, not a pattern in a command; a hook
would refuse legitimate reads. Observability is the `Token-economy:` report line plus reviewer checks
(same device as `Worktree:` / `Pushed:`).
