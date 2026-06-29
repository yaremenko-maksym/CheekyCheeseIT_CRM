# Coder Lessons

Накопленные уроки Coder. Формат: `YYYY-MM-DD [P0|P1] (#tag) урок`. Правила — [`../README.md`](../README.md). Доменные детали живут в секциях `coder.md` (ссылки в уроках).

---

2026-06-12 [P0] (#worktree-contamination) Свой worktree = ТОЛЬКО `.claude/worktrees/agent-<твой-id>`; PM-worktree и MAIN — запретная зона (субагент наследует cwd родителя, «я уже в worktree» ≠ «в своём»). Sentinel в MAIN писать можно, но НЕ git add/commit из MAIN (дивергенция с origin). Инциденты #6/#12.
2026-05-20 [P0] (#commit-hygiene) `git add .` подметает чужие debug-артефакты — только явный список файлов из task «Конкретные изменения».
2026-06-02 [P0] (#no-verify) Запрещён `--no-verify` / обход git hooks. Pre-push падает на тесте → изолировать (`pnpm --filter @crm/web test -- <file>`); flake → retry-config/`it.retry` + fix, потом обычный push. 3 инцидента: CI падал на том же тесте.
2026-06-02 [P0] (#final-verify) В финальном отчёте ОБЯЗАН `git log origin/<branch> -1 --oneline` (не локальный!) + `gh pr view <num>` — agents «killed mid-task» рапортовали push/PR, которых не было. «Pre-existing flake» — только с isolated proof (stash → checkout origin/main → тот же тест → diff), иначе не упоминать.
2026-05-30 [P0] (#e2e #strict-mode) Новые помощник-тексты в формах НЕ должны содержать role-слова существующих e2e-селекторов («HR»/«Бухгалтер»/«Синьор») — `getByText` без `exact:true` падает strict-mode. Grep `e2e/tests/*.spec.ts` перед текстами.
2026-05-30 [P0] (#backend-contract) Перед frontend-стартом пройтись по controller'ам: AC требует endpoint, не появившийся в backend PR → сообщить PM или добавить тонкий controller-wrapper (delegating в готовый service).
2026-05-19 [P0] (#testing) `data-testid` обязателен для back-button/dialog-close/cancel + interaction-тесты (Tab+ArrowDown commit) для autocomplete/combobox — иначе strict-mode и Tab-баги проходят мимо. См. coder.md §6.1.
2026-05-23 [P0] (#chunking #zone) Wip-push каждые 2 файла / 5 мин; sentinel `.claude/tasks/<task>.progress.md` обязателен. Coder НЕ трогает `scripts/pm`, `scripts/devops`, `.claude/agents`, `docs/business`, `.github/workflows`, `.claude/hooks`. См. coder.md §7/§8.
2026-06-02 [P1] (#pdf-verify) PDF/SVG/image — визуальная проверка через `playwright browser_take_screenshot` на presigned URL, не текстовый grep (FlateDecode не парсится).
2026-06-02 [P1] (#task-size) Task > 10 AC — просить split (несколько task/PR); иначе wip-коммиты без visual verify проскакивают мимо PM.
2026-06-03 [P1] (#ecc #tdd) Новая фича → ECC `tdd-guide` ПЕРЕД разработкой; bugfix → `superpowers:systematic-debugging`. TS/TSX → `typescript-reviewer` self-review ПЕРЕД push (≠ code-reviewer на PR). См. coder.md §1.5/§2.5.
2026-05-23 [P1] (#recovery) Intent markers (`scripts/coder/coder-intent.sh`) перед длинной операцией (test>30с / milestone / rebase / migration) — semantic-контекст для PM-recovery, НЕ на каждый Edit. См. coder.md §8.1.1.
