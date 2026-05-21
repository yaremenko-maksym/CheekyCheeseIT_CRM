# Reviewer Lessons

Накопленные уроки от прошлых задач Reviewer. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-21 [task-profile-redesign] Для блокировки PR использовать `event: COMMENT` + первая строка тела `Verdict: BLOCK` — НЕ REQUEST_CHANGES. GitHub API запрещает REQUEST_CHANGES когда reviewer-аккаунт == author (один owner на всех AI-агентов). См. reviewer.md шаг 4 «Если есть проблемы».

<!-- Заполняется PM после merged PR. Примеры что считать хорошим уроком:
- "При review UI-задач — проверять Russian text в diff, не только структуру"
- "Если PR трогает RBAC — обязательно проверить все 5 ролей в комментарии"
- "Не давать APPROVE если в diff есть console.log даже в test файлах"
-->
