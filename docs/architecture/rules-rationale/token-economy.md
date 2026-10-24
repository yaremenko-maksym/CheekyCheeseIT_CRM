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

## Why none of the four is installed

A deliberate decision, not an omission. Each installs executable third-party code into the agent
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

## Condition to reopen

Install a tool only after: (a) the owner decides, (b) its primary repo is read and a version is pinned
(exact, like `standardwebhooks`), (c) a one-week A/B on real sessions shows a measured saving net of
lost evidence, (d) for RTK, a hook-corpus test shows `pre:bash:*` predicates still fire on rewritten
commands. Candidate order by value/risk: RTK (largest input saving) → Ponytail (pure skill, no hook).

## Why the rule is short and always-on

Always-on files are injected into every request of every subagent — a token-economy rule that is itself
long defeats its purpose. The rule holds the five obligations and the violation table; examples and
commands live in the skill, loaded on demand (progressive disclosure, `writing-for-agents`).

## Why "mandatory for all agents" is procedural, not a hook

Whether an agent read "too much" is a judgement over a transcript, not a pattern in a command; a hook
would refuse legitimate reads. Observability is the `Token-economy:` report line plus reviewer checks
(same device as `Worktree:` / `Pushed:`).
