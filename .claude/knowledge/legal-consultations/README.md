# Legal Consultations Log

A persistent log of the Legal agent's strategic-mode consultations. Used as:

1. A future reference for similar questions (search by topic)
2. An audit trail (history of legal decisions)
3. A source for lessons.md entries

## Naming

```
YYYY-MM-DD-<slug>.md
```

Examples:

- `2026-05-31-fop3-vs-fop2-for-juniors.md`
- `2026-06-15-passport-storage-s3.md`
- `2026-07-02-usdt-payouts-aml.md`

## File structure

Created by PM in Mode D — `## Question` + `## Context`. The Legal agent adds `## Lawyer answer` (structure from `docs/agents/legal.md`).

After a consultation is closed the file stays as a permanent reference. Do not delete / do not edit retrospectively — for the consistency of the audit trail.

## How it differs from task-legal-\*.md

|           | `docs/specs/tasks/task-legal-*.md`         | `docs/specs/legal-consultations/*.md`                            |
| --------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Mode      | A (consult) — task-related                 | D (strategic) — outside the task flow                            |
| Lifecycle | After closing → archive (like other tasks) | Permanent log                                                    |
| Trigger   | PM creates it for a specific feature/PR    | PM creates it on the User's request outside the feature pipeline |
| Context   | Tied to a task / PR / feature              | A strategic standalone question                                  |
| Reading   | PM while working on a task                 | User / PM on future similar questions                            |

## Optional: index

If the log grows (> 20 files) — create `INDEX.md` with categorization by topic for quick search. For now — `ls -la` is enough.
