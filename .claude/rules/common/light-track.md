# Rule: Light track (master session) vs full track (Master orchestration)

**Status:** Always-on
**Applies to:** USER sessions (Master). Agents (Coder/AutoTest/DevOps/...) work only on the full track (Master orchestration: task file → dispatch → PR → review).
**Source:** Context-diet audit 2026-06-11 — legitimizing the existing practice of inline fixes.

---

## Why

Not every change requires the full track (task file → dispatch Coder → review). Small edits
the master session makes itself — faster and cheaper. This file fixes the boundaries so that "light" does not
creep onto the security surface.

## Light track allowed

- Documentation and markdown: `CLAUDE.md`, `docs/**`, `.claude/**` (agent meta-files, rules)
- Configs without a runtime effect on the product
- A single-file fix ≤ ~30 lines WITHOUT business logic and WITHOUT a security surface
- UI cosmetics (texts, paddings, classes) — with a mandatory playwright screenshot

## Full track only (Master dispatch)

- Features and any multi-file changes
- ANY touch of auth / finance / RBAC / wallets / transactions — security-reviewer mandatory
- New tables / Drizzle migrations
- Changes to `*.spec.ts` — AutoTest zone (master does not edit specs directly)
- Everything that requires test-AC (see ecc/common/testing.md + task templates)

## Light-track mechanics

1. Work from a worktree (`.claude/worktrees/*` — a zone-hook allow path) or the escape hatch
   `.claude/.allow-direct-edits` (gitignored) for emergencies.
2. Changed `.ts`/`.tsx` → `mcp__eslint__lint-files` + `pnpm typecheck` before commit.
3. If the diff has code — `pnpm --filter @crm/e2e test` locally before push.
   **Docs-only diff** (only `.md` / `.claude` meta) — the E2E run is NOT required;
   note it explicitly in the PR body ("docs-only, E2E skipped per light-track").
4. Always a PR — never a direct push to main. Merge — only an explicit "merge" from USER
   (label `merge-approved`).
5. UI touched → a playwright screenshot in the PR.

## Parallel dispatch (concurrency ceiling)

**Status:** added 2026-06-16 (ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-1/FM-6/FM-7).

When dispatching agents in parallel (Master session):

- **Ceiling ≈ 3-4 simultaneous starts.** 5+ agents launched in ONE message (a startup burst
  of the first API calls) -> some get `API Error: 529 Overloaded` and die on start (0 tool_uses).
  Dispatch in waves of 2-3, stagger them; 529-killed ones just restart (they did no work).
- **Heavy Coders (each boots vite+api + full Vitest) + a live UT stack** -> CPU starvation ->
  pre-push timeout flakes (NOT code). Before push — sweep the zombie dev ports of finished agents:
  `for p in 3010 3011 3014 3016 3017 3018; do lsof -ti tcp:$p; done` -> kill (preserving live :3000/:3001).
- **`DATABASE_URL= git push`** (empty) for feature branches — integration specs graceful-skip, do not hit
  the live crm_db and do not catch a CPU timeout (see git-policy.md).
- **Zombie prevention (2026-07-24, mechanics instead of discipline).** Incident: 67 nest/vite zombies from
  worktrees 12–15.07 -> swap thrashing (LA 70). Three layers: (1) dev servers in a worktree/scratchpad start
  ONLY via `scripts/devops/dev-ttl.sh -- <cmd>` (TTL self-destruct of the process group, default 4h);
  (2) the hook `pre:bash:devserver-ttl-gate` blocks a bare `nest start`/`vite`/`pnpm dev`/`node dist/main`
  in `.claude/worktrees/**` and the claude-scratchpad; (3) a launchd-reaper every 30 min finishes off node processes of a
  worktree older than 6h or with a removed worktree (install: `scripts/devops/install-devserver-reaper.sh`;
  dry-run: `REAPER_DRY_RUN=1 scripts/devops/reap-zombie-devservers.sh`). Manual sweep when needed:
  `pgrep -f 'worktrees[/]agent-' | xargs kill -9` — specifically xargs: in zsh `kill $VAR` does NOT split
  (fails with "illegal pid" — and this is masked by `2>/dev/null`).
- **Waiting without a limit is mechanically forbidden (2026-09-25).** Three cases in a row a task hung
  "Running" for hours and days already after the agent's death: `cat` without a file waited on stdin for 25 h; an `until` loop
  waited for a string Stryker does not print; `until` loops waited for `tasks/<id>.status` / `.exit`, while
  the harness writes only `<id>.output`. The hook `pre:bash:unbounded-wait` refuses an `until` loop and
  a `while` loop with `sleep` (or `while true`) if they have no limit — neither `timeout N bash -c`, nor
  a deadline on `$SECONDS` / `date +%s`, nor an iteration counter; it refuses any loop waiting for
  `.status` / `.exit`, and a bare `cat` on stdin. How to wait correctly: `run_in_background` and
  a harness notification on completion; if a loop is still needed — with a deadline (`timeout` does not exist on macOS,
  carry `$SECONDS`). A foreground-call timeout does not count as a limit: on a timeout the harness
  moves the command to the background rather than killing it.

## Related rules

- `.claude/rules/common/zone-of-write.md` — zone-hook allow paths (worktree / escape hatch).
- `.claude/rules/common/git-policy.md` — commit format, explicit `git add`, prohibitions.
- `.claude/rules/common/eslint-mcp-first.md` — lint before editing `.ts`/`.tsx`.
