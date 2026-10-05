# Reviewer Lessons

Accumulated lessons from past Reviewer tasks. Format: `YYYY-MM-DD [task-id] lesson`.
See [`../README.md`](../README.md) for rules and examples.

---

2026-05-21 [P0] [task-profile-redesign] #review-gate #mechanism To block a PR use `event: COMMENT` + the first line of the body `Verdict: BLOCK` — NOT REQUEST_CHANGES. The GitHub API forbids REQUEST_CHANGES when the reviewer account == author (one owner for all AI agents). See `code-reviewer.md` + skill `code-review-discipline` (review-gate mechanics).
2026-05-23 [P0] [dev-flow-rca] #resilience #recovery Save the review body to `/tmp/reviewer-output/pr-N-TS.md` **before** `mcp__github__create_pull_request_review`. MCP may hang > 10 min (real incident 2026-05-23) → watchdog crash → the review is lost. The file survives the crash, available for manual recovery. See skill `code-review-discipline` (write-then-post).
2026-05-23 [P1] [dev-flow-rca] #zone-violation If a PR diff contains changes outside the Coder's zone-of-write (scripts/pm/**, .claude/agents/**, .github/workflows/**) — Verdict: BLOCK naming the specific file. See coder.md "Zone-of-write".

<!-- Filled in by PM after a merged PR. Examples of what counts as a good lesson:
- "When reviewing UI tasks — check Russian text in the diff, not only the structure"
- "If a PR touches RBAC — be sure to check all 5 roles in a comment"
- "Do not APPROVE if the diff has a console.log even in test files"
-->
2026-06-12 [P1] [pr-177] (#github-api) GitHub blocks event:APPROVE on a self-PR (owner==reviewer) the same way as REQUEST_CHANGES — 422 "Can not approve your own pull request". For ANY verdict use event:COMMENT + the first line `Verdict: APPROVE|BLOCK`. Write-then-post is mandatory — save the body to /tmp before the MCP call, re-send without loss.
