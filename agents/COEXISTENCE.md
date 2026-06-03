# Agents — Coexistence Status (Phase 1)

## Текущее состояние (после Phase 1)

В проекте сосуществуют **два набора agent prompts**:

### Active (production) — naшая система

**`docs/agents/*.md`** — 8 agent prompts работают и обслуживают daily workflow:

- `pm.md` + `CLAUDE-pm.md` + `pm-snippets.md` — orchestrator
- `ba.md` + `CLAUDE-ba.md` — human role
- `coder.md` + `CLAUDE-coder.md` — fullstack dev
- `autotest.md` — E2E test dev
- `reviewer.md` + `CLAUDE-reviewer.md` — code review
- `devops.md` + `CLAUDE-devops.md` — CI/CD
- `legal.md` + `CLAUDE-legal.md` — UA legal
- `architect.md` — migration orchestrator (текущая фаза)

Эти агенты **продолжают работать как есть**. PM продолжает dispatch их через `Agent(...)`.

### Reference (ECC catalog, доступный для invocation)

**`agents/*.md`** — 61 ECC catalog agent скопированы из ECC v2.0.0-rc.1 для:

- Format reference (YAML frontmatter pattern для Phase 3)
- Direct invocation теми custom agents которые знают про ECC sub-agents:
  - PM может invoke `planner` для декомпоза
  - Coder может invoke `tdd-guide`, `typescript-reviewer`, `database-reviewer`
  - Architect (этот файл) уже invokeит `architect` (ECC system design agent) когда design decision
- Source для Phase 3 миграции (наши project agents будут декомпозированы / интегрированы с ECC sub-agents)

## ECC catalog agents — кто что делает

Ключевые для нас (full каталог в `AGENTS.md` upstream copy):

- `planner` — implementation planning (PM may invoke)
- `architect` — system design (ECC's, не наш Migration Architect — naming overlap, не путать)
- `tdd-guide` — RED→GREEN→IMPROVE workflow
- `code-reviewer` — code quality review (Phase 3 заменит monolithic reviewer.md часть)
- `security-reviewer` — vulnerability detection (Phase 3 split с code-reviewer)
- `typescript-reviewer` — TS-specific review
- `database-reviewer` — PostgreSQL/Drizzle review
- `build-error-resolver` — build errors (DevOps invoke)
- `e2e-runner` — Playwright E2E (AutoTest invoke)
- `harness-optimizer` — Claude Code config tuning
- `loop-operator` — autonomous loop execution

## Phase 3 миграция (предстоит)

Согласно ADR Section 6 Phase 3 — 6 sub-PRs:

1. PM → port to ECC YAML frontmatter (largest, highest risk)
2. Coder → decompose + ECC sub-agent integration
3. AutoTest → port + ECC playwright skills
4. Reviewer → split into `code-reviewer` + `security-reviewer`
5. DevOps → port + ECC `build-error-resolver` integration
6. Legal → port to ECC YAML, keep custom

После Phase 3 cutover:

- `docs/agents/*.md` move to `docs/agents/_legacy/`
- New project agents live в `agents/` или в hybrid pattern (TBD)
- 1 неделя coexistence period before cleanup

## Что НЕ делать в этом файле / директории

- Не редактировать `agents/*.md` напрямую — это ECC upstream reference (read-only до Phase 3)
- Phase 3 миграция создаст НОВЫЕ project agent файлы (PM/Coder/etc.) в this directory, рядом с ECC catalog
- Daily workflow продолжает dispatch через `docs/agents/*.md` пока Phase 3 не сделает cutover

## Источники

- ADR Section 2.1 — per-agent migration decisions
- ADR Section 6 Phase 3 — full plan
- ECC catalog overview: `AGENTS.md` (project-adapted) + `docs/architecture/ecc-reference/AGENTS.upstream.md`
- Coexistence pattern из architect.md
