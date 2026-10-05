# UI/UX Designer Lessons

Accumulated lessons from past UI/UX Designer tasks. Format: `YYYY-MM-DD [P0|P1|P2] [task-id] #topic lesson`.
See [`../README.md`](../README.md) for rules and examples.

---

(empty — the UI/UX Designer was just registered 2026-06-04 in the same PR as Manual QA. The first lessons will appear after the first merged PRs with a designer dispatch)
2026-06-11 [P1] [pr-172] (#worktree-contamination) Designer Mode D worked NOT in its own isolation worktree, but in someone else's (the PM's, created a *-audit branch there) — lucky that it was free. The rule is the same as for Coder: a pwd check before git operations, work only in .claude/worktrees/agent-<your-id>; someone else's worktree and the MAIN checkout are a forbidden zone.
