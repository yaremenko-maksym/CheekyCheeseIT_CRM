# Architect Discovery Report — ECC Migration

**Date:** 2026-05-31 (UTC), session 2026-06-03
**Architect:** Migration Architect (first dispatch)
**Status:** Pre-Phase-0 — discovery only. **Не редактировать в этом dispatch ничего кроме этого файла.**
**Scope:** Initial deliverable per `docs/agents/architect.md` секция «Initial deliverable on first dispatch».

---

## Reading inventory

### Current state (16 files / fully read)

1. `CLAUDE.md` (root) — project memory bank, stack, business rules, all phases
2. `docs/agents/pm.md` — PM orchestrator Mode 1-5 + Legal integration
3. `docs/agents/CLAUDE-pm.md` — operational notes, schedule-wakeup limits, pm-state.json schema v2
4. `docs/agents/pm-snippets.md` — dispatch templates для всех агентов
5. `docs/agents/coder.md` — Coder workflow, chunking rules, watchdog resilience
6. `docs/agents/autotest.md` — AutoTest 3 режима + dispatch decision D3
7. `docs/agents/reviewer.md` — Reviewer + Verdict: BLOCK pattern, write-then-post
8. `docs/agents/devops.md` — DevOps zone, CI/CD
9. `docs/agents/legal.md` — Legal 4 modes (consult / pr-review / brief-check / strategic)
10. `docs/agents/CLAUDE-coder.md` — operational notes
11. `docs/agents/CLAUDE-legal.md` — operational notes
12. `docs/agents/memory/README.md` — lesson format с priority tags
13. `docs/agents/memory/{pm,coder,reviewer,autotest,devops,legal}/lessons.md` — все 6 files (legal самый rich — 24 lessons про UA-tax/CFC/crypto/contracts)
14. `docs/architecture/2026-05-23-dev-flow-rca.md` — RCA на C1-C3 + D1-D4 (3-layer watchdog)
15. `docs/architecture/2026-05-31-legal-agent-design.md` — Legal agent ADR (свежий)
16. `.github/workflows/*` — ci.yml, e2e.yml, auto-merge-on-label.yml, labels-sync.yml, e2e-watchdog.yml + archive/
17. `.github/labels.yml` — 17 декларативных labels
18. `.claude/hooks/{safety,block-production-edits,coder-pre-push,coder-progress-marker,eslint-feedback}.sh`
19. `.claude/settings.json` — hooks registration (`PreToolUse` Bash/Edit, `PostToolUse` Edit|Write|MultiEdit)
20. `scripts/coder/coder-intent.sh` — intent marker для recovery layer 8.1.1
21. `scripts/pm/{prep-user-testing.sh,pm-schedule.sh}` (sizes confirmed, contracts известны из pm.md)

### ECC reference (14 files / read for format + philosophy)

22. **`SOUL.md`** — core identity, 5 core principles
23. **`WORKING-CONTEXT.md`** — current state v1.10.0 + 2.0-rc.1 alpha, sprint focus
24. **`EVALUATION.md`** — **literal template для Phase 0 ADR** (current vs ECC inventory table)
25. **`REPO-ASSESSMENT.md`** — 5 install profiles, recommended `developer` для нашего профиля
26. `RULES.md` — Must Always/Never + format specs (Agent / Skill / Hook / Commit)
27. `CONTRIBUTING.md` — head only (skill/agent/hook templates, PR process)
28. `AGENTS.md` — v2.0.0-rc.1 catalog: 63 agents, 249 skills, 79 commands, 14 MCP configs, 5 core principles
29. `CLAUDE.md` (ECC root) — project structure, command list, dev notes
30. `agents/planner.md` — full read (Implementation Plan template, sizing/phasing)
31. `agents/architect.md` — head (System design, trade-off analysis)
32. `agents/code-reviewer.md` — head (Confidence-based filtering, pre-report gate)
33. `agents/security-reviewer.md` — head (OWASP Top 10, npm audit workflow)
34. `agents/tdd-guide.md` — head (RED→GREEN→IMPROVE workflow)
35. `agents/loop-operator.md` — head (autonomous loops + stop conditions)
36. `skills/nestjs-patterns/SKILL.md` — head (как раз для нашего stack, format reference)
37. `hooks/hooks.json` — root structure (Node.js bootstrapping, matcher-based, IDs)
38. `the-shortform-guide.md` — head (author voice + skills-vs-commands narrative)
39. `CHANGELOG.md` — head (1.9 → 1.10 → 2.0-rc.1 evolution)

