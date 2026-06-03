---
name: reviewer
description: "DEPRECATED (Phase 3b): split into code-reviewer + security-reviewer. Сохранён как redirect during PM transition к новым агентам (Phase 3c). NOT to be invoked — PM dispatches code-reviewer (default) и security-reviewer (для auth/finance/USDT путей)."
tools: Read
model: sonnet
---

# reviewer.md — DEPRECATED shim (Phase 3b ECC migration)

> **DEPRECATED 2026-06-03.** Этот файл больше **не** является активным system-промптом.

Монолитный Reviewer-агент был **split на два narrow ECC-агента** согласно ADR `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.5:

- **[`code-reviewer.md`](code-reviewer.md)** — narrow code review (TypeScript strict, ESLint, zone-of-write, write-then-post pattern, Verdict: BLOCK first-line). **Default reviewer** для любого PR. Model: `sonnet`.
- **[`security-reviewer.md`](security-reviewer.md)** — security-focused review (OWASP Top 10, npm audit, secrets detection, USDT/ETH patterns). Диспетчится **параллельно** с code-reviewer для PR трогающих `apps/api/src/{auth,finance,transactions,payouts}/**`, `packages/shared/src/schemas/{auth,finance}.ts`, USDT/контракты paths, или по `/security` запросу User. Model: `opus`.

## Почему split

Монолит совмещал code-correctness и security-deep-dive проверки — разные concerns, разные оптимальные модели (sonnet для скорости code review, opus для security depth), разные tool allowlists. ECC pattern: narrow agents с tight scope (см. ECC `AGENTS.md` "Agent-First orchestration with radical specialization").

## Что сохранено (Cheeky-specific)

Оба новых агента наследуют:

- **Verdict: BLOCK** first-line pattern (GitHub блокирует `REQUEST_CHANGES` когда owner==reviewer, `yaremenko-maksym`)
- **Write-then-post resilience** (тело review → файл в `/tmp/reviewer-output/` ДО MCP post; защита против MCP hang real incident 2026-05-23)
- **Mandatory `mcp__eslint__lint-files`** для code-reviewer перед review
- **Pre-Report Gate confidence policy** (HIGH→body, MED→warnings, LOW→summary only)
- **Russian язык вывода**
- **Session-recovery checklist** (RULES.md → project-state.md → memory/reviewer/lessons.md → /.clauderules → PR → task-файл)
- **Zone-of-write check** (`scripts/pm/**`, `docs/agents/**`, `.github/workflows/**` violations = BLOCK) — теперь в code-reviewer

## Migration timeline

- **Phase 3b (этот PR):** новые агенты созданы, reviewer.md = redirect shim (этот файл).
- **Phase 3c (следующий):** PM dispatch logic update — переход с `Agent(reviewer, ...)` на `Agent(code-reviewer, ...)` + параллельно `Agent(security-reviewer, ...)` для sensitive paths.
- **Phase 6 (cleanup):** этот shim можно удалить после того как все task-файлы / GHA references переведены.

## Reference

- [`code-reviewer.md`](code-reviewer.md) — code review system prompt
- [`security-reviewer.md`](security-reviewer.md) — security review system prompt
- [`docs/architecture/2026-05-31-ecc-migration-design.md`](../architecture/2026-05-31-ecc-migration-design.md) § 2.1.5 — ADR Reviewer split decision
- [`docs/architecture/2026-06-03-phase3b-deliverable.md`](../architecture/2026-06-03-phase3b-deliverable.md) — Phase 3b deliverable summary
- [`memory/reviewer/lessons.md`](memory/reviewer/lessons.md) — накопленные уроки (legacy общий для обоих новых агентов до Phase 4 split на skills)
