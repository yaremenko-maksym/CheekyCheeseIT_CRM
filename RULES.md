# Rules — CheekyCheeseIT CRM

Базовая хартия правил для всех агентов. Объединяет ECC standards с project-specific constraints.

> ECC upstream rules сохранены в `docs/architecture/ecc-reference/RULES.upstream.md` для аудита.

---

## Must Always

### Из ECC

- Delegate to specialized agents for domain tasks.
- Write tests before implementation and verify critical paths.
- Validate inputs and keep security checks intact.
- Prefer immutable updates over mutating shared state.
- Follow established repository patterns before inventing new ones.
- Keep contributions focused, reviewable, and well-described.

### Project-specific

- **Отвечать пользователю на русском языке** — все агенты, без исключений. Code comments и commits — английский.
- **Уважать zone-of-write** каждого агента (см. матрицу ниже).
- **Использовать MCP-first**: ast-grep, context7, postgres, eslint, playwright, github — это быстрее и точнее, чем bash-grep/find/curl.
- **Confidence policy**: HIGH / MED / LOW в каждом нетривиальном выводе. LOW + critical decision → STOP и обсуждай с user.
- **AC verification перед push** (D3 fix): Coder выставляет `ac_verified` marker, pre-push hook гейт.

---

## Must Never

### Из ECC

- Включать sensitive data (API keys, tokens, secrets, абсолютные системные пути) в output.
- Сабмитить untested changes.
- Bypass security checks или validation hooks.
- Дублировать существующий функционал без явной причины.
- Шипить код без проверки relevant test suite.

### Project-specific

- **Использовать `--no-verify`** при коммитах/пушах. CI guard `check-no-skip-hooks.yml` это поймает.
- **Force-push в `main`** — никогда.
- **Редактировать вне своей zone-of-write** (см. матрицу).
- **Мерджить PR без явного user approval** в чате ("мерджим"). `merge-approved` label → auto-squash через `auto-merge-on-label.yml`.
- **Бессhinking-ом proceeding through approval gate** между миграционными фазами.

---

## Zone-of-write матрица

| Агент          | Можно редактировать                                                                                                                                             | Запрещено                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **PM**         | `docs/specs/`, `docs/agents/pm*.md`, `pm-state.json` (write), task-files                                                                                        | `apps/**`, `packages/**`, `docs/legal/**`, чужие agent prompts                     |
| **Coder**      | `apps/**`, `packages/**`, тесты, schema/migrations                                                                                                              | `docs/agents/**`, `.claude/hooks/**`, `.github/workflows/**`, `docs/legal/**`      |
| **AutoTest**   | `apps/e2e/**`, `apps/web/**/*.test.tsx`, `apps/api/**/*.spec.ts`                                                                                                | `apps/web/app/routes/**` (только тесты, не страницы)                               |
| **Reviewer**   | PR comments (write-then-post)                                                                                                                                   | прямые edits в чужой код                                                           |
| **DevOps**     | `.github/workflows/**`, `docker-compose.yml`, env templates, `scripts/devops/**`                                                                                | `apps/**`, `packages/**`, agent prompts                                            |
| **Legal**      | `docs/legal/**`, `docs/agents/memory/legal/lessons.md`                                                                                                          | agent prompts, production code                                                     |
| **Architect**  | `docs/architecture/**`, `docs/agents/**` (миграция), `.claude/hooks/**`, `agents/`, `skills/`, `hooks/`, `rules/`, `manifests/`, `mcp-configs/`, ECC base files | `apps/**`, `packages/**`, `docs/business/**`, `docs/legal/**` (как knowledge base) |
| **BA (human)** | `docs/specs/pm-brief.md`, `docs/business/**`                                                                                                                    | агентские артефакты                                                                |

Нарушение zone → `block-production-edits.sh` hook блокирует Edit/Write.

---

## Agent Format (ECC)

- Агенты живут в `agents/*.md` (ECC catalog) или `docs/agents/<name>.md` (project, legacy/transitional).
- Каждый ECC-format файл включает YAML frontmatter: `name`, `description`, `tools`, `model`.
- File names — lowercase с дефисами, должны match `name`.
- Descriptions четко описывают **когда** агент должен быть invoked.
- Для project-format agents (PM/Coder/etc) — фронтматтер появится в Phase 3 миграции.

## Skill Format (ECC)

- Скилы живут в `skills/<name>/SKILL.md`.
- ECC-imported скилы — в `skills/ecc/<name>/SKILL.md`.
- Custom (project) скилы (будут в Phase 4) — в `skills/<name>/SKILL.md`.
- YAML frontmatter: `name`, `description`, `origin`.
- `origin: ECC` для first-party ECC скилов; `origin: community` для community; `origin: custom` для наших project-specific.

## Hook Format (ECC)

- Hooks — matcher-driven JSON registration (см. `hooks/hooks.json` reference).
- Matchers **специфичны**, не catch-all (`tool == "Bash" && tool_input.command matches "git push"`).
- Exit `1` только когда блокировка intentional; иначе exit `0`.
- Error и info messages — actionable.
- Phase 2 миграции переведёт наши 5 `.claude/hooks/*.sh` на ECC JSON format с specific matchers.

---

## Commit Style

- Conventional Commits: `feat(scope):`, `fix(scope):`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `perf:`.
- Scope-ы наши: `pm`, `coder`, `autotest`, `reviewer`, `devops`, `legal`, `architect`, `drop`, `invoices`, `e2e`, `web`, `api`, `shared`.
- Commit messages — английский.
- PR titles — короткие, < 70 символов.
- PR body — markdown, секции `## Summary` и `## Test plan`.

## PR Workflow

- Каждый PR проходит CI (`ci.yml`) + E2E (`e2e.yml`).
- Reviewer пишет comment (event `COMMENT`, не `APPROVE`/`REQUEST_CHANGES`) с verdict BLOCK/OK + список issues.
- User в чате говорит "мерджим" → PM ставит `merge-approved` label → `auto-merge-on-label.yml` делает squash merge.
- Без явного approval — НЕ мерджить, даже в "автономном" режиме.

---

## Migration discipline

- Каждая ECC migration phase = **отдельный PR** + user approval gate.
- Old artifact удаляется только после new validated (coexistence layer ≥ 1 неделя).
- Rollback path всегда документирован в PR description.
- Confidence label обязателен в выводе Architect deliverable.

---

## Источники

- ECC RULES.md upstream: `docs/architecture/ecc-reference/RULES.upstream.md`
- ECC SOUL.md upstream: `docs/architecture/ecc-reference/SOUL.upstream.md`
- Master ADR: `docs/architecture/2026-05-31-ecc-migration-design.md`
- Architect role: `docs/agents/architect.md`
- Dev-flow RCA (D1–D4): `docs/architecture/2026-05-23-dev-flow-rca.md`
