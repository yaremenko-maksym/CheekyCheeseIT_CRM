# Phase 5 — Deliverable (GHA integration + rules extraction, 2026-06-03)

**Цель Phase 5 ECC-migration:** Добавить GHA additive job stub для будущего ECC code-reviewer invocation + extract cross-cutting rules из `docs/agents/RULES.md` в `rules/common/<topic>.md` файлы (ECC pattern).

**Источник Phase 5 scope:** `docs/architecture/2026-05-31-ecc-migration-design.md` §2.3 (GHA workflows) + §2.8 (Rules) + §4 (gaps and adaptations).

**ADR Phase 5 status — частичное покрытие:** Cross-harness placeholders + cross-session-orchestration skill + user-testing-tunnel skill + manifests/<agent>.yaml — **DEFERRED** для отдельного будущего dispatch / Phase 6. См. §"Что осталось" ниже.

## Скрытый принцип Phase 5

> **GHA stays Cheeky-Cheese-owned.** ADR §2.3 explicit: integrate ECC invocations _inside_ existing GHA jobs (additive), not replaces. Phase 5 ships инертный stub workflow file — активация запланирована на Phase 6+.

Это противоречит naive "wire up ECC code-reviewer right now" подходу — у нас нет ANTHROPIC_API_KEY secret в repo и нет vetted Claude action wrapper. Lazy activation через if: false gate сохраняет workflow file для future, но не запускает untested code в CI.

---

## Sub-task A — GHA additive job stub

### A1. Файл создан

**Path:** `.github/workflows/ecc-code-review.yml`
**State:** disabled stub (job-level `if: false`)
**Trigger declared:** `pull_request` on `main` (`opened`, `synchronize`, `reopened`, `ready_for_review`)
**Behavior сейчас:** job появится в Actions UI как "skipped" на каждом PR — это намеренно

### A2. Зачем stub а не полноценный workflow

Per ADR §2.3 + §6 Phase 5 mitigation:

> Start as informational (don't block merge), promote to blocking later.

Активация полноценного ECC code-reviewer invocation требует:

1. **`ANTHROPIC_API_KEY` repository secret** — НЕ настроен на момент Phase 5. Repo owner должен добавить через `gh secret set ANTHROPIC_API_KEY`.
2. **Vetted Claude action wrapper choice** — `anthropics/claude-code-action` существует но не в нашем pinned ECC v2.0.0-rc.1. Альтернатива: custom step с `gh pr diff` → Claude CLI direct call. Решение — Phase 6+.
3. **Blocking vs informational решение** — recommended informational первые 2 недели после активации.

Stub-файл документирует все 3 prerequisites в header + содержит placeholder steps с правильным **env: + quoted expansion** паттерном для PR metadata (GitHub Actions injection protection — см. comments).

### A3. Existing workflows НЕ touched

Проверка `git diff origin/main --stat -- .github/workflows/`:

```
.github/workflows/ecc-code-review.yml | 127 ++++++++++++++++++++ (new file)
```

ZERO modifications к: `ci.yml` / `e2e.yml` / `e2e-watchdog.yml` / `auto-merge-on-label.yml` / `labels-sync.yml` / `check-no-skip-hooks.yml`. ADR §2.3 hard rule respected.

### A4. Activation plan (Phase 6+)

5-шаговый checklist в header workflow файла:

1. Verify `ANTHROPIC_API_KEY` secret is set.
2. Replace `if: false` на job с реальным условием (e.g., `github.event.pull_request.draft == false`).
3. Fill placeholder steps с chosen action / CLI invocation, keeping PR metadata через `env:` only.
4. Decide post-comment (default) vs PR-review API (рискует duplicate review с local code-reviewer).
5. Open dedicated PR `feat(architect): activate ECC code-reviewer in CI`, run on draft PR first, merge.

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

Phase 5 покрывает только `rules/common/` namespace (project-local, parallel с reference `rules/ecc/`).

### B2. Inventory создаваемых файлов

| File                                | Топик (источник в old RULES.md) | Lines         | Subject                                                                |
| ----------------------------------- | ------------------------------- | ------------- | ---------------------------------------------------------------------- |
| `rules/common/mcp-first.md`         | §1 Tool priority + 1.1-1.3      | 67            | MCP catalog, tool priority, mandatory MCP calls                        |
| `rules/common/git-policy.md`        | §2 Git commit hygiene + 2.1-2.3 | 68            | Forbidden patterns, commit format, WIP chunking, conventional scopes   |
| `rules/common/skills-invocation.md` | §3 Skill catalog                | 75            | Trigger → skill mapping, Phase 4 lift, anti-patterns                   |
| `rules/common/zone-of-write.md`     | §5 Zone-of-write contract       | 60            | Per-agent file permissions, enforcement, Architect notes               |
| `rules/common/version-pins.md`      | §7 Version pins                 | 61            | Node 20 / pnpm 7.32.4 / Vite ^6.4 / TanStack ^1.168 / Fastify override |
| **TOTAL new files Phase 5**         | **5 топиков**                   | **331 lines** | + Phase 2.5 уже existing: russian-language.md, eslint-mcp-first.md     |

### B3. Sections retained inline в RULES.md (НЕ extracted)

| Section                         | Reason for keeping inline                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| §4 Session recovery             | Tightly coupled к per-agent recovery checklists. Не reusable cross-harness. Навигационный.                                       |
| §6 Memory & lessons protocol    | PM Mode 2.A workflow coupling. Trigger (merged PR), priorities (P0/P1/P2), rotation — workflow primitives, not standalone rules. |
| §9 Quick reference (agent docs) | Точка входа в `docs/agents/` — навигационный TOC, не правило.                                                                    |

Phase 6+ может пересмотреть session recovery extraction если cross-harness portability потребуется.

### B4. Net diff

Старая RULES.md = 269 строк inline rules.
Новая RULES.md = 195 строк (TOC + summary + references + inline §4/§6/§9 — навигационные).
Удалено: 157 строк дублирующегося контента (теперь живёт в rules/common/).
Добавлено: 86 строк (summaries + ссылки).
**Net: -71 строк в RULES.md.** Контент переехал в `rules/common/*.md`.

### B5. Extraction map (старая секция → новый файл)

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

RULES.md §4   ────► INLINE (Session recovery — навигационный)

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

`rules/common/zone-of-write.md` добавляет explicit Architect row в матрицу:

```
Architect → CAN: docs/architecture/**, docs/agents/<agent>.md (frontmatter +
            golden rules при ECC migration), rules/**, .claude/hooks-ecc/**,
            .claude/skills/**, .github/workflows/ecc-*.yml (additive)

           CANNOT: apps/**, packages/**, docs/specs/pm-state.json (LIVE),
            docs/specs/tasks/<active> (PM owns), .claude/hooks/** (legacy)
```

Это формализует то что Phase 3a-4 имплицитно делали — теперь explicit в правиле.

---

## Sub-task C — Что осталось / не сделано

### НЕ покрыто в Phase 5 (deferred)

Per ADR §6 Phase 5 AC, ещё намечалось:

- **Cross-harness placeholder directories** (`.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.zed/`) с README. **DEFERRED** в Phase 7+ optional per ADR Q2 recommendation = A (Claude Code only).
- **`manifests/<agent>.yaml`** exports для cross-harness portability. **DEFERRED** в Phase 7+ — currently no consumer.
- **`skills/cross-session-orchestration/SKILL.md`** документирующий `scripts/pm/pm-schedule.sh` Layer 2 wakeups. **DEFERRED** — Phase 4 viability recon отфильтровала бы как "needs > 3 substantive patterns" — нужен retrospective lift из реальных PM lessons.
- **`skills/user-testing-tunnel/SKILL.md`** документирующий `scripts/pm/prep-user-testing.sh`. **DEFERRED** по той же причине.
- **`skills/pm-mode-orchestration/SKILL.md`** documenting PM Mode 1-5. **DEFERRED** — pm.md уже содержит этот workflow inline; lift в skill требует separate analysis.

**Решение:** Phase 5 фокусируется на минимально-возвратном scope (GHA stub + rules extraction). Documentation skills остаются Phase 6+ if/when lessons accumulate.

### Что остаётся для Phase 6 (cleanup)

Per ADR §6 Phase 6 AC:

1. **Deprecate / удалить `.claude/hooks/*.sh`** (legacy bash hooks — replaced by `.claude/hooks-ecc/*.sh` activated in Phase 2.5). Сейчас они на диске как fallback artifacts.
2. **Remove BA docs / decide placement** — `docs/agents/ba.md` либо move в `docs/business/roles/ba.md` (ADR Q5 recommendation = B), либо annotate "human role".
3. **Delete `.github/workflows/archive/`** — historical GHA-based agent dispatch (superseded). Уже в archive/, можно удалить полностью.
4. **Удалить `hooks-ecc-draft.json`** или wherever Phase 2 draft осел — verify не нужен.
5. **Trim deprecated stubs:**
   - `docs/agents/reviewer.md` (Phase 3b shim после code-reviewer + security-reviewer split).
   - `docs/agents/CLAUDE-reviewer.md`, `CLAUDE-pm.md`, etc. — trimmed но не deleted.
6. **`docs/agents/_legacy/`** move в `docs/architecture/2026-XX-XX-migration-archive/` (per ADR §6 Phase 6 AC).
7. **Final RULES.md polish** — после Phase 5 extraction Russian language section / Other extracted rules section в §8 может стать просто references списком.
8. **pm-state.json schema v2 documentation update** — добавить event types `architect_phase_started`, `architect_phase_completed`, `migration_rollback_executed` (per ADR §2.6.1).
9. **Migration retrospective doc** — `docs/architecture/2026-XX-XX-ecc-migration-retrospective.md` (what worked, what would do differently).

---

## ECC compliance check

- **ADR §2.3 GHA additive only** ✅ — никаких existing workflow modifications, новый файл disabled stub.
- **ADR §2.8 rules extraction** ✅ — 5 top cross-cutting rules в `rules/common/`, RULES.md → TOC.
- **ECC `rules/ecc/README.md` pattern** ✅ — `rules/common/` namespace + future-ready для `rules/typescript/` / `rules/web/` extensions.
- **ECC AGENTS.upstream §"Workflow Surface Policy"** ✅ — skills/ canonical; rules/ для standards/conventions. Phase 5 не trogаел skills/.
- **Discipline > speed (architect.md Hard rule):** Phase 5 не активирует untested CI integration — stub + activation plan вместо production-bound code. ✅

---

## Verification — после push

Commands для проверки:

```bash
# 1. PR checks (новый workflow file НЕ должен сам triggered т.к. if: false)
gh pr checks 94 --watch=false

# 2. Commit count (13 от 3a-4 + 4 от Phase 5 = 17)
git log origin/main..HEAD --oneline | wc -l    # expect: 17

# 3. Новые rules files
ls rules/common/                                  # expect: eslint-mcp-first.md, git-policy.md,
                                                  #         mcp-first.md, russian-language.md,
                                                  #         skills-invocation.md, version-pins.md,
                                                  #         zone-of-write.md

# 4. Workflow file disabled
head -10 .github/workflows/ecc-code-review.yml    # expect: header comment + DISABLED noted

# 5. RULES.md ссылается на rules/common/
head -50 docs/agents/RULES.md                     # expect: TOC + references syntax

# 6. Architect zone explicit
grep -c "Architect" rules/common/zone-of-write.md  # expect: ≥ 4 mentions

# 7. ECC code-review workflow НЕ запустился сам
gh run list --workflow="ECC Code Review (draft, disabled)" --limit 5
# expect: либо empty либо все runs marked "Skipped"
```

---

## Risk + mitigations

| Risk                                                                        | Mitigation                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GHA workflow file случайно triggered                                        | `if: false` на job level. Workflow indexed (`name: ECC Code Review (draft, disabled)`) но steps НЕ run. Header comment объясняет это.                                                                  |
| Agent prompts ссылаются на removed RULES.md sections                        | RULES.md остаётся authoritative TOC; sections §4 / §6 / §9 остались inline. Extracted topics имеют explicit ссылки. Existing references в agent.md files (если есть) Phase 6 проверит.                 |
| rules/common/ namespace collision с rules/ecc/ или future rules/typescript/ | ECC pattern explicit: `common/` для language-agnostic. `rules/ecc/` reference files (upstream snapshot) живёт в отдельном subdir. Future `rules/typescript/` overlays common per ECC priority pattern. |
| Stub workflow security risk (untrusted PR metadata)                         | Placeholder steps demonstrate `env:` + quoted shell expansion pattern (e.g., `PR_NUMBER` env var). Header explicit cites GitHub security guide. Activation will follow same pattern.                   |

---

## Файлы touched

**Created (новые):**

- `.github/workflows/ecc-code-review.yml` (disabled stub, 127 lines)
- `rules/common/mcp-first.md`
- `rules/common/git-policy.md`
- `rules/common/skills-invocation.md`
- `rules/common/zone-of-write.md`
- `rules/common/version-pins.md`
- `docs/architecture/2026-06-03-phase5-deliverable.md` (этот файл)

**Modified:**

- `docs/agents/RULES.md` — рефакторинг → TOC + references (-157 / +86 lines).

**NOT touched (per zone-of-write):**

- `apps/**`, `packages/**`, `scripts/**`, `docs/specs/pm-state.json`, `docs/specs/tasks/`
- `.github/workflows/ci.yml`, `e2e.yml`, `e2e-watchdog.yml`, `auto-merge-on-label.yml`, `labels-sync.yml`, `check-no-skip-hooks.yml`
- `.claude/hooks-ecc/*.sh` (Phase 2.5 active hooks)
- `.claude/skills/<existing>/SKILL.md` (Phase 4 skills)
- `docs/agents/<X>.md` (Phase 3a-4 уже добавили frontmatters + tables)

---

## References

- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` §2.3 (GHA) + §2.8 (Rules) + §4 (gaps)
- Phase 4 deliverable: `docs/architecture/2026-06-03-phase4-deliverable.md` (skills lift)
- Phase 2.5 deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (hook activation + rules/common/russian-language + eslint-mcp-first)
- ECC reference: `docs/architecture/ecc-reference/RULES.upstream.md` + `rules/ecc/README.md` (common/ + lang/ pattern)
- ECC reference: `docs/architecture/ecc-reference/AGENTS.upstream.md` §"Workflow Surface Policy"
- Phase 3a-3e deliverables: `docs/architecture/2026-06-03-phase3{b,c,d,e}-deliverable.md`
- Dev-flow RCA: `docs/architecture/2026-05-23-dev-flow-rca.md` (D3 = `ac_verified:` gate ref в git-policy.md)
