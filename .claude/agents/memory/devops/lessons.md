# DevOps Lessons

Накопленные уроки от прошлых задач DevOps. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-07-27 [P0] [task-infra-post-merge-ci] #workflow-run #blast-radius Починка мёртвого триггера БУДИТ всех подписчиков события. Включив post-merge CI на main, разбудили спавший 1.5 месяца `e2e-watchdog` (`workflow_run: [CI]`), а он пушит в main под ADMIN_PAT → push-событие → деплой красного прода → снова красный CI → петля. Перед тем как оживить триггер — `grep -l "workflow_run" .github/workflows/` и прочитать, что каждый подписчик делает с правами.
2026-07-27 [P0] [task-infra-post-merge-ci] #gha-steps Шаг GHA без `if:` = неявный `success()` ВСЕХ предыдущих шагов job'а. Два независимых диспатча подряд молча превращаются в цепочку: упал первый — второй не выполнился вообще. Независимые шаги гейтить явно (`if: always() && steps.<id>.outcome == 'success'`). То же в одном `run:`-блоке: дефолтный shell `bash -eo pipefail` обрывает блок на первой неудаче.
2026-07-27 [P1] [task-infra-post-merge-ci] #secrets Проверка секрета на непустоту ≠ проверка валидности. Протухший fine-grained PAT — НЕПУСТАЯ строка: `[ -n "$PAT" ]` его примет, `gh` вернёт 401, `set -euo pipefail` уронит скрипт до отправки алерта = тишина вместо задокументированного фолбэка. Выбирать канал пробным запросом, а не наличием переменной.
2026-05-20 [P0] [task-infra-merge-gate] #ci-gate CI auto-merge `if: != 'failure'` пропускает `skipped` как валидный. Использовать `== 'success'` для каждого зависимого job.
2026-05-19 [P1] [task-infra-e2e-watchdog] #workflow-config GHA workflow с `permissions: issues: write` нужно явно указывать в YAML — дефолтный токен только read.
2026-05-23 [P1] [dev-flow-rca] #macos #cross-platform GNU `timeout`/`mktemp` не работают на macOS из коробки. Использовать shim-функции (`_timeout` с perl fallback) или явную генерацию `/tmp/<prefix>-$$-$RANDOM.<ext>`.
2026-05-23 [P0] [dev-flow-rca] #pkill #worktree-hygiene `pkill -f vite` убивает сторонние Vite-проекты пользователя — враждебно. Убивать процессы по PORT (`lsof -ti :PORT | xargs -r kill -TERM`), не по pattern имени. Идемпотентно.
2026-05-23 [P0] [dev-flow-rca] #worktree-checkout `git checkout BRANCH` падает если ветка checked out в другом worktree. Pre-flight через `git worktree list --porcelain` + `cd` в найденный worktree вместо checkout.
