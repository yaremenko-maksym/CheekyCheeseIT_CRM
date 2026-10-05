# task-<slug>

## Agent: coder | autotest | devops
## Status: ready | in-progress | blocked | draft (awaiting owner decisions) | done
## Blockers: none | task-<slug>, task-<slug>
## Priority: critical | high | medium | low
## Model: sonnet (default) | opus — only per the triggers in rules/common/model-routing.md, add a justification line
## Depends on: (human-readable explanation; machine-readable source of truth — "Blockers" above)
## Branch: feature/<slug>
## (For fixes in an existing branch — give its name)

## Context

<Why this task, what problem it solves. 2-4 lines maximum.>

## Concrete changes

List of files with brief descriptions of what to do. If the change is pinpoint — specify the function/block:

1. `packages/shared/src/schemas/<module>.ts` — add/change <what>
2. `apps/api/src/<module>/<file>.ts` — implement <what>
3. `apps/web/app/routes/crm/<module>/` — UI <what>

## Reuse / Regression scope (PM fills in, Coder must verify — coder.md §1.7)

**Existing code for reuse** (Coder: ast-grep BEFORE writing new):

- `<path>` — <what to reuse: hook / helper / component / pattern>

**Shared code that will be affected** (blast-radius → pinning tests before the change):

- `<exported symbol>` → call-sites: <known places OR "Coder will find via ast-grep">

**Must not break** (existing features nearby, verifiable by tests):

- <feature / flow>

## API endpoints (if new)

- `GET /api/...` — description. RBAC: ADMIN/SENIOR see all, JUNIOR — only their own.
- `POST /api/...` — description + body schema.

## DB schema (if new tables / migrations)

```sql
-- Specify enums, tables, FKs, indexes
```

## RBAC

| Role | Access |
|------|--------|
| ADMIN | full |
| SENIOR | filtered |
| JUNIOR | none |
| HR | filtered |
| ACCOUNTANT | full read |

## Seams under test (PM proposes, Coder confirms BEFORE writing tests)

A test is not written against an unagreed seam. A seam is a public boundary through which
behavior is observed; see `.claude/skills/codebase-design/SKILL.md`. Prefer an existing seam to a new one and
take the highest of the sufficient ones: the fewer seams in the codebase, the better.

- `<module / function / endpoint>` — what is verified through it
- `<module>` — ...

If the task adds no behavior (a pure refactor under pinning tests) — note "Seams N/A,
behavior does not change".

## Acceptance criteria

Each item MUST be verifiable via `git diff HEAD` or grep:

- [ ] <concrete change #1 — specify the pattern/class/function for grep>
- [ ] <change #2>
- [ ] <change #3>

## Interaction tests (MANDATORY for UI with keyboard/focus/debouncing)

If the task touches Autocomplete, Combobox, Modal, Form with validation, Drag-and-drop, Tooltip — specify concrete scenarios:

- [ ] <For example: Autocomplete — Tab commits the highlighted option>
- [ ] <For example: Autocomplete — ArrowDown/ArrowUp navigation through the list>
- [ ] <For example: Autocomplete — Escape closes the dropdown without losing the query>
- [ ] <For example: Modal — Escape closes; focus restore to the trigger button>

See `.claude/agents/coder.md` §6 (E2E rules for UI changes) — checklist by component type.

**If interaction logic is absent** (pure CRUD without keyboard/focus) — note: "Interaction tests N/A — component without interactive elements".

## Assumptions (the executor fills in as they go — A1 decisions)

Every reversible decision the agent made on its own (`rules/common/autonomy-levels.md`,
level A1) exists here as a line. A decision without a line is indistinguishable from a forgotten one.

- `<decision>` — `<why>` · reversible, rollback: `<cost>`

Lines from here travel into the PR body as an "Assumptions" block: the owner contests any of them with a single line.
Empty — then write "No assumptions".

## Do not touch

- `<files not part of the task>`
- `<other modules that might overlap>`

## Verification (Coder before `git push`)

After all edits:

1. `git diff HEAD --name-only` — only files from "Concrete changes"
2. For each AC: `grep -n "<expected pattern>" <file>` confirms presence
3. If UI — `mcp__playwright__browser_navigate` to the route + `browser_take_screenshot`
4. Commit message MUST contain:
   ```
   ac_verified: 1,2,3
   vision: ✓ /crm/<route>  # only for UI tasks
   ```
