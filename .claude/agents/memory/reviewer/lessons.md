# Reviewer Lessons

Накопленные уроки от прошлых задач Reviewer. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-21 [P0] [task-profile-redesign] #review-gate #mechanism Для блокировки PR использовать `event: COMMENT` + первая строка тела `Verdict: BLOCK` — НЕ REQUEST_CHANGES. GitHub API запрещает REQUEST_CHANGES когда reviewer-аккаунт == author (один owner на всех AI-агентов). См. `code-reviewer.md` + skill `code-review-discipline` (review-gate механика).
2026-05-23 [P0] [dev-flow-rca] #resilience #recovery Сохраняй тело review в `/tmp/reviewer-output/pr-N-TS.md` **до** `mcp__github__create_pull_request_review`. MCP может зависать > 10 мин (real incident 2026-05-23) → watchdog crash → review теряется. Файл выживает crash, доступен для manual recovery. См. skill `code-review-discipline` (write-then-post).
2026-05-23 [P1] [dev-flow-rca] #zone-violation Если diff PR содержит изменения вне zone-of-write Coder'а (scripts/pm/**, .claude/agents/**, .github/workflows/**) — Verdict: BLOCK с указанием конкретного файла. См. coder.md «Zone-of-write».

<!-- Заполняется PM после merged PR. Примеры что считать хорошим уроком:
- "При review UI-задач — проверять Russian text в diff, не только структуру"
- "Если PR трогает RBAC — обязательно проверить все 5 ролей в комментарии"
- "Не давать APPROVE если в diff есть console.log даже в test файлах"
-->
2026-06-12 [P1] [pr-177] (#github-api) GitHub блокирует event:APPROVE на self-PR (owner==reviewer) так же, как REQUEST_CHANGES — 422 «Can not approve your own pull request». Для ЛЮБОГО verdict использовать event:COMMENT + первая строка `Verdict: APPROVE|BLOCK`. Write-then-post обязателен — тело сохранять в /tmp до MCP-вызова, переотправка без потерь.
