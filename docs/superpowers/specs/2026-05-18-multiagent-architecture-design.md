# Multi-Agent Architecture Design

**Date:** 2026-05-18
**Status:** Approved

---

## Context

The CheekyCheeseIT CRM project has a working AI pipeline (BA, Coder, AutoTest, Reviewer, DevOps).
The goal — add a PM agent as the central orchestrator, parallel task dispatch, an explicit E2E gate, a User Testing stage, and simplify the escalation chain.

---

## Section 1: Composition of the agent team

| Agent                    | Where it lives | Writes                                                            | Reads                                            | Superpowers skills                                                                                                                    |
| ------------------------ | -------------- | ----------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Master (Claude Code)** | Locally        | Everything                                                        | —                                                | All                                                                                                                                   |
| **BA**                   | Locally        | `docs/business/`, `docs/specs/pm-brief.md`                        | `apps/` via Playwright                           | `brainstorming`, `writing-plans`                                                                                                      |
| **PM**                   | Locally        | `docs/specs/tasks/`, `docs/specs/pm-state.json`, `docs/business/` | `pm-brief.md`, the whole repo                    | `writing-plans`, `executing-plans`, `dispatching-parallel-agents`, `brainstorming`                                                    |
| **Coder**                | GHA            | `apps/`, `packages/`, `task-xxx.blocked.md`                       | `docs/specs/tasks/task-xxx.md`, `docs/business/` | `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `frontend-design`, `simplify`, `security-review` |
| **AutoTest**             | GHA            | `apps/e2e/`, `task-xxx.blocked.md`                                | task file, `docs/business/`                      | `test-driven-development`, `systematic-debugging`, `verification-before-completion`                                                   |
| **DevOps**               | GHA            | `.github/workflows/`, `docker-compose.yml`, `task-xxx.blocked.md` | task file                                        | `writing-plans`, `verification-before-completion`, `systematic-debugging`                                                             |
| **Reviewer**             | GHA            | review comments                                                   | everything in the PR                             | `code-review`, `receiving-code-review`, `security-review`                                                                             |
| ~~QA~~                   | **archived**   | —                                                                 | —                                                | —                                                                                                                                     |

**All agents have access to all MCP:** ast-grep, context7, postgres, eslint, playwright, github.

### BA ↔ PM separation

```
BA  →  high-level brief + business rules  →  docs/specs/pm-brief.md
PM  →  breakdown into tasks + RBAC + API + DB  →  docs/specs/tasks/task-xxx.md
PM  →  after User Testing and merge: analyzes review comments → updates docs/business/
```

**BA** — a professional consultant. Works with the user only before development starts. Does not participate in the development process, does not receive escalations.

**PM** — details the brief, watches the agents, resolves conflicts with the user directly, keeps `docs/business/` up to date.

---

## Section 2: Task file system and PM state

### Directory structure

```
docs/specs/
├── pm-brief.md                      # BA → PM: the high-level brief
├── pm-state.json                    # PM state machine
├── tasks/
│   ├── task-auth-api.md             # a task for Coder
│   ├── task-auth-api.blocked.md     # a blocker (if found by an agent)
│   ├── task-auth-ui.md              # a parallel task for Coder
│   ├── task-e2e-auth.md             # a task for AutoTest
│   └── task-infra-redis.md          # a task for DevOps
└── archive/
    └── 2026-05-18-auth-feature/     # completed tasks
```

### `pm-brief.md` format (written by BA)

```markdown
# Brief: <feature name>

## Business context

## Business rules

## RBAC

## Known collisions

## Acceptance criteria (high level)

## What is NOT in scope
```

### `task-xxx.md` format (written by PM)

```markdown
# task-auth-api

## Agent: coder | autotest | devops

## Priority: high | medium | low

## Depends on: task-xxx (optional)

## Context

## Specific changes (files + what to do)

## API endpoints

## DB schema

## RBAC details

## Acceptance criteria

## Forbidden
```

### `task-xxx.blocked.md` format (written by an agent)

```markdown
# BLOCKER: task-auth-api

## Agent: coder

## Task: docs/specs/tasks/task-auth-api.md

