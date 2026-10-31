# Rationale: light-track

Rationale layer for `.claude/rules/common/light-track.md`. Not auto-loaded — read on demand.

**Source:** Context-diet audit 2026-06-11 — legitimizing the existing practice of inline fixes. Parallel
dispatch section added 2026-06-16 (ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md`
FM-1/FM-6/FM-7).

---

## Why the light track was written down rather than invented

The master session was already making small inline fixes without a task file. The audit's finding was
not "this should stop" but "this is unwritten, so its boundary is undefined" — and an undefined
boundary is what lets "light" creep onto the security surface. The rule legitimizes the practice and
fixes the boundary in the same move.

## The zombie-devserver incident (2026-07-24)

67 `nest`/`vite` zombies accumulated from worktrees over 12–15 July → swap thrashing → **load average
70**.

The fix was deliberately **mechanics instead of discipline** (three layers: the TTL wrapper, the
`pre:bash:devserver-ttl-gate` hook, the launchd reaper), shipped as PR #403. A documented instruction
to "remember to kill your dev servers" had already existed and had not worked; the distinguishing
property of the three layers is that none of them requires an agent to remember anything.

The zsh `xargs` detail in the manual sweep is from the same incident: `kill $VAR` does not word-split
in zsh and fails with "illegal pid", and the failure was masked by the `2>/dev/null` that the sweep
command carried — so the sweep appeared to work while killing nothing.

## The unbounded-wait incidents (2026-09)

Three cases in a row, where a task hung "Running" for hours or days **after the agent had already
died**:

| Date       | What waited                                               | Duration |
| ---------- | --------------------------------------------------------- | -------- |
| 2026-09-21 | `cat` with no file argument, waiting on stdin             | **25 h** |
| 2026-09-24 | an `until` loop waiting for a string Stryker never prints | ~3 h     |
| 2026-09-25 | `until` loops waiting for `tasks/<id>.status` / `.exit`   | 11.5 h   |

The third is the instructive one: the harness writes only `<id>.output`, so the loops were waiting for
files that are never created by anything. The hook `pre:bash:unbounded-wait` therefore refuses by
**command position** (per the false-positive doctrine in
`docs/architecture/rules-rationale/agent-isolation.md`), and refuses the `.status`/`.exit` pattern
specifically, not just unbounded loops in general.

The non-obvious part of the rule — "a foreground-call timeout does not count as a limit" — is a
property of the harness: on timeout it **moves the command to the background** rather than killing it.
An agent that relies on the call timeout as its bound gets exactly the 25-hour outcome.

## Sources

- Context-diet audit 2026-06-11 — the light/full boundary.
- ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-1 / FM-6 / FM-7 — concurrency ceiling, `DATABASE_URL=` empty.
- Incident 2026-07-24 + PR #403 — zombie devservers, three-layer fix.
- Incidents 2026-09-21 / 09-24 / 09-25 — unbounded waits; origin of `pre:bash:unbounded-wait`.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

### Zombie prevention (mechanics instead of discipline)

Three layers:

1. Dev servers in a worktree/scratchpad start ONLY via `scripts/devops/dev-ttl.sh -- <cmd>` (TTL
   self-destruct of the process group, default 4h);
2. The hook `pre:bash:devserver-ttl-gate` blocks a bare `nest start` / `vite` / `pnpm dev` /
   `node dist/main` in `.claude/worktrees/**` and the claude-scratchpad;
3. A launchd-reaper every 30 min finishes off node processes of a worktree older than 6h or with a
   removed worktree (install: `scripts/devops/install-devserver-reaper.sh`; dry-run:
   `REAPER_DRY_RUN=1 scripts/devops/reap-zombie-devservers.sh`).

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

- **Heavy Coders (each boots vite+api + full Vitest) + a live UT stack** → CPU starvation →
  pre-push timeout flakes (NOT code). Before push — sweep the zombie dev ports of finished agents:
  `for p in 3010 3011 3014 3016 3017 3018; do lsof -ti tcp:$p; done` → kill (preserving live :3000/:3001).
