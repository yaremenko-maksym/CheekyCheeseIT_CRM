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

| Tool         | Pin                         | Licence                                         | State                                                                                                                                                                                          |
| ------------ | --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTK          | `v1.0.1`, `rtk-oss` edition | Apache-2.0 (the default asset bundles BUSL-1.1) | **Installed in the repo:** hook `pre:bash:rtk-rewrite` (fail-open) + `scripts/devops/install-rtk.sh` (sha256 pinned in-repo). Binary must be installed per machine / environment setup script. |
| Caveman      | `v4.0.1`                    | Apache-2.0                                      | `.caveman.json` sets `lite` (reports stay readable). **Plugin: user scope** (owner machine, `~/.claude`), pinned marketplace ref.                                                              |
| Ponytail     | `v5.3.2`                    | MIT                                             | **Plugin: user scope**, pinned.                                                                                                                                                                |
| Context Mode | `v1.0.169`                  | **Elastic-2.0** (source-available, not OSI)     | **Plugin: user scope**, pinned. Adds hooks on 6 events + 11 MCP tools + a local SQLite store.                                                                                                  |

The three plugins were first staged: the session's auto-mode classifier refused the `settings.json`
edit that registers third-party plugin marketplaces ("Untrusted Code Integration"). The owner
then decided (2026-10-25) that the three plugins live at **user scope** on their machine, not in the
project `settings.json` — so nothing in the repo declares them and cloud / other-contributor sessions do
not load them. Install commands (pins) are below.
Note `claude plugin marketplace add --scope project` rewrote the whole `settings.json` destructively
(dropped hook `id`/`description`, cache TTLs, and reset `permissions.allow`) — **do not use the CLI
command on this file; paste the JSON block.**

Install at user scope (run once, outside the repo; back up `~/.claude/settings.json` first — the CLI
rewrites settings files):

```bash
claude plugin marketplace add JuliusBrussee/caveman@v4.0.1 --scope user && claude plugin install caveman@caveman --scope user
claude plugin marketplace add DietrichGebert/ponytail@v5.3.2 --scope user && claude plugin install ponytail@ponytail --scope user
claude plugin marketplace add mksglu/context-mode@v1.0.169 --scope user && claude plugin install context-mode@context-mode --scope user
```

**Hook conflicts — found and resolved (2026-10-24).** A differential run of every `pre:bash:*` guard
over the 419-row command corpus plus push/commit/worktree cases, original vs RTK-rewritten (151 commands
rewritten), found 30 divergences when a guard sees `rtk <cmd>`: false negatives (`rtk git worktree
remove`, `rtk psql … COPY PROGRAM 'rm -rf /etc'` slipped through) and false positives (`rtk grep 'pnpm dev'`
blocked). Fix: `rtk` is a transparent wrapper in `lib/cmdscan.py` (and `rtk bypass` is unwrapped) and in
`pre-bash-cross-agent-blast.sh`; regression rows added to the corpus and the blast test. Re-run: 0
divergences. (A first "0" was a false green — a syntax error made both sides exit 2; the harness now also
checks the decision body and crashes.) Whether Claude Code hands guards the original or the rewritten
command no longer matters.