## GHA Run ID: 12345678

## Problem

## Affected code

## Question for the user

## What was done before the blocker
```

### `pm-state.json` format

```json
{
  "feature": "auth-google-phase2",
  "brief": "docs/specs/pm-brief.md",
  "started_at": "2026-05-18T10:00:00Z",
  "tasks": [
    {
      "id": "task-auth-api",
      "file": "docs/specs/tasks/task-auth-api.md",
      "agent": "coder",
      "workflow": "coder.yml",
      "run_id": "12345678",
      "branch": "feature/auth-api",
      "pr_number": null,
      "status": "running",
      "started_at": "2026-05-18T10:02:00Z",
      "expected_duration_min": 12
    }
  ],
  "blocked": [],
  "merged": [],
  "next_wakeup": "2026-05-18T10:16:00Z",
  "phase": "development"
}
```

**Task statuses:** `queued` → `running` → `pr_open` → `awaiting-pm-review` → `user-testing` → `e2e_running` → `merged` | `blocked` | `failed`

### PM Lifecycle — 4 modes

**Mode 1 — Start of a new feature:**

```
① Read pm-brief.md
② Check pm-state.json — is there unfinished work
③ skill: writing-plans — decompose into tasks
④ Create docs/specs/tasks/task-xxx.md for each task
⑤ Launch independent tasks in parallel:
   gh workflow run coder.yml -f task_file=... -f task_hint=...
   gh workflow run devops.yml -f task_file=... -f task_hint=...
