# UI/UX Designer Lessons

Накопленные уроки от прошлых задач UI/UX Designer. Формат: `YYYY-MM-DD [P0|P1|P2] [task-id] #topic урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

(пусто — UI/UX Designer только что зарегистрирован 2026-06-04 в том же PR что и Manual QA. Первые уроки появятся после первых merged PR с designer dispatch'ем)
2026-06-11 [P1] [pr-172] (#worktree-contamination) Designer Mode D работал НЕ в своём isolation-worktree, а в чужом (PM-овском, создал там ветку *-audit) — повезло, что тот был свободен. Правило как у Coder: pwd-чек перед git-операциями, работать только в .claude/worktrees/agent-<свой-id>; чужие worktree и MAIN-чекаут — запретная зона.