**Why the exec subcommands are refused outright (round 4, PR #1157).** Three review rounds each found one
more quoting form of the exec subcommands (`bypass`, `err`, `test`, `run`, `summary`, entered after the
`rtk` word with one quoted string as the operand) that some guard did not look inside: the blast hook split
the string on a separator inside the quotes, the dev-server gate missed a quoted command word, and the three
`git push` gates match raw text and never used cmdscan. Teaching every guard to parse every form was a losing
game, so `pre:bash:rtk-exec-gate` refuses the form on the RAW command text, and the project has no need for
it: filtered output = run the command normally (the rewrite hook adds the prefix, tool subcommands only),
unfiltered output = prefix `RTK_DISABLED=1` (rtk's own documented opt-out, verified: its hook skips the
rewrite). The cmdscan / blast unwrapping from rounds 2-3 stays as defence in depth. Known limit, shared with
every guard here: the binary reached through a variable or a rebuilt string. A text that merely mentions the
exec subcommands next to the binary name is also refused (false positive by design): separate the words.

Follow-up 1 (review of the first gate) showed that matching the LITERAL spelling of the subcommand word is not
enough either: the shell builds a word from quotes, backslashes, `$'...'` strings and brace expansion, so
`byp''ass`, `te\st`, `$'bypass'`, `{bypass,}` and a split binary word all reach the real subcommand. The gate
now normalises the command text first (drops quotes, backslashes, the `$` of `$'...'`) and also refuses any
word after the binary that is not a literal word (`{ } $ backtick * ?`). The reviewer's alternative, an
allowlist of tool subcommands, was rejected: it would refuse every prose mention such as "the rtk filter",
and agents write commit messages and PR text through Bash all day. Unknown literal words are left alone on
purpose: the binary treats an unknown subcommand as the command itself, which the cmdscan unwrapping and the
blast hook already judge like the bare command. The `git push` gates (raw-text match) are covered by the gate
for the typed forms, because the gate refuses before they matter.

Follow-up 2 (security re-review of that gate, approved with two MED findings) closed the rest of the typed
spellings: the normalisation now also deletes backslash-newline continuations and DECODES ANSI-C strings
(`$'\x62ypass'`, octal and `\U` forms, in the subcommand, a flag or the binary word); an undecodable body
becomes a `$`, which trips the non-literal rule. The non-literal rule (glob, variable or substitution where
the subcommand belongs) is applied only when the binary is in command position, so greps and commit messages
that merely mention the binary name next to a glob or `$(date)` are no longer refused. Remaining documented
limits, shared by every guard in this directory and equal to the `sh -c` limit: a glob in the binary word
(`r?k`), variable- or script-rebuilt words, and a copy or symlink of the binary under another name.

Follow-up 3 (code review of that change): an undecodable ANSI-C body is no longer replaced by a bare `$`. The
pattern has no notion of quoting context, so a `$'` inside an ordinary single-quoted string could start a
bogus match that swallowed a real subcommand up to the next apostrophe; the body is now kept visible to the
later steps. The command-position prefix of the non-literal rule also accepts leading `VAR=value`
assignments (the documented `RTK_DISABLED=1` idiom), `!`, wrappers with their flags and durations, and
`-c` / `-lc` nested shell strings. The test file pins every alternative of that prefix and the decoy; two
mutants (dropping the decoded body, dropping the `-c` position) turn rows red.

Follow-up 4 (security review of that change, four MED findings): the ANSI-C decoder no longer uses
Python's `unicode_escape` (it demands exactly 2/4/8 hex digits, bash takes 1-2, 1-4 and 1-8, and a decode
error hid the whole body); it is a small decoder with bash semantics that keeps any escape bash would not
decode as text and never raises. The printed hit is ASCII-escaped, because a lone surrogate (`$'\ud800'`)
made the print fail and a failed print is a fail-open gate. Whitespace runs are collapsed before the regexes
run, which removed a quadratic path on padded input (20k newlines took 27 s). The command-position prefix
now also accepts a wrapper flag's value (`sudo -u x`, `time -p`, `command -p`) and chained wrappers. The test
pins each of these; mutants that print the raw hit or skip the whitespace collapse turn rows red.

Follow-up 5 (security review, seventh round) and the owner's decision of 2026-10-25. Two more real
bypasses: a redirection between the binary and its subcommand (`2>/dev/null`, `>&2`, `{fd}>f`) and `$IFS`
used as the gap; both are now normalised away, and a binary glued to an expansion is refused. One defect of
mine: the command-position prefix could backtrack exponentially (a chain of `time -p` words took over 40 s,
and a hook timeout is non-blocking, so that was a fail-open); its alternatives are now disjoint and the
test pins adversarial chains (`nice -n 5` x40, `time -p` x60, `a=b;` x50k, a 300 KB chain).

After seven rounds the reviewer's own opinion was that further heuristic patching of a text regex that
re-implements a shell parser has more risk than value. The owner chose to **install the binary outside PATH**
and to freeze the gate. `scripts/devops/install-rtk.sh` now installs to `~/.local/share/rtk/bin` (override
with `RTK_INSTALL_DIR`), the rewrite hook calls it by absolute path, and a bare `rtk ...` typed by an agent is
"command not found". The gate stays as the second layer. For humans: `alias rtk="$HOME/.local/share/rtk/bin/rtk"`.

**Residual limits accepted by the owner (2026-10-25)**, all of the same class as the long-standing
`sh -c '...'` limit of every guard in `.claude/hooks`:

1. The binary or subcommand rebuilt in a variable, a command substitution, an alias, a function, a copy or a
   symlink, or reached through a glob in the binary word (`r?k`).
2. Payloads outside the shell word model: `sh -c "$VAR"`, `eval "$(...)"`, `base64 -d | sh`,
   `source <(...)`, `system()` calls in python, awk or perl.