⑥ Write pm-state.json (run_id, branches, expected_duration)
⑦ ScheduleWakeup(delay = max(expected_duration) + 2min)
```

**Mode 2 — Monitoring (wakeup):**

```
① Scan docs/specs/tasks/*.blocked.md
   → ask the user directly
   → get the answer → update docs/business/ → delete .blocked.md
   → gh workflow run [agent].yml -f task_file=... (restart)

② gh run list → update statuses in pm-state.json:
   running             → wait
   failed              → read the log → fix-task → restart
   pr_open             → check the review status
   awaiting-pm-review  →
     Read the review comments via GitHub MCP
     Update docs/business/ if needed
     → Mode 4 (User Testing)

③ Check e2e.yml runs:
   pass → PR merged → tasks to archive/ → update pm-state.json
   fail → read artifacts → task-fix-e2e-xxx.md
          → gh workflow run coder.yml / autotest.yml
          → gh workflow run ai-review.yml -f pr_number=X

④ All tasks merged?
   No  → ScheduleWakeup(next interval, max 15 min)
   Yes → final report to the user + archive pm-state.json
```

**Mode 3 — Resume after a break:**

```
① Read pm-state.json → restore the context
② Go to Mode 2
```

**Mode 4 — User Testing:**

```
① pnpm dev (run the project locally)
② Describe to the user in text:
   - What is implemented in this PR
   - Where to look in the UI (section, route)
   - A concrete list of what to check
③ Wait for the user's response
④ APPROVE → gh workflow run e2e.yml -f pr_number=X
   EDITS → skill: brainstorming → classify each edit:
     UI bug / visual       → task-fix-ui.md → Coder (+ frontend-design skill)
     Logic is wrong        → update docs/business/ → task-fix-logic.md → Coder
     New scope             → clarify with the user: this PR or a new task?
     Test does not cover   → task-fix-test.md → AutoTest
     Several edits         → several task files → parallel launch
   → agents push to the same PR branch →
   → gh workflow run ai-review.yml -f pr_number=X →
   → APPROVE → PM analysis → User Testing again
```

---

## Section 3: Changes in workflows

### Parallel dispatch — `coder.yml` and `devops.yml`

**New input `task_file`:**

```yaml
inputs:
  task_file:
    description: 'Path to task file (e.g. docs/specs/tasks/task-auth-api.md)'
    required: true
    type: string
  task_hint:
    description: 'Short hint for branch name'
    required: false
    type: string
```

**New concurrency key:**

```yaml
concurrency:
  group: coder-${{ inputs.task_file }}
  cancel-in-progress: false
```

**In `direct_prompt`:** read `${{ inputs.task_file }}` instead of `docs/specs/active-task.md`.

PM launches in parallel:

```bash
gh workflow run coder.yml -f task_file="docs/specs/tasks/task-auth-api.md" -f task_hint="auth-api"
gh workflow run coder.yml -f task_file="docs/specs/tasks/task-auth-ui.md"  -f task_hint="auth-ui"
gh workflow run devops.yml -f task_file="docs/specs/tasks/task-infra-redis.md" -f task_hint="redis"
```

### `ai-review.yml` — updated structure

**Jobs:**

```
autotest → reviewer → trigger_coder  (REQUEST_CHANGES)
                  └→ label awaiting-pm-review + stop  (APPROVE)
```

- Job `merge` — **removed entirely**
- Job `e2e` — **not added to ai-review.yml**
- After APPROVE: add the label `awaiting-pm-review` to the PR, update the pipeline status, stop

**`trigger_coder` job** — passes `task_file` from `pm-state.json` via a branch → task_file mapping.

### New `e2e.yml` — launched only by the PM

```yaml
on:
  workflow_dispatch:
    inputs:
      pr_number: { required: true, type: string }

jobs:
  e2e:
    services:
      postgres: { image: postgres:16 }
      redis: { image: redis:7 }
    steps:
      - checkout PR branch
      - pnpm install
      - db:migrate + db:seed
      - start API + Web (background, wait-on)
      - pnpm --filter @crm/e2e test
      - upload artifacts on failure

  merge:
    needs: [e2e]
    if: needs.e2e.result == 'success'
    steps:
      - gh pr merge --squash
```

**E2E fail loop:**

```
PM reads artifacts → task-fix-e2e-xxx.md →
gh workflow run coder.yml / autotest.yml (fix in the same branch) →
gh workflow run ai-review.yml -f pr_number=X →
APPROVE → PM → gh workflow run e2e.yml → repeat
```

### Pre-commit (Coder)

Coder runs before a commit only:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Full E2E — only via `e2e.yml`.

---

## Section 4: System prompts

### `docs/agents/pm.md` — structure

**Mandatory reading at startup:**

1. `docs/agents/CLAUDE-pm.md` — phase status, typical durations, secrets
2. `docs/specs/pm-brief.md` — the brief from BA
3. `docs/business/overview.md` — the business model
4. `docs/specs/pm-state.json` — if it exists (resume)

**4 working modes:** (described in Section 2 above)

**PM tools:**

| Task                  | Tool                                                |
| --------------------- | --------------------------------------------------- |
| Decomposition         | skill: `writing-plans`                              |
| Parallel dispatch     | skill: `dispatching-parallel-agents`                |
| Requirements analysis | skill: `brainstorming`                              |
| Plan execution        | skill: `executing-plans`                            |
| Launch/monitor GHA    | `Bash: gh workflow run / gh run list / gh run view` |
| Reading reviews       | `mcp__github__get_pull_request_reviews`             |
| Reading comments      | `mcp__github__get_pull_request_comments`            |
| Managing labels       | `gh pr edit --add-label / --remove-label`           |
| Updating docs         | `Write / Edit`                                      |
| Wakeup                | `ScheduleWakeup`                                    |

**Write zones:**

- ✅ `docs/specs/tasks/` — tasks
- ✅ `docs/specs/pm-state.json` — state
- ✅ `docs/business/` — when resolving conflicts and after merge
- ❌ `apps/`, `packages/` — developers only
- ❌ `.github/workflows/` — DevOps only

### `docs/agents/ba.md` — changes

| Before                             | After                                           |
| ---------------------------------- | ----------------------------------------------- |
| Writes `docs/specs/active-task.md` | Writes `docs/specs/pm-brief.md`                 |
| Launches Coder directly            | Hands the brief to PM                           |
| Participates in acceptance         | Does not participate in the development process |
| Receives escalations from QA       | Escalations go PM → user                        |

**Stays:** Playwright MCP for UI inspection, collision checking, user consultation.

### Agents — skills and MCP update

**All agents receive:**

- Access to all MCP (ast-grep, context7, postgres, eslint, playwright, github)
- The corresponding role Superpowers skills (see Section 1)
- The `.blocked.md` mechanism in the system prompt

---

## Section 5: Full list of files

### CREATE

| File                                | What it is                            |
| ----------------------------------- | ------------------------------------- |
| `docs/agents/pm.md`                 | The PM system prompt                  |
| `docs/agents/CLAUDE-pm.md`          | Context: phases, durations, secrets   |
| `docs/specs/tasks/.gitkeep`         | Initialization of the tasks directory |
| `docs/specs/tasks/archive/.gitkeep` | Archive of completed tasks            |
| `.github/workflows/e2e.yml`         | The new E2E workflow                  |

### MODIFY

| File                              | What changes                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `.github/workflows/coder.yml`     | `task_file` input; new concurrency key; read from `task_file`                            |
| `.github/workflows/devops.yml`    | The same                                                                                 |
| `.github/workflows/autotest.yml`  | `task_file` input for Mode 2                                                             |
| `.github/workflows/ai-review.yml` | Remove the `merge` job; after APPROVE → label `awaiting-pm-review`; drop E2E             |
| `docs/agents/ba.md`               | `pm-brief.md` instead of `active-task.md`; remove acceptance and escalations; Playwright |
| `docs/agents/CLAUDE-ba.md`        | Update the escalation paths                                                              |
| `docs/agents/coder.md`            | Skills + `.blocked.md` + all MCP + read `task_file`                                      |
| `docs/agents/autotest.md`         | Skills + `.blocked.md` + all MCP                                                         |
| `docs/agents/reviewer.md`         | Skills + `awaiting-pm-review` signal + all MCP                                           |
| `docs/agents/devops.md`           | Skills + `.blocked.md` + all MCP + `task_file`                                           |
| `CLAUDE.md`                       | PM in the architecture; update the active context                                        |

### ARCHIVE

| From                               | To                                                    |
| ---------------------------------- | ----------------------------------------------------- |
| `docs/agents/qa.md`                | `docs/agents/archive/qa.md`                           |
| `docs/agents/CLAUDE-qa.md`         | `docs/agents/archive/CLAUDE-qa.md`                    |
| `docs/specs/active-task.md`        | `docs/specs/archive/YYYY-MM-DD-active-task.md`        |
| `docs/specs/active-devops-task.md` | `docs/specs/archive/YYYY-MM-DD-active-devops-task.md` |

### DELETE

| File                                  | Reason                                           |
| ------------------------------------- | ------------------------------------------------ |
| `.github/workflows/ba-escalation.yml` | PM → user directly, a GitHub Issue is not needed |

### Implementation order

```
1. e2e.yml (new) + tasks/ directory
2. coder.yml + devops.yml (task_file parameter + concurrency)
3. ai-review.yml (remove merge, add awaiting-pm-review)
4. pm.md + CLAUDE-pm.md
5. ba.md + CLAUDE-ba.md
6. coder.md + autotest.md + reviewer.md + devops.md
7. CLAUDE.md
8. Archive QA + old spec files
9. Delete ba-escalation.yml
```

---

## Final full pipeline

```
User + BA → pm-brief.md
PM (Mode 1) → task-*.md → gh workflow run [in parallel]
  ↓
  [Coder] [DevOps] [AutoTest Mode 2]  ← in parallel
  ↓
  PR + label ai-review-ready
  ↓
  ai-review.yml:
    AutoTest (writes E2E test code to the branch) →
    Reviewer →
      REQUEST_CHANGES → trigger_coder → agent fixes → ai-review again
      APPROVE → label awaiting-pm-review → stop
  ↓
PM (Mode 2) wakes up →
  reads review comments → updates docs/business/
  ↓
PM (Mode 4) User Testing →
  pnpm dev → describes what to test →
  user APPROVE → gh workflow run e2e.yml
  EDITS → task-fix-*.md → agents → ai-review → User Testing again
  ↓
e2e.yml:
  ✅ pass → squash merge
  ❌ fail → PM fix loop → e2e again
  ↓
PM archives tasks → final report to the user
```