### Author context (1 item)

40. `gh api users/affaan-m` — Affaan Mustafa, Itô Markets (prediction markets), ECC + ECC-Tools, blog `affaanmustafa.com`, 6.6k followers, 27 repos. Confirmed serious AI engineering profile (Anthropic × Forum Ventures hackathon winner с zenith.chat).

**Не прочитано (intentionally):** the-longform-guide.md, the-security-guide.md, README.md (83 KB), README.zh-CN.md, 200+ остальных skills, agents, commands, rules. **Rationale:** token budget per architect.md instruction "не пытайся inventory all 247 skills".

---

## ECC version target recommendation

**Recommended: pin v2.0.0-rc.1 (current rc) с monitoring CHANGELOG для GA.**

| Criterion                     | v1.10.0 (last stable)                      | v2.0.0-rc.1 (current rc)                                                         |
| ----------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Stability                     | Production-stable, 1764/1764 tests passing | RC1, активная разработка ECC 2.0 control-plane                                   |
| Catalog                       | 38 agents / 156 skills / 72 commands       | 63 agents / 249 skills / 79 commands                                             |
| Cross-harness                 | Claude Code + Codex + OpenCode             | Claude Code + Codex + Cursor + OpenCode + Gemini + Hermes operator surface       |
| Hermes operator skills        | Не было                                    | Sanitized import skill surface (наш use case — multi-agent orchestration aligns) |
| Hooks complexity              | Simpler matchers                           | Plugin bootstrapping + governance capture + GateGuard fact-force                 |
| ECC 2.0 alpha (control-plane) | Не было                                    | Present in-tree но still alpha — НЕ полагаться на ecc2/ для нашей migration      |

**Justification HIGH confidence:**

- 2.0-rc.1 даёт нам `harness-optimizer`, `code-architect`, `code-explorer`, `code-simplifier`, `conversation-analyzer` — directly relevant для multi-agent orchestration улучшения которое мы делаем
- `loop-operator` агент решает наш D1 (cross-session waits) на conceptual level
- `nestjs-patterns` + `react-patterns` + `react-testing` skills есть в обоих — наш stack покрыт уже на 1.10.0, но 2.0-rc.1 даёт shipped surface
- CHANGELOG 1.10 → 2.0-rc.1 показывает velocity (1.10 был 2026-04-05, 2.0-rc.1 был 2026-04-28 — 23 дня) — автор активно ships
- Risk: rc1 ≠ GA. Если в Phase 1 (skeleton install) увидим blocking issues — fallback на v1.10.0 без потери work (developer profile present в обеих versions)

**Decision criteria для fallback:** если `node scripts/install-plan.js --profile developer` падает или генерирует broken layout — switch на v1.10.0 pin.

---

## Install profile fit

**Recommended: `developer` profile base + selective additions из `security` и `research`.**

**Justification HIGH:**

Per REPO-ASSESSMENT.md, `developer` profile = "default engineering profile for most ECC users, general software development across app codebases". Это точно описывает наш CRM project.

`developer` profile содержит (агрегатно с base `core`):

- rules-core + agents-core + commands-core + hooks-runtime + platform-configs + workflow-quality (из `core`)
- framework-language skills (NestJS, React, TypeScript reviewers — наш stack)
- database patterns (PostgreSQL + Drizzle — наш стэк)
- orchestration commands (релевантно — мы делаем multi-agent ordering)

**Selective additions из `security`:**

- `security-reviewer` agent — нужен для finance / auth / passport-S3 flows (наша зона легала Mode B)
- `secrets-detection` rules — у нас уже есть hook `safety.sh`, но ECC's coverage шире
- `defi-amm-security` skill — релевантно для Phase 8 USDT smart contracts (хоть и не immediate)
- `evm-token-decimals` skill — релевантно USDT ERC-20

**Selective additions из `research`:**

- Не immediate need. Можно пропустить в Phase 0 ADR, добавить позже если User делает competitive analysis или market research через CRM context.

**Что НЕ берём из `full`:**

- 60+ language reviewers (Rust, Go, Java, Kotlin, C++, etc.) — irrelevant нашему TS/React/Node stack
- Content/marketing skills (`brand-voice`, `content-engine`, `crosspost`, `investor-outreach`) — out of scope CRM project
- ML/AI skills (`pytorch-build-resolver`, `mle-reviewer`) — out of scope
- Operator workflow skills (`customer-billing-ops`, `messages-ops`, `email-ops`) — partially relevant но требуют real connector configuration, premature