3. An upper-case spelling of the binary on a case-insensitive filesystem (every guard matches lower case).
4. The binary runs any unknown first word as the command itself (`rtk touch f` works); the exec gate does not
   cover that by design, cmdscan marks it inexact.
5. Rule 1 false positives on prose that puts the binary next to an exec word (commit messages, heredocs).
6. Command-position gaps for rare syntax: backtick wrappers, `if`/`while`/`until`/`elif` conditions, `case`
   arms, leading redirections, quoted or array assignments, fractional `timeout 1.5`, `coproc`, `builtin`,
   `xargs -I{}`, `find -exec`, `flock`, `taskset`, `strace`, `script -qc`, `bash -ec` / `-xc`.

The durable fix, recorded for a later task, is to do the check inside `cmdscan.py`, which already tokenises
words and is shared by every other guard, and delete this second, weaker parser.

Follow-up 6 (code review, seventh round, applied before the freeze): a NUL produced by an ANSI-C escape
(`$'\0'`, `$'\x00'`, `$'\400'`) hid the exec word, because bash cuts such a string at the first NUL and
rebuilds the word around it while the decoder kept the NUL; the decoded string is now cut the same way.
The command-position prefix was exponential a second time (a flag value could also parse as the next flag
or as the duration); it is now unambiguous and a chain of 300 KB finishes in well under a second (the timing
row of the test pins it, 600 random token sequences: worst 0.37 s). Command position now also covers `bash
-ec`/`-xc` strings, a backtick and a `case` arm `)`; a leading redirection is removed by the normalisation.
A second numeric flag value (`nice -n 5 -n 5 <binary> $X`) is not followed, which is the price of the
disjoint alternatives. The decode-failure branch of the decoder is purely defensive (it cannot be reached
with the current digit rules) and is not pinned by a row; the decoy rows pin the case that mattered.

Follow-up 7 (security review, eighth round): the redirection deletion ran after quote stripping, so a quoted,
escaped or ANSI-C redirect target that contains a space (`3>"f g" test`) was cut at the space and hid the
subcommand. It is now a small quote-aware scanner that runs BEFORE decoding and quote stripping and deletes
the operator together with its whole target word. The reviewer's regex fix was not used: on raw text a
quote opened inside a decoy (`echo '>' ; <binary> run ls; echo 'x'`) lets the target swallow the real
command up to a later quote; the scanner treats an operator inside quotes as text, and the decoy is a row.
Two more ambiguities of the flag pattern (`--adj` parsed two ways, a flag value starting with `-`) were
exponential on crafted input (a 240-character command took 30 s); both are removed and the test pins `nice -n
-5`, `nice --adj`, `sudo -u -x`, `env --foo=bar` and the binary's own flag chain at x40, plus 100k-character
quote and redirect floods. `init` joined the refused words as hardening: it rewrites the agent settings of the
tool itself and installs a second hook next to ours.

**Still not verified:** end-to-end ordering inside a live Claude Code session — the existing hooks carry
owner-machine absolute paths and cannot run in the cloud container. Smoke-test on the owner machine: `git push` with a bad `ac_verified` must still be
refused. The code of the four tools was not audited line by line; privacy claims (RTK telemetry off
by default, Context Mode local-only) are from their READMEs.

**Rules that bind the installed tools:** prefix a command with `RTK_DISABLED=1` whenever its output is
evidence to be read verbatim (the exec subcommands themselves are refused by `pre:bash:rtk-exec-gate`,
see the paragraph on the exec gate above).

**Context Mode and agents — reversed after review (2026-10-25).** The owner asked to connect Context
Mode; the first cut granted the five `ctx_*` tools to seven agents. The security review (SR-H-2, PR
#1157) showed every guard is matched on `Bash` / `Edit|Write…` only, so `ctx_execute*` is an unguarded
execution channel — including for read-only reviewers — and `permissions.allow = ["*"]` leaves nothing
else in the way. Grants removed; Context Mode stays installed at user scope for the owner's session.
To grant it to agents later: add a PreToolUse hook on `mcp__plugin_context-mode_context-mode__ctx_.*`
that runs shell `code` through cmdscan and refuses other languages touching `crm_db` / git writes
(A3, security-reviewer mandatory).

**Zone note (CR-M-4).** `scripts/devops/install-rtk.sh`, `.caveman.json`, the hooks and the agent
prompts were written from a Master session on explicit owner instruction (2026-10-24/25), outside the
usual Architect / DevOps zones; recorded here as an owner decision, not a precedent.

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
