# PM Lessons

Накопленные уроки от прошлых задач PM. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-20 [task-fix-pr22-ui-round5] Если task-файл начинает превращаться в дословный диктант с line-numbers — значит Coder работает вслепую. Решение не "ещё точнее в task", а добавить visual feedback loop (Playwright в Coder перед PR).
2026-05-20 [task-infra-merge-gate] CI без явного gate `merge-approved` нарушает Mode 4 User Testing. Любой gate должен быть enforced инструментом (label/hook), а не текстом в task-файле.
2026-05-19 [task-fix-pr22-ui] User Testing раунды накапливаются геометрически: round1=5 правок, round2=новые 5, round4 ломает round3. Без visual gate Coder не видит регрессий до PR.
2026-05-21 [task-profile-redesign] Reviewer review event = COMMENT с `Verdict: BLOCK` в первой строке тела (НЕ REQUEST_CHANGES) — GitHub API запрещает REQUEST_CHANGES когда author == reviewer (один owner на AI-агентов). PM парсит Verdict: BLOCK → снимает awaiting-pm-review → ставит do-not-merge → fix-task для Coder. См. Mode 2.D в pm.md.
2026-05-21 [task-profile-redesign] MUST-dispatch AutoTest после Coder — даже если кажется что нет UI/E2E изменений. Если реально не нужен — записать event `autotest_skipped` с reason в pm-state.json. Skip без записи = пробел в покрытии.
2026-05-22 [retro-session-after-archive-pr] Sequence intent ≠ approval. «Сначала вмерджим X, потом Y» — это план, а не команда мерджить X сейчас. При любой двусмысленности задавать одно clarifying Q: «мерджим X прямо сейчас?» — не предполагать. Конкретно: преждевременный merge PR #35 произошёл потому что я (PM) трактовал план как approval.
2026-05-22 [retro-session-after-archive-pr] Короткое visual feedback (скриншот + 3 слова «выровняй по вертикали») — НЕ делать первую правдоподобную интерпретацию. Задать одно clarifying Q: «выровнять cells между колонками или contents внутри row?». Конкретно: на round 9 я сделал 2-row структуру для «no junior», а проблема была в `min-h-19` на outer wrapper — двойная итерация на одной проблеме.
2026-05-22 [retro-session-after-archive-pr] Для нетривиальных visual багов (скриншот без аннотаций) — присылать пользователю свою интерпретацию ДО dispatch Coder: «Я понял что нужно X — правильно?». Лучше потерять 1 раунд диалога чем впустую запустить Coder на 12 мин.