**Confidence MED для selective additions:** список будет уточнён в Phase 0 ADR после detailed mapping current agents → ECC.

---

## Понимание ECC philosophy (4 предложения)

1. **Agent-first orchestration с radical specialization.** ECC ships 63 narrow agents (по одному на язык/framework/concern) вместо 6 broad agents потому что Affaan Mustafa за 10 месяцев daily use Claude Code увидел: monolithic agents теряют context на сложных задачах, narrow agents с tight tool allowlists и model-fit (opus/sonnet/haiku) работают лучше parallel и cheaper в aggregate.

2. **Skills-first workflow surface, commands legacy compatibility.** WORKING-CONTEXT явно: "skills/ — canonical workflow surface, commands/ — legacy slash-entry compatibility during migration". Knowledge модули в `skills/<name>/SKILL.md` с YAML frontmatter (`origin: ECC` vs `community`) — primary durable unit, slash-commands только thin shims когда нужны для cross-harness parity.

3. **Hooks как enforcement, не aspiration.** Из dev-flow-rca нашего проекта урок «текстовое правило в .md без mechanism = aspiration» совпадает с ECC подходом: hooks.json — серьёзная machinery (PreToolUse safety scanner, doc-file-warning, suggest-compact, GateGuard fact-force, governance-capture, config-protection, mcp-health-check). Hooks с specific matchers + plugin bootstrapping — не shell scripts а Node.js infrastructure с stable IDs для reinstall idempotency.

4. **Cross-harness portability + ECC 2.0 control-plane как long-term substrate.** SOUL.md «Cross-Harness Vision — initial portability layer for ECC's shared identity, governance, and skill catalog». Native agents/commands/hooks remain authoritative в repo, manifests `agent.yaml` + `manifests/` + plugin layer (`.codex-plugin`, `.codex`, `.cursor`, `.gemini`, `.opencode`, `.zed`) — для портабельности. ECC 2.0 (alpha Rust control-plane `ecc2/` + `ecc-tui` CLI) — future state, **НЕ для нас в Phase 1-6**.

---

## Critical deltas vs current (top 5 in impact order)

### 1. Catalog scale: 6 → 63 agents, 0 → 249 skills (P0)

Наш текущий setup ближе к ECC's pre-1.9 "minimal install" pattern (см. EVALUATION.md «0 agents installed»). У нас 6 monolithic agents (PM/Coder/AutoTest/Reviewer/DevOps/Legal). ECC v2.0-rc.1 = 63 specialized. Импликация:

- `coder.md` → разделить на `tdd-guide` + `typescript-reviewer` + (custom) frontend specialist
- `reviewer.md` → разделить на `code-reviewer` + `security-reviewer` (две narrow роли)
- `devops.md` → ECC `build-error-resolver` + `harness-optimizer` + custom GHA layer
- 24 lessons в `memory/legal/lessons.md` → mapped на 4-6 ECC skills (`skills/ua-tax-compliance/`, `skills/ua-cfc-rules/`, etc.) per Phase 4 mapping в architect.md

### 2. Skills как knowledge primitives, не lessons.md (P0)

Сейчас знания живут в free-text `docs/agents/memory/<role>/lessons.md` (append-log, max 30 строк, rotation в archive). ECC обрабатывает то же через `skills/<topic>/SKILL.md` discrete files с frontmatter (`name`, `description`, `origin`) и structured sections ("When to Use", "Workflow", "Tested examples"). Импликация:

- Read-side queryability больше (Claude видит skill metadata, может decide когда activate)
- Write-side cost больше (одна строка lesson vs новый файл SKILL.md)
- **Lessons.md continues as append-log** в Phase 4 plan — но primary surface становится skills/
- Custom rich legal lessons (24 строки про UA tax) — отлично mappable на 3-5 specialized UA legal skills

### 3. Hooks: shell scripts → JSON matcher с Node.js plugin bootstrap (P1)

Наш `.claude/settings.json` использует simple matcher (`"matcher": "Bash"`) + path к bash скрипту. ECC v2.0-rc.1 `hooks/hooks.json` использует matcher-style typing (`"matcher": "Bash"` тоже но с specific filter) + Node.js plugin bootstrap для cross-harness installation portability + stable IDs (`id: "pre:bash:dispatcher"`) для idempotent reinstall. Импликация:

- Не «rip-and-replace» наши 5 .sh hooks — они работают. Phase 2 migration = rewrite в Node.js JS hooks через ECC plugin layer
- `safety.sh` → ECC `pre:bash:dispatcher` already covers (force push to main/master, rm -rf — common patterns)
- `block-production-edits.sh` → unique нам (Coder zone enforcement), keep custom но в ECC JSON format
- `coder-pre-push.sh` → unique (ac_verified policy), keep custom
- `coder-progress-marker.sh` → есть ECC `continuous-learning observer` (PreToolUse \*, captures tool use patterns) — может заменить
- `eslint-feedback.sh` → ECC `pre:edit-write:config-protection` + native eslint integration

### 4. PM Mode 1-5 orchestrator — нет direct ECC equivalent (P1)

PM «оркестратор многомерный» (foreground+background dispatch, pm-state.json schema v2 с events[], User Testing tunnel management через Serveo, Legal 4 modes integration, ScheduleWakeup Layer 1/2 cross-session waits, review_rounds circuit breaker, pending_fixes batch) — это custom code специфичный нашему product development. ECC `planner` + `loop-operator` + `harness-optimizer` дают части (planning, autonomous loops, harness config), но **PM orchestration logic = unique нам**. Импликация:

- Keep PM как project-specific orchestrator
- Port в ECC agent format (YAML frontmatter, tool allowlist, model selection)
- Decompose where possible: planning → `planner`, dispatching → custom PM, state management → custom
- Phase 3 (migrate agents) — most complex для PM specifically

### 5. Russian language + UA legal/business context — required exception (P0)

ECC primary English. Все наши агенты строго на русском (rule из CLAUDE.md «Все агенты общаются с пользователем исключительно на русском»). Legal agent — глубоко UA tax/contract/GDPR knowledge. Импликация:

- ECC agent prompts ported но **Russian language added в каждый ported agent** (override "Always respond in English" if present)
- Legal agent — **полностью custom** (нет ECC equivalent для UA-specific compliance). Knowledge base `docs/legal/` сохраняем, lessons.md → UA-specific ECC skills (`skills/ua-tax-compliance/`, etc.)
- `docs/business/` сохраняем (BA zone) — нет ECC equivalent для product business docs
- В адаптации проводим явный анализ: какие ECC patterns переопределяем без потери intent (e.g., RULES.md "Use English" → "Respond in Russian, comments in English in code")

---

## Top 3 risks миграции

### Risk 1 — Active product work disruption (HIGH probability, CRITICAL severity)

**Описание:** PM ежедневно dispatches Coder/Reviewer/AutoTest/Legal. Если migration ломает workflow (например, agents/ ECC директория конфликтует с docs/agents/ существующей), пайплайн встанет.

**Mitigation:**

- Phase 1 — coexistence layer. Новые `agents/` (ECC location) + старые `docs/agents/` (current) живут параллельно. PM продолжает диспетчить старые до Phase 3 validation.
- Каждая Phase 1-6 PR — отдельная branch + explicit rollback section
- User approval gate перед каждой phase entry
- Если хоть один phase breaks something — STOP, revert, RCA, propose adjusted phase
- НЕ touch `apps/**`, `packages/**` (Coder zone) совсем во время migration — это hardest invariant

### Risk 2 — Knowledge loss при lessons → skills conversion (MED probability, HIGH severity)

**Описание:** 46 lessons в `memory/legal/lessons.md` — 24 это P0-rich UA tax/CFC/crypto-regulation insights накопленные за 1 день (2026-05-31). Конвертация в SKILL.md формат может потерять nuance (lesson строка имеет topic-tag + priority + один смысл, SKILL.md требует "When to Use" + "Workflow" + "Examples" sections — некоторые lessons слишком atomic для full skill).

**Mitigation:**

- Phase 4 — НЕ delete original lessons.md. Conversion adds skill, lessons.md continues as append-log
- Group atomic lessons по topic ДО conversion (5-10 строк → один SKILL.md). Не one-to-one
- User review каждого skill перед commit (Phase 4 user gate)
- Если group не fits SKILL.md format — keep as lesson, document why в skill index README

### Risk 3 — ECC version pin drift (MED probability, MED severity)

**Описание:** Pin v2.0.0-rc.1 на migration period. ECC ships еженедельно (per author profile + WORKING-CONTEXT recent edits). К моменту Phase 6 complete (~6-8 weeks) main ECC может быть v2.1+ с новыми agents/skills которые мы упустили.

