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

## Параллельный диспатч (потолок concurrency)

**Status:** добавлено 2026-06-16 (ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-1/FM-6/FM-7).

При параллельном диспатче агентов (PM или master-сессия):

- **Потолок ≈ 3-4 одновременных старта.** 5+ агентов, запущенных ОДНИМ сообщением (startup-burst
  первых API-вызовов), -> часть получает `API Error: 529 Overloaded` и умирает на старте (0 tool_uses).
  Диспатчить волнами по 2-3, стаггерить; 529-убитых просто перезапускать (работы не сделали).
- **Тяжёлые Coder'ы (каждый бутит vite+api + full Vitest) + live UT-стек** -> CPU-starvation ->
  pre-push timeout-флаки (НЕ код). Перед push — sweep zombie dev-портов завершившихся агентов:
  `for p in 3010 3011 3014 3016 3017 3018; do lsof -ti tcp:$p; done` -> kill (сохранив live :3000/:3001).
- **`DATABASE_URL= git push`** (пустой) для feature-веток — integration-спеки graceful-skip, не бьют
  live crm_db и не ловят CPU-timeout (см. git-policy.md).
- **Zombie-профилактика (2026-07-24, механика вместо дисциплины).** Инцидент: 67 зомби nest/vite из
  worktree 12–15.07 -> swap-трэшинг (LA 70). Три слоя: (1) dev-серверы в worktree/scratchpad стартуют
  ТОЛЬКО через `scripts/devops/dev-ttl.sh -- <cmd>` (TTL-самоликвидация группы процессов, default 4ч);
  (2) hook `pre:bash:devserver-ttl-gate` блокирует голый `nest start`/`vite`/`pnpm dev`/`node dist/main`
  в `.claude/worktrees/**` и claude-scratchpad; (3) launchd-reaper каждые 30 мин добивает node-процессы
  worktree старше 6ч или с удалённым worktree (установка: `scripts/devops/install-devserver-reaper.sh`;
  dry-run: `REAPER_DRY_RUN=1 scripts/devops/reap-zombie-devservers.sh`). Ручной sweep при надобности:
  `pgrep -f 'worktrees[/]agent-' | xargs kill -9` — именно xargs: в zsh `kill $VAR` НЕ сплитится
  (падает «illegal pid» — и это маскируется `2>/dev/null`).

## Связанные правила

- `.claude/rules/common/zone-of-write.md` — allow-пути zone-хука (worktree / эскейп-хатч).
- `.claude/rules/common/git-policy.md` — формат коммитов, explicit `git add`, запреты.
- `.claude/rules/common/eslint-mcp-first.md` — lint перед правкой `.ts`/`.tsx`.
