# CheekyCheeseIT CRM — Agent Instructions

**ВАЖНО: Всегда общайтесь с пользователем на русском языке.** Code и commits — английский.

Это **production CRM** для рекрутинговой/аутсорс-компании. Работает на основе многоагентной архитектуры с миграцией на **ECC (Everything Claude Code) v2.0.0-rc.1** patterns.

**ECC version:** 2.0.0-rc.1 (pinned SHA `928076cc...`) — см. `ecc-pin.txt`

---

## Core Principles (наследуем из ECC)

1. **Agent-First** — Delegate to specialized agents for domain tasks
2. **Test-Driven** — Tests перед implementation; критические пути покрыты unit/e2e
3. **Security-First** — Никаких hardcoded secrets; финансовый/auth-код проходит `security-reviewer`
4. **Immutability** — Новые объекты вместо мутаций; новые версии вместо overwrite
5. **Plan Before Execute** — План видимый до execute; User approves complex changes

## Project-Specific Principles

6. **Русский язык** в общении с пользователем — все агенты, без исключений
7. **Zone-of-write** discipline — каждый агент имеет строгую зону записи
8. **D1–D4 resilience** — intent marker, pre-push AC verification, write-then-post, dispatch decision
9. **UA jurisdictional context** для Legal — ФОП, ПКУ, CFC, Закон 2074-IX (crypto), Меморандум НБУ
10. **MCP-first**: ast-grep / context7 / postgres / eslint / playwright / github MCP вместо bash-grep/find

---

## Available Agents

### Project agents (legacy, мигрируем в Phase 3)

| Agent         | Purpose                                      | When to Use                            | Location                    |
| ------------- | -------------------------------------------- | -------------------------------------- | --------------------------- |
| **PM**        | Orchestrator daily workflow (Mode 1–5)       | Любой product request от user          | `docs/agents/pm.md`         |
| **BA**        | Human role — пишет pm-brief                  | User business discussion               | `docs/agents/ba.md` (human) |
| **Coder**     | Fullstack implementation                     | Feature/bugfix tasks                   | `docs/agents/coder.md`      |
| **AutoTest**  | Playwright E2E development                   | New flow / flaky fix / coverage audit  | `docs/agents/autotest.md`   |
| **Reviewer**  | Code review (verdict BLOCK, write-then-post) | PR review                              | `docs/agents/reviewer.md`   |
| **DevOps**    | CI/CD, GHA, environment                      | Infrastructure tasks                   | `docs/agents/devops.md`     |
| **Legal**     | UA jurisdictional advisor (4 modes A/B/C/D)  | Legal consult / contract / brief check | `docs/agents/legal.md`      |
| **Architect** | ECC migration orchestrator                   | Migration phases (текущая работа)      | `docs/agents/architect.md`  |

### ECC catalog agents (доступны через `agents/`)

61 specialized agent в `agents/` (skopiro Phase 1). Используются:

| Agent                  | Purpose                        | When PM/Architect invokes                                       |
| ---------------------- | ------------------------------ | --------------------------------------------------------------- |
| `planner`              | Implementation planning        | Сложная feature перед написанием кода                           |
| `architect` (ECC)      | System design decisions        | Architectural choice (отличается от нашего Migration Architect) |
| `tdd-guide`            | TDD workflow RED→GREEN→IMPROVE | Новая фича / bugfix                                             |
| `code-reviewer`        | Code quality review            | После написания/модификации (Phase 3+ интеграция с PM)          |
| `security-reviewer`    | Vulnerability detection        | Финансовый/auth/USDT код, перед коммитом                        |
| `typescript-reviewer`  | TS/JS-specific review          | TS файлы                                                        |
| `database-reviewer`    | PostgreSQL/Drizzle review      | Schema/migration changes                                        |
| `build-error-resolver` | Fix build/type errors          | Build failure                                                   |
| `e2e-runner`           | Playwright E2E                 | Critical user flows                                             |
| `harness-optimizer`    | Claude Code config tuning      | Reliability/cost issues                                         |
| `loop-operator`        | Autonomous loop execution      | Long-running loop monitoring                                    |

Полный каталог: см. `agents/` directory или `docs/architecture/ecc-reference/AGENTS.upstream.md`.