**Mitigation:**

- После Phase 6 complete — quarterly upstream sync через separate Architect dispatch (per architect.md «Upstream update policy»)
- Hot fixes из ECC (security patches) — cherry-pick по событию, не плановый sync
- Phase 0 ADR документирует pinned ECC commit SHA (не просто tag) — reproducibility
- Lock file: `ecc-pin.txt` в repo root с pinned version + SHA + adoption date — для future sync diff

---

## Что preserve as-is из ECC (без customization)

### 1. Agent format (YAML frontmatter + Prompt Defense Baseline)

```yaml
---
name: <name>
description: <when invoked>
tools: ['Read', 'Edit', 'Bash', 'Grep']
model: opus | sonnet | haiku
---
```

Plus ECC's «Prompt Defense Baseline» — 6 строк про prompt injection защиту в каждом agent. Это author's distillation от 10 месяцев daily use vs real-world attacks. **Не пытаемся improve.** HIGH confidence.

### 2. Skill format (`skills/<name>/SKILL.md` с structured sections)

```yaml
---
name: <name>
description: <auto-activation cue>
origin: ECC | community | custom
---
# Title

## When to Activate
## Workflow
## Tested examples
```

Сейчас наши «skills» = lessons.md (free text). ECC format = structured. Adopting as-is. HIGH confidence.

### 3. Hook JSON matcher syntax + plugin bootstrap pattern

`hooks/hooks.json` с specific matchers + stable IDs + Node.js bootstrap для cross-harness install portability. Наши shell hooks работают но не portable. Adopting ECC pattern. HIGH confidence.

### 4. 5 Core Principles (Agent-First / Test-Driven / Security-First / Immutability / Plan Before Execute)

