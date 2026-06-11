# Rule: Лёгкий трек (master-сессия) vs полный pipeline

**Status:** Always-on
**Applies to:** USER-сессии (Master). Агенты (Coder/AutoTest/DevOps/...) работают только по полному pipeline.
**Source:** Context-diet audit 2026-06-11 — легитимизация существующей практики inline-фиксов.

---

## Зачем

Не каждое изменение требует BA → PM → task-файл → Coder. Мелкие правки master-сессия
делает сама — быстрее и дешевле. Этот файл фиксирует границы, чтобы «лёгкий» не
расползался на security-поверхность.

## Лёгкий трек разрешён

- Документация и markdown: `CLAUDE.md`, `docs/**`, `.claude/**` (мета-файлы агентов, правила)
- Конфиги без runtime-эффекта на продукт
- Однофайловый фикс ≤ ~30 строк БЕЗ бизнес-логики и БЕЗ security-поверхности
- Косметика UI (тексты, отступы, классы) — с обязательным playwright-скриншотом

## Только полный pipeline (PM dispatch)

- Фичи и любые multi-file изменения
- ЛЮБОЕ касание auth / finance / RBAC / wallets / transactions — security-reviewer обязателен
- Новые таблицы / Drizzle-миграции
- Изменения `*.spec.ts` — зона AutoTest (master не правит спеки напрямую)
- Всё, что требует test-AC (см. ecc/common/testing.md + task-шаблоны)

## Механика лёгкого трека

1. Работа из worktree (`.claude/worktrees/*` — zone-hook allow-путь) или эскейп-хатч
   `.claude/.allow-direct-edits` (gitignored) для emergency.
2. Изменённые `.ts`/`.tsx` → `mcp__eslint__lint-files` + `pnpm typecheck` перед commit.
3. Если в diff есть код — `pnpm --filter @crm/e2e test` локально перед push.
   **Docs-only diff** (только `.md` / `.claude`-мета) — E2E-прогон НЕ требуется;
   явно отметить это в PR body («docs-only, E2E skipped per light-track»).
4. Всегда PR — никогда прямой push в main. Merge — только явное «мерджим» от USER
   (label `merge-approved`).
5. UI затронут → playwright-скриншот в PR.

## Связанные правила

- `.claude/rules/common/zone-of-write.md` — allow-пути zone-хука (worktree / эскейп-хатч).
- `.claude/rules/common/git-policy.md` — формат коммитов, explicit `git add`, запреты.
- `.claude/rules/common/eslint-mcp-first.md` — lint перед правкой `.ts`/`.tsx`.
