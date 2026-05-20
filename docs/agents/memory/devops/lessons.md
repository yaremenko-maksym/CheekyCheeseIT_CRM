# DevOps Lessons

Накопленные уроки от прошлых задач DevOps. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-20 [task-infra-merge-gate] CI auto-merge `if: != 'failure'` пропускает `skipped` как валидный. Использовать `== 'success'` для каждого зависимого job.
2026-05-19 [task-infra-e2e-watchdog] GHA workflow с `permissions: issues: write` нужно явно указывать в YAML — дефолтный токен только read.