---

## Agent Orchestration

**Daily product work:**

- User request → **PM** decides (Mode 1–5) → dispatches Coder/AutoTest/Reviewer/Legal/DevOps
- PM может invoke ECC `planner` для сложного декомпоза
- Coder может invoke ECC `tdd-guide`, `typescript-reviewer`, `database-reviewer`
- Reviewer split: `code-reviewer` (default) + `security-reviewer` для финансов/auth/USDT — Phase 3
- DevOps может invoke ECC `build-error-resolver`, `harness-optimizer`

**Migration work:**

- User → **Architect** (Migration Architect, наш custom) → executes phase → opens PR → user approval gate

**Parallel execution:** для independent operations (typecheck + lint + test) — launch multiple agents simultaneously.

---

## Skills Surface

- **ECC skills** (`skills/ecc/<name>/SKILL.md`) — 36 first-party skills, скопировано в Phase 1 (relevant subset из `developer` + `security` profile)
- **Custom skills** (`skills/<name>/SKILL.md`) — Phase 4 миграция lessons → skills, UA-legal stubs, recruiting-domain rules
- **Lessons.md** (`docs/agents/memory/<role>/lessons.md`) — продолжают как append-log даже после Phase 4

Skills принцип: `When to Activate` / `Workflow` / `Tested examples` — структурно (ECC RULES.md).

---

## Security Guidelines

**Перед ANY commit:**

- Нет hardcoded secrets (API keys, passwords, tokens, USDT private keys)
- Все user inputs validated (Zod v4 везде где relevant)
- SQL injection — параметризованные queries (Drizzle ORM by default)
- XSS — sanitized HTML (React escape-by-default)
- CSRF protection — JWT в HttpOnly cookie + state CSRF в OAuth flow
- Authentication/authorization verified — RBAC matrix (ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT)
- Rate limiting — `@nestjs/throttler` на API endpoints
- Error messages не leak sensitive data — generic в UI, detailed в server logs

**Secret management:** environment variables, `.env.example` template, validation на startup. Никогда не commitи `.env`. При случайном expose — rotate немедленно.

**Если security issue найден:** STOP → invoke `security-reviewer` → fix CRITICAL → rotate → audit similar патерны в codebase.

**Финансовый код / USDT / auth:** обязательно `security-reviewer` agent перед мерджем.

---

## Coding Style

- **Immutability** (CRITICAL): новые объекты, never mutate
- **File organization**: many small files. 200–400 lines typical, 800 max. Organize by feature/domain
- **Error handling**: handle на каждом уровне, user-friendly в UI, detailed в server, никогда silent swallow
- **Input validation**: на system boundaries, schema-based (Zod), fail fast
- **Code quality checklist:**
  - Functions < 50 lines
  - Files < 800 lines (для CRM target 200–400)
  - No deep nesting (> 4 levels)
  - Readable, well-named identifiers
  - Конкретные типы вместо `any`

---

## Testing Requirements

- **Unit tests** — Vitest (`apps/api`, `apps/web`, `packages/shared`)
- **Integration tests** — API endpoints против тестовой БД
- **E2E tests** — Playwright (`apps/e2e`)

**TDD workflow** (Coder agent):

1. RED — failing test
2. GREEN — minimal implementation
3. IMPROVE — refactor + verify coverage

**Coverage target:** 80%+ (по ECC). Для legacy modules — incremental approach.

**Spec changes go to auto-tester + coder agents, не Claude напрямую** — см. `feedback_test_fixing` memory item.

---

## Development Workflow

1. **Plan** — PM (Mode 2: decompose) или ECC `planner` для сложных фич
2. **TDD** — Coder + `tdd-guide` skill, тесты перед кодом
3. **Review** — Reviewer пишет comment `event: COMMENT`, verdict BLOCK или OK
4. **User Testing** — PM запускает `prep-user-testing.sh` (Serveo tunnel + dev-login)
5. **Approval** — user в чате говорит "мерджим" → PM ставит `merge-approved` label → `auto-merge-on-label.yml`
6. **Knowledge capture:**
   - Project knowledge → `docs/` (architecture, business, agents/memory)
   - Personal/temporary → auto-memory
   - Не дублировать уже задокументированное

