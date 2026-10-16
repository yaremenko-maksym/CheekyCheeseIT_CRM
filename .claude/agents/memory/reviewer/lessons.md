# Reviewer Lessons

Accumulated lessons from past Reviewer tasks. Format: `YYYY-MM-DD [task-id] lesson`.
See [`../README.md`](../README.md) for rules and examples.

---

2026-05-23 [P0] [dev-flow-rca] #resilience #recovery Save the review body to `/tmp/reviewer-output/pr-N-TS.md` **before** `mcp__github__create_pull_request_review`. MCP may hang > 10 min (real incident 2026-05-23) → watchdog crash → the review is lost. The file survives the crash, available for manual recovery. See skill `code-review-discipline` (write-then-post).
2026-05-23 [P1] [dev-flow-rca] #zone-violation If a PR diff contains changes outside the Coder's zone-of-write (scripts/pm/**, .claude/agents/**, .github/workflows/**) — Verdict: BLOCK naming the specific file. See coder.md "Zone-of-write".

2026-06-12 [P0] [task-profile-redesign, pr-177] #review-gate #github-api Owner==reviewer: GitHub rejects REQUEST_CHANGES and event:APPROVE on a self-PR (422). For ANY verdict use `event: COMMENT` + first body line `Verdict: APPROVE|BLOCK`. Write-then-post: save the body to /tmp before the MCP call. See `code-reviewer.md` + skill `code-review-discipline`.
