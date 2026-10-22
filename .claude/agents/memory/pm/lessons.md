# PM Lessons (orchestrator lessons — the PM role was merged into Master 2026-10-05)

Accumulated lessons from past PM tasks. Format: `YYYY-MM-DD [task-id] lesson`.
See [`../README.md`](../README.md) for rules and examples.

---

2026-05-20 [P0] [task-fix-pr22-ui-round5] #workflow #review If a task file starts turning into a verbatim dictation with line numbers — it means the Coder is working blind. The fix is not "even more precise task", but adding a visual feedback loop (Playwright in Coder before the PR).
2026-05-19 [P1] [task-fix-pr22-ui] #user-testing #regression User Testing rounds accumulate geometrically: round1=5 edits, round2=another 5, round4 breaks round3. Without a visual gate the Coder does not see regressions before the PR.
2026-05-21 [P1] [task-profile-redesign] #autotest #coverage MUST-dispatch AutoTest after Coder — even if it seems there are no UI/E2E changes. If it is truly not needed — record the event `autotest_skipped` with a reason in pm-state.json. Skip without a record = a gap in coverage. (Clarified 2026-05-23: D3 fix — now conditional dispatch, see pm.md AutoTest dispatch decision.)
2026-05-22 [P1] [retro-session-after-archive-pr] #approval #communication Sequence intent ≠ approval. "First we merge X, then Y" is a plan, not a command to merge X now. On any ambiguity ask one clarifying Q: "merge X right now?" — do not assume. Concretely: the premature merge of PR #35 happened because I (PM) read the plan as approval.
2026-05-22 [P1] [retro-session-after-archive-pr] #visual #communication Short visual feedback (a screenshot + 3 words "align vertically") — do not make the first plausible interpretation. Ask one clarifying Q: "align the cells between columns or the contents inside a row?". Concretely: on round 9 I made a 2-row structure for "no junior", but the problem was `min-h-19` on the outer wrapper — a double iteration on one problem.
2026-05-22 [P2] [retro-session-after-archive-pr] #visual #communication For non-trivial visual bugs (a screenshot without annotations) — send the user your interpretation BEFORE dispatching Coder: "I understood that X is needed — correct?". Better to lose 1 round of dialogue than to waste a 12-min Coder run.
