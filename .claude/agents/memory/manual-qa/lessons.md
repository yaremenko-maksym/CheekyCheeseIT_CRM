# Manual QA Lessons

Accumulated lessons from past Manual QA tasks. Format: `YYYY-MM-DD [P0|P1|P2] [task-id] #topic lesson`.
See [`../README.md`](../README.md) for rules and examples.

---

2026-07-14 [P0] [pr-367-qa] #shared-browser The Playwright MCP browser and the dev Postgres are SHARED across agents working in parallel: someone else's dev-login swaps the cookie session, the viewport jumps from someone else's resize. Before each role assertion, verify the active session with `GET /api/auth/me`; duplicate critical money checks with direct API calls using a separate cookie-jar per role.
2026-07-14 [P1] [pr-367-qa] #env-override Global `FRONTEND_URL`/`API_PORT`/`DATABASE_URL` from the shell are NOT overwritten by dotenv — when starting the scratch stack pass them explicitly (`env API_PORT=… FRONTEND_URL=…`), otherwise a CORS block or someone else's DB.
