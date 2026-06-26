# BLOCKER: fix/audit-interviews-integrity (push only — code is done & verified)

## Агент: coder

## Задача: pre-deploy audit fixes for INTERVIEWS (3 findings)

## Статус кода: ГОТОВ И ПРОВЕРЕН

Все 3 находки исправлены, протестированы, typecheck/eslint/integration/E2E зелёные.
Локально закоммичено на ветку `fix/audit-interviews-integrity` (tip несёт `ac_verified: 1,2,3`).
**Блокирован ТОЛЬКО `git push`** — по причине ниже.

## Проблема (инфраструктура, вне моей zone-of-write)

Pre-push hook `pre-bash-prettier-gate.sh` запускается в CWD главной сессии-репозитория,
которая checked out на ЧУЖУЮ ветку `infra/e2e-money-shard` (не на мой worktree).
Hook считает changed-файлы как `origin/main...HEAD` ЭТОЙ ветки и находит 10
закоммиченных, но НЕ отформатированных prettier'ом файлов `.design-sync/previews/*.tsx`
(+ `.github/workflows/*.yml`, `apps/web/.ds-entry.tsx`) — это работа другого агента
по редизайну, НЕ моя.

Мой собственный diff (`git diff origin/main...HEAD` из worktree) — 6 файлов, ВСЕ
prettier-clean:

- packages/shared/src/schemas/interviews.ts
- apps/api/src/interviews/interviews.service.ts
- apps/api/src/projects/projects.service.ts
- apps/api/src/interviews/interviews-rbac.integration.spec.ts
- apps/api/src/interviews/interviews-move-transaction.integration.spec.ts
- .claude/tasks/task-audit-interviews-integrity.progress.md

Hook оценивает НЕ мой worktree, а branch главной сессии — это CWD-isolation gap хука
(он читает `git branch --show-current` из session-CWD; `GIT_DIR`/`GIT_WORK_TREE`
override игнорируются, т.к. hook — отдельный процесс с родительским окружением).

## Что я НЕ делал (намеренно)

- НЕ `git push --no-verify` / любой bypass — golden rule.
- НЕ форматировал/коммитил `.design-sync/*` — это ветка другого агента, вне моей
  zone-of-write; правка контаминировала бы `infra/e2e-money-shard` и засорила мой PR.
- НЕ переключал ветку главной сессии — это сломало бы живой стек пользователя (:3000/:3001).

## Как разблокировать (любой из вариантов — действие владельца/PM)

1. В главной сессии-репозитории временно: `git -C <main-repo> stash` (если нужно) и
   `git -C <main-repo> checkout main` → затем я (или PM) повторяю
   `cd /tmp/fix-interviews && DATABASE_URL= git push origin fix/audit-interviews-integrity`.
   Hook увидит ветку `main` → allow (он пропускает main/detached). После push вернуть ветку.
2. ИЛИ отформатировать и закоммитить design-sync долг на `infra/e2e-money-shard`
   (`prettier --write` 10 файлов) — тогда hook на любой ветке проходит.
3. ИЛИ push выполняет владелец из терминала вне Claude-хука.

После push: `gh pr create --base main` (title
`fix(api): interviews — stage-transition guards + transactional move + ex-HR filter (audit HIGH)`)

- label `ai-review-ready`.

## Верификация (выполнена ДО блокера)

- `pnpm --filter @crm/api typecheck` → PASS
- `pnpm --filter @crm/web typecheck` → PASS (после генерации routeTree.gen.ts)
- `pnpm --filter @crm/web build` → PASS
- eslint на изменённых файлах → PASS
- Integration (real DB crm_qa): interviews + projects → **166 passed** (вкл. новые:
  stage-strip, ex-HR leftAt revocation, transactional move rollback + happy-path)
- E2E `interviews.spec.ts` против изолированного web-билда (:3016) → **41 passed**
  (против живого :3000 — 41 fail, но это redesign-WIP UI того стека; мой diff
  не трогает ни одного frontend/E2E файла — доказано `git diff --name-only`).
