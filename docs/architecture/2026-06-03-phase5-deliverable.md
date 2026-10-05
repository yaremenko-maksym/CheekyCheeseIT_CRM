# Phase 5 — Deliverable (GHA integration + rules extraction, 2026-06-03)

**Goal of the Phase 5 ECC migration:** Add a GHA additive job stub for a future ECC code-reviewer invocation + extract cross-cutting rules from `docs/agents/RULES.md` into `rules/common/<topic>.md` files (ECC pattern).

**Source of the Phase 5 scope:** `docs/architecture/2026-05-31-ecc-migration-design.md` §2.3 (GHA workflows) + §2.8 (Rules) + §4 (gaps and adaptations).

**ADR Phase 5 status — partial coverage:** Cross-harness placeholders + cross-session-orchestration skill + user-testing-tunnel skill + manifests/<agent>.yaml — **DEFERRED** to a separate future dispatch / Phase 6. See §"What remains" below.

## Hidden principle of Phase 5

> **GHA stays Cheeky-Cheese-owned.** ADR §2.3 explicit: integrate ECC invocations _inside_ existing GHA jobs (additive), not replaces. Phase 5 ships an inert stub workflow file — activation is planned for Phase 6+.

This contradicts the naive "wire up ECC code-reviewer right now" approach — we have no ANTHROPIC_API_KEY secret in the repo and no vetted Claude action wrapper. Lazy activation via an if: false gate preserves the workflow file for the future but does not run untested code in CI.

---

## Sub-task A — GHA additive job stub

### A1. File created

**Path:** `.github/workflows/ecc-code-review.yml`
**State:** disabled stub (job-level `if: false`)
**Trigger declared:** `pull_request` on `main` (`opened`, `synchronize`, `reopened`, `ready_for_review`)
**Behavior now:** the job will appear in the Actions UI as "skipped" on every PR — this is intentional

### A2. Why a stub and not a full workflow

Per ADR §2.3 + §6 Phase 5 mitigation:

> Start as informational (don't block merge), promote to blocking later.

Activating a full ECC code-reviewer invocation requires:

1. **An `ANTHROPIC_API_KEY` repository secret** — NOT configured at the time of Phase 5. The repo owner must add it via `gh secret set ANTHROPIC_API_KEY`.
2. **A vetted Claude action wrapper choice** — `anthropics/claude-code-action` exists but is not in our pinned ECC v2.0.0-rc.1. Alternative: a custom step with `gh pr diff` → a direct Claude CLI call. Decision — Phase 6+.
3. **Blocking vs informational decision** — informational is recommended for the first 2 weeks after activation.

The stub file documents all 3 prerequisites in the header + contains placeholder steps with the correct **env: + quoted expansion** pattern for PR metadata (GitHub Actions injection protection — see comments).

### A3. Existing workflows NOT touched

Check `git diff origin/main --stat -- .github/workflows/`:

```
.github/workflows/ecc-code-review.yml | 127 ++++++++++++++++++++ (new file)
```

ZERO modifications to: `ci.yml` / `e2e.yml` / `e2e-watchdog.yml` / `auto-merge-on-label.yml` / `labels-sync.yml` / `check-no-skip-hooks.yml`. ADR §2.3 hard rule respected.

### A4. Activation plan (Phase 6+)

A 5-step checklist in the header of the workflow file:

1. Verify the `ANTHROPIC_API_KEY` secret is set.
2. Replace `if: false` on the job with a real condition (e.g., `github.event.pull_request.draft == false`).
3. Fill the placeholder steps with the chosen action / CLI invocation, keeping PR metadata via `env:` only.
4. Decide post-comment (default) vs PR-review API (risks a duplicate review with the local code-reviewer).
5. Open a dedicated PR `feat(architect): activate ECC code-reviewer in CI`, run on a draft PR first, merge.

---

## Sub-task B — Rules extraction

### B1. Pattern (per ECC `rules/ecc/README.md`)

ECC organizes rules as:

```
rules/
├── common/          # Language-agnostic (always install)
├── typescript/      # Language extensions
├── web/             # Domain extensions
└── ...
```

Phase 5 covers only the `rules/common/` namespace (project-local, parallel with the reference `rules/ecc/`).

### B2. Inventory of the files being created

| File                                | Topic (source in old RULES.md)  | Lines         | Subject                                                                |
| ----------------------------------- | ------------------------------- | ------------- | ---------------------------------------------------------------------- |
| `rules/common/mcp-first.md`         | §1 Tool priority + 1.1-1.3      | 67            | MCP catalog, tool priority, mandatory MCP calls                        |
| `rules/common/git-policy.md`        | §2 Git commit hygiene + 2.1-2.3 | 68            | Forbidden patterns, commit format, WIP chunking, conventional scopes   |
| `rules/common/skills-invocation.md` | §3 Skill catalog                | 75            | Trigger → skill mapping, Phase 4 lift, anti-patterns                   |
| `rules/common/zone-of-write.md`     | §5 Zone-of-write contract       | 60            | Per-agent file permissions, enforcement, Architect notes               |
| `rules/common/version-pins.md`      | §7 Version pins                 | 61            | Node 20 / pnpm 7.32.4 / Vite ^6.4 / TanStack ^1.168 / Fastify override |
| **TOTAL new files Phase 5**         | **5 topics**                    | **331 lines** | + already existing from Phase 2.5: russian-language.md, eslint-mcp-first.md |

### B3. Sections retained inline in RULES.md (NOT extracted)

| Section                         | Reason for keeping inline                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| §4 Session recovery             | Tightly coupled to the per-agent recovery checklists. Not reusable cross-harness. Navigational.                                  |
| §6 Memory & lessons protocol    | PM Mode 2.A workflow coupling. Trigger (merged PR), priorities (P0/P1/P2), rotation — workflow primitives, not standalone rules. |
| §9 Quick reference (agent docs) | The entry point into `docs/agents/` — a navigational TOC, not a rule.                                                            |

Phase 6+ may reconsider session recovery extraction if cross-harness portability is required.

### B4. Net diff

Old RULES.md = 269 lines of inline rules.
New RULES.md = 195 lines (TOC + summary + references + inline §4/§6/§9 — navigational).
Removed: 157 lines of duplicated content (now lives in rules/common/).
Added: 86 lines (summaries + links).
**Net: -71 lines in RULES.md.** The content moved to `rules/common/*.md`.

### B5. Extraction map (old section → new file)

```
RULES.md §1   ────────────────► rules/common/mcp-first.md
   ├─ §1.1 MCP catalog
   ├─ §1.2 Native tools
   └─ §1.3 Mandatory MCP calls

RULES.md §2   ────────────────► rules/common/git-policy.md
   ├─ §2.1 Zero-tolerance
   ├─ §2.2 Commit message format
   └─ §2.3 WIP commits / chunking

RULES.md §3   ────────────────► rules/common/skills-invocation.md
   └─ Trigger → Skill mapping + Phase 4 project-local skills

RULES.md §4   ────► INLINE (Session recovery — navigational)

RULES.md §5   ────────────────► rules/common/zone-of-write.md
   └─ Per-agent zones + enforcement + Architect notes

RULES.md §6   ────► INLINE (Memory protocol — PM Mode 2.A coupling)

RULES.md §7   ────────────────► rules/common/version-pins.md
   └─ Runtime / Frontend / Backend / Infra pins + forbidden overrides

RULES.md §8   ────────────────► (already extracted Phase 2.5)
   ├─ russian-language.md
   └─ eslint-mcp-first.md

RULES.md §9   ────► INLINE (Quick reference table — TOC for docs/agents/)
```

### B6. Architect zone-of-write update

`rules/common/zone-of-write.md` adds an explicit Architect row to the matrix:

```
Architect → CAN: docs/architecture/**, docs/agents/<agent>.md (frontmatter +
            golden rules during ECC migration), rules/**, .claude/hooks-ecc/**,
            .claude/skills/**, .github/workflows/ecc-*.yml (additive)

           CANNOT: apps/**, packages/**, docs/specs/pm-state.json (LIVE),
            docs/specs/tasks/<active> (PM owns), .claude/hooks/** (legacy)
```

This formalizes what Phase 3a-4 did implicitly — now explicit in the rule.

---

## Sub-task C — What remains / was not done

### NOT covered in Phase 5 (deferred)

Per ADR §6 Phase 5 AC, the following was also planned:

- **Cross-harness placeholder directories** (`.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.zed/`) with a README. **DEFERRED** to Phase 7+ optional per ADR Q2 recommendation = A (Claude Code only).
- **`manifests/<agent>.yaml`** exports for cross-harness portability. **DEFERRED** to Phase 7+ — currently no consumer.
- **`skills/cross-session-orchestration/SKILL.md`** documenting the `scripts/pm/pm-schedule.sh` Layer 2 wakeups. **DEFERRED** — the Phase 4 viability recon would have filtered it as "needs > 3 substantive patterns" — a retrospective lift from real PM lessons is needed.
- **`skills/user-testing-tunnel/SKILL.md`** documenting `scripts/pm/prep-user-testing.sh`. **DEFERRED** for the same reason.
- **`skills/pm-mode-orchestration/SKILL.md`** documenting PM Mode 1-5. **DEFERRED** — pm.md already contains this workflow inline; lifting it into a skill requires separate analysis.

**Decision:** Phase 5 focuses on the minimum-return scope (GHA stub + rules extraction). Documentation skills remain Phase 6+ if/when lessons accumulate.

### What remains for Phase 6 (cleanup)

Per ADR §6 Phase 6 AC:

1. **Deprecate / remove `.claude/hooks/*.sh`** (legacy bash hooks — replaced by `.claude/hooks-ecc/*.sh` activated in Phase 2.5). They are currently on disk as fallback artifacts.
2. **Remove BA docs / decide placement** — `docs/agents/ba.md` either move to `docs/business/roles/ba.md` (ADR Q5 recommendation = B), or annotate "human role".
3. **Delete `.github/workflows/archive/`** — historical GHA-based agent dispatch (superseded). Already in archive/, can be removed entirely.
4. **Remove `hooks-ecc-draft.json`** or wherever the Phase 2 draft settled — verify it is not needed.
5. **Trim deprecated stubs:**
   - `docs/agents/reviewer.md` (Phase 3b shim after the code-reviewer + security-reviewer split).
   - `docs/agents/CLAUDE-reviewer.md`, `CLAUDE-pm.md`, etc. — trimmed but not deleted.
6. **`docs/agents/_legacy/`** move to `docs/architecture/2026-XX-XX-migration-archive/` (per ADR §6 Phase 6 AC).
7. **Final RULES.md polish** — after the Phase 5 extraction, the Russian language section / Other extracted rules section in §8 may become just a list of references.
8. **pm-state.json schema v2 documentation update** — add the event types `architect_phase_started`, `architect_phase_completed`, `migration_rollback_executed` (per ADR §2.6.1).
9. **Migration retrospective doc** — `docs/architecture/2026-XX-XX-ecc-migration-retrospective.md` (what worked, what would be done differently).

---

## ECC compliance check

- **ADR §2.3 GHA additive only** ✅ — no existing workflow modifications, the new file is a disabled stub.
- **ADR §2.8 rules extraction** ✅ — 5 top cross-cutting rules in `rules/common/`, RULES.md → TOC.
- **ECC `rules/ecc/README.md` pattern** ✅ — `rules/common/` namespace + future-ready for `rules/typescript/` / `rules/web/` extensions.
- **ECC AGENTS.upstream §"Workflow Surface Policy"** ✅ — skills/ canonical; rules/ for standards/conventions. Phase 5 did not touch skills/.
- **Discipline > speed (architect.md Hard rule):** Phase 5 does not activate untested CI integration — a stub + activation plan instead of production-bound code. ✅

---

## Verification — after push

Commands to check:

```bash
# 1. PR checks (the new workflow file should NOT trigger itself since if: false)
gh pr checks 94 --watch=false

# 2. Commit count (13 from 3a-4 + 4 from Phase 5 = 17)
git log origin/main..HEAD --oneline | wc -l    # expect: 17

# 3. New rules files
ls rules/common/                                  # expect: eslint-mcp-first.md, git-policy.md,
                                                  #         mcp-first.md, russian-language.md,
                                                  #         skills-invocation.md, version-pins.md,
                                                  #         zone-of-write.md

# 4. Workflow file disabled
head -10 .github/workflows/ecc-code-review.yml    # expect: header comment + DISABLED noted

# 5. RULES.md references rules/common/
head -50 docs/agents/RULES.md                     # expect: TOC + references syntax

# 6. Architect zone explicit
grep -c "Architect" rules/common/zone-of-write.md  # expect: ≥ 4 mentions

# 7. ECC code-review workflow did NOT run itself
gh run list --workflow="ECC Code Review (draft, disabled)" --limit 5
# expect: either empty or all runs marked "Skipped"
```

---

## Risk + mitigations

| Risk                                                                        | Mitigation                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GHA workflow file accidentally triggered                                    | `if: false` at the job level. The workflow is indexed (`name: ECC Code Review (draft, disabled)`) but steps do NOT run. A header comment explains this.                                                 |
| Agent prompts reference removed RULES.md sections                           | RULES.md remains the authoritative TOC; sections §4 / §6 / §9 remained inline. Extracted topics have explicit links. Existing references in agent.md files (if any) Phase 6 will check.                 |
| rules/common/ namespace collision with rules/ecc/ or future rules/typescript/ | The ECC pattern is explicit: `common/` for language-agnostic. The `rules/ecc/` reference files (upstream snapshot) live in a separate subdir. A future `rules/typescript/` overlays common per the ECC priority pattern. |
| Stub workflow security risk (untrusted PR metadata)                         | Placeholder steps demonstrate the `env:` + quoted shell expansion pattern (e.g., a `PR_NUMBER` env var). The header explicitly cites the GitHub security guide. Activation will follow the same pattern. |

---

## Files touched

**Created (new):**

- `.github/workflows/ecc-code-review.yml` (disabled stub, 127 lines)
- `rules/common/mcp-first.md`
- `rules/common/git-policy.md`
- `rules/common/skills-invocation.md`
- `rules/common/zone-of-write.md`
- `rules/common/version-pins.md`
- `docs/architecture/2026-06-03-phase5-deliverable.md` (this file)

**Modified:**

- `docs/agents/RULES.md` — refactor → TOC + references (-157 / +86 lines).

**NOT touched (per zone-of-write):**

- `apps/**`, `packages/**`, `scripts/**`, `docs/specs/pm-state.json`, `docs/specs/tasks/`
- `.github/workflows/ci.yml`, `e2e.yml`, `e2e-watchdog.yml`, `auto-merge-on-label.yml`, `labels-sync.yml`, `check-no-skip-hooks.yml`
- `.claude/hooks-ecc/*.sh` (Phase 2.5 active hooks)
- `.claude/skills/<existing>/SKILL.md` (Phase 4 skills)
- `docs/agents/<X>.md` (Phase 3a-4 already added frontmatters + tables)

---

## References

- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` §2.3 (GHA) + §2.8 (Rules) + §4 (gaps)
- Phase 4 deliverable: `docs/architecture/2026-06-03-phase4-deliverable.md` (skills lift)
- Phase 2.5 deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (hook activation + rules/common/russian-language + eslint-mcp-first)
- ECC reference: `docs/architecture/ecc-reference/RULES.upstream.md` + `rules/ecc/README.md` (common/ + lang/ pattern)
- ECC reference: `docs/architecture/ecc-reference/AGENTS.upstream.md` §"Workflow Surface Policy"
- Phase 3a-3e deliverables: `docs/architecture/2026-06-03-phase3{b,c,d,e}-deliverable.md`
- Dev-flow RCA: `docs/architecture/2026-05-23-dev-flow-rca.md` (D3 = the `ac_verified:` gate ref in git-policy.md)
