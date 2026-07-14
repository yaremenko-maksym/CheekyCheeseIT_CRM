# Manual QA Lessons

Накопленные уроки от прошлых задач Manual QA. Формат: `YYYY-MM-DD [P0|P1|P2] [task-id] #topic урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-07-14 [P0] [pr-367-qa] #shared-browser Playwright MCP-браузер и dev-Postgres ОБЩИЕ для параллельно работающих агентов: чужой dev-login подменяет cookie-сессию, viewport скачет от чужих resize. Перед каждым ролевым ассертом сверять активную сессию `GET /api/auth/me`; критичные денежные проверки дублировать прямыми API-вызовами с отдельным cookie-jar per-роль.
2026-07-14 [P1] [pr-367-qa] #env-override Глобальные `FRONTEND_URL`/`API_PORT`/`DATABASE_URL` из шелла НЕ перезаписываются dotenv — при старте скретч-стека передавать явно (`env API_PORT=… FRONTEND_URL=…`), иначе CORS-блок или чужая БД.