---

## Workflow Surface Policy

- `skills/` — canonical workflow surface (ECC v2 direction)
- `commands/` — legacy slash-entry, **НЕ адаптируем** (low priority per ADR Section 1.1)
- Project-specific knowledge → `skills/<name>/SKILL.md` (Phase 4+)
- Lessons.md → append-log (preserved post-migration per Phase 4 mitigation)

---

## Git Workflow

- **Commit format:** `<type>(<scope>): <description>` — типы `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`
- **Branches:** `feature/<slug>`, `fix/<slug>`, `architect/<phase-slug>`, `worktree-agent-<hash>`
- **PR workflow:** analyze full history → draft Summary + Test plan → push `-u`
- **Hooks:** обязательны, никогда `--no-verify` (CI guard)

---

## Architecture Patterns

- **Monorepo:** Turborepo + pnpm 7.32.4, Node 20 LTS
- **Frontend:** Vite SPA + TanStack Router 1.168 + React + Tailwind v4 + shadcn/ui + Framer Motion
- **Backend:** NestJS 11 + Fastify + Drizzle ORM (PostgreSQL) + Redis
- **Validation:** Zod v4 везде (request/response через `.parse()`)
- **Shared:** `packages/shared` — single source of truth для types + Zod schemas
- **API response format:** consistent envelope `{ ok: boolean, data?, error? }`
- **Repository pattern:** Drizzle service classes
- **Auth:** Manual Google OAuth (no Passport) + JWT в HttpOnly cookie

---

## Performance

- **Context management:** избегать last 20% context window для large refactoring
- **Build troubleshooting:** invoke `build-error-resolver` → incremental fix → verify
- **MCP-first:** ast-grep вместо grep, context7 вместо угадывания API, postgres MCP вместо чтения schema.ts

---

## Project Structure

```
.
├── apps/
│   ├── web/          — Vite SPA + TanStack Router (:3000) — Coder zone
│   ├── api/          — NestJS 11 + Fastify (:3001) — Coder zone
│   └── e2e/          — Playwright tests — AutoTest zone
├── packages/
│   └── shared/       — Zod schemas + types — Coder zone
├── docs/
│   ├── agents/       — Agent prompts (project-format, мигрируем Phase 3)
│   ├── architecture/ — ADRs, ECC reference, migration docs — Architect zone
│   ├── business/     — Business docs — BA zone
│   ├── legal/        — UA legal knowledge base — Legal zone
│   └── specs/        — Task files, pm-brief
├── .github/
│   └── workflows/    — CI/CD — DevOps zone
├── .claude/
│   ├── hooks/        — Project hooks (.sh, мигрируем Phase 2)
│   └── settings.json — Hook registration
├── scripts/          — PM, DevOps, Coder automation
│
│  ECC native layout (новое — Phase 1):
├── agents/           — 61 ECC catalog agents
├── skills/
│   └── ecc/          — 36 ECC first-party skills (selective)
├── hooks/            — ECC hooks.json reference (миграция .claude/hooks → сюда в Phase 2)
├── rules/
│   └── ecc/          — ECC rules (common + typescript + web)
├── manifests/        — ECC install manifests (profiles/modules/components)
├── mcp-configs/      — ECC canonical MCP server configs
├── AGENTS.md         — Этот файл
├── RULES.md          — Project rules (merged ECC + custom)
├── SOUL.md           — Project identity
├── WORKING-CONTEXT.md — Current sprint / blockers / queues
└── ecc-pin.txt       — ECC version pin
```

---

## Success Metrics

- All tests pass с растущим coverage (target 80%+)
- Никаких security vulnerabilities
- Код readable, maintainable
- Performance acceptable (< 3s page load, < 200ms API)
- User requirements встречены
- Multi-agent система не блокирует daily product flow в время migration

---

## ECC Reference

- Upstream catalog: `docs/architecture/ecc-reference/AGENTS.upstream.md`
- Master ADR: `docs/architecture/2026-05-31-ecc-migration-design.md`
- Architect role spec: `docs/agents/architect.md`
- ECC version pin: `ecc-pin.txt`
- ECC user guide: `docs/architecture/2026-05-31-ecc-user-guide.md`