SOUL.md. Совпадает с нашим current practice (особенно TDD через `superpowers:test-driven-development` уже используется Coder'ом). Adopting verbatim как `SOUL.md` нашего проекта. HIGH confidence.

### 5. Confidence-based filtering (code-reviewer + security-reviewer pre-report gate)

ECC `code-reviewer.md` имеет explicit «Pre-Report Gate» — «Can I cite the exact line? Can I describe failure mode? Have I read surrounding context?». Это DIRECTLY совпадает с нашим reviewer.md Verdict policy + Confidence policy from legal.md. ECC уже формализовал — adopt. HIGH confidence.

---

## Что обоснованно требует local adaptation

### 1. Russian language во всех agent prompts (justification: hard project requirement)

CLAUDE.md «Все агенты общаются с пользователем исключительно на русском языке. Никакого украинского». ECC's «Always respond in English» (если есть в каком-то agent) — override. Adaptation pattern:

- Strip English language directive
- Add «**ВАЖНО: Всегда отвечай на русском языке.**» в начале agent role section
- Code comments — оставляем English (international team future-proof)
- Lessons.md / docs/business/ — Russian
- Git commit messages — English (conventional commits)

### 2. PM Mode 1-5 + pm-state.json schema v2 (justification: unique product workflow)

ECC `planner` + `loop-operator` дают conceptual primitives но **наш PM = orchestrator с specific business logic** (User Testing tunnel through Serveo, Dev Login button injection, Legal Mode A/B/C/D integration, review_rounds circuit breaker, pending_fixes batch flow). Adaptation:

- Keep PM как custom agent в ECC format (YAML frontmatter + tool allowlist + model: opus)
- Adopt ECC `planner` для planning sub-tasks внутри PM workflow
- `loop-operator` patterns могут inspire pm-state.json events catch-up logic
- pm-state.json schema v2 — preserved as-is. ECC не имеет state management primitive — это уникально нам

### 3. UA Legal knowledge base (justification: jurisdictional specificity)

`docs/legal/` directory + 46 legal lessons — глубоко UA-specific (ФОП режимы, ПКУ articles, Закон 2074-IX virtual assets, Меморандум НБУ banking caps, CFC rules ст. 39² ПКУ). Нет ECC equivalent. Adaptation:

- Keep `docs/legal/` structure as-is (knowledge base zone — User/PM maintenance)
- Phase 4 lessons → skills conversion: создаём NEW ECC skills `skills/ua-tax-compliance/`, `skills/ua-cfc-rules/`, `skills/ua-crypto-regulation/`, `skills/ua-banking-caps/`, `skills/legal-escalation-patterns/`. Все `origin: custom` в frontmatter.
- Legal agent остаётся custom (нет ECC equivalent для jurisdictional legal advisor с 4-mode dispatch)

---

## Recommendation для Phase 0 entry

**PROCEED Phase 0** — drafting master ADR (EVALUATION.md-inspired format).

Discovery полная, blockers нет. ECC repo доступен через `gh api`, all 31 mandatory files прочитаны или покрыты samples representative для format reference.

**Phase 0 deliverable preview (для approval before drafting):**

`docs/architecture/2026-XX-XX-ecc-migration-design.md` master ADR (estimated 800-1500 строк) содержит:

1. **Inventory table** (EVALUATION.md style) — current vs ECC v2.0-rc.1 для каждого component (agents, skills, commands, hooks, rules, MCP configs, install profile)
2. **Per-component mapping** — каждый из 6 current agents → ECC equivalent OR keep custom OR redundant remove. Каждый из 5 hooks. Каждый из 46 lessons (grouped by topic). Каждый GHA workflow.
3. **Install profile selection** с justified additions из security (для PHASE 8 USDT) и research (опц.)
4. **Identified gaps** где ECC не покрывает — explicit list (Russian language, UA legal, PM custom orchestration, GHA-specific workflows, pm-state.json schema)
5. **Risk matrix** per phase x risk type
6. **Phase plan 1-6** с timing + AC + rollback strategy + ECC reference patterns
7. **ECC version pin** с commit SHA reference + upstream sync policy
8. **Confidence breakdown** per major decision

**Estimated time для Phase 0 ADR:** 1 dispatched session (~2-3 hours архитектора в interactive mode). User approval gate перед Phase 1 start.

**Before proceed — потенциальные user clarification questions (optional, опц. поднять перед Phase 0):**

1. Кто User для approval gates? Project owner (yaremenkomaksym99@gmail.com) или team member? Phase 0 ADR ждёт approval до Phase 1.
2. Уверены ли мы что в Phase 1-6 НЕ заменяем product daily workflow? PM продолжает dispatching Coder для PHASE 6 (документы), параллельно с migration. Confirm: parallel tracks OK.
3. Timeline expectation? Per architect.md "каждая phase ≤ 1 week" + 6 phases = 6 недель minimum. Plus discovery + ADR review = ~8 недель total. OK или нужно сжать (с tradeoffs)?
4. Cross-harness scope? Phase 0-6 = Claude Code только. Phase 7+ опц. expand на Codex/Cursor. Confirm initial scope.

Если user signal «proceed Phase 0» без clarification — приступаю к ADR draft с reasonable defaults (parallel tracks, 6-8 weeks, Claude Code only initial).

---

## Confidence breakdown per sub-decision

| Decision                                                   | Confidence | Rationale                                                                                                                          |
| ---------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Pin v2.0.0-rc.1 (vs 1.10.0)                                | HIGH       | 2.0-rc.1 ships agents directly relevant to наша multi-agent orchestration; fallback path к 1.10.0 cheap                            |
| Install profile = `developer` base                         | HIGH       | REPO-ASSESSMENT.md explicit recommendation для наш профиль                                                                         |
| Selective additions: security (USDT phase), research (opt) | MED        | Security clear, research future-deferred                                                                                           |
| Preserve PM as custom orchestrator                         | HIGH       | Нет ECC equivalent для daily product workflow management                                                                           |
| Preserve Legal as custom agent                             | HIGH       | UA jurisdictional specificity — нет ECC equivalent                                                                                 |
| Adopt agent YAML frontmatter format                        | HIGH       | Standard, well-documented, тестировано в ECC                                                                                       |
| Adopt skill SKILL.md format                                | HIGH       | Same — adopt as-is                                                                                                                 |
| Adopt hooks.json matcher format с node bootstrap           | MED        | Сложнее текущих shell hooks; нужен POC в Phase 2 что наши custom hooks (coder-pre-push, block-production-edits) work в этом format |
| Russian language adaptation                                | HIGH       | Hard project requirement; clear adaptation pattern                                                                                 |
| Lessons → skills conversion (Phase 4)                      | MED        | Risk loss nuance; mitigation через User review каждого skill                                                                       |
| Cross-harness Phase 7+ defer                               | HIGH       | Out of immediate scope per architect.md anti-scope                                                                                 |
| 6-week timeline estimate                                   | MED        | Зависит от user availability для approval gates; может растянуться                                                                 |

---

**End of Discovery Report. Awaiting User signal для Phase 0 ADR drafting.**
