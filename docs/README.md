# Docs — Multi-Agent Development System

This folder is the operational base for all AI agents and humans working on the CRM.

## Structure

```
docs/
├── business/           # Business logic, user flows, user stories
│   ├── overview.md     # Business model and roles
│   ├── user-flows.md   # User flow diagrams
│   ├── user-stories.md # User stories for all modules
│   └── modules/        # Detailed documentation of each module
├── specs/
│   ├── active-task.md  # CURRENT task for the Coder agent (1 file at a time)
│   └── archive/        # Completed tasks (moved here after merge)
├── test-cases/
│   └── e2e-scenarios.md # E2E test scenarios (the AutoTest agent writes tests from here)
├── escalations/        # Bugs/inconsistencies found by QA after merge into main
└── agents/             # System prompts of each agent
    ├── ../business/roles/ba.md  # Business Analyst (human role, moved out in Phase 6)
    ├── coder.md        # Coder
    ├── code-reviewer.md     # Code Reviewer
    ├── security-reviewer.md # Security Reviewer
    ├── manual-qa.md    # QA Manual Tester
    ├── devops.md       # DevOps
    └── autotest.md     # AutoTest
```

## Agent workflow

```
User describes a feature
        ↓
   BA agent (local)
   - asks questions
   - writes docs/business/
   - creates .claude/briefs/active-task.md
        ↓
 ┌──────────────────────────────┐
 │ Coder agent  │ AutoTest agent│
 │ (PR branch)   │ (tests)       │
 └──────────────────────────────┘
        ↓ (PR opened + label: ai-review-ready)
 ┌──────────────────────────────────┐
 │ Reviewer (GitHub Actions)        │
 │ QA Manual (GitHub Actions + app) │
 └──────────────────────────────────┘
        ↓ (both APPROVE + status checks green)
   Auto-merge into main
```

## How to create a task for the Coder agent

1. Run the BA agent locally in Claude Code
2. BA writes `.claude/briefs/active-task.md` from the template
3. Coder reads the file, creates branch `feature/<slug>`, opens a PR
4. Add label `ai-review-ready` → Reviewer + QA will start

## How to read agent prompts

Each `.claude/agents/*.md` is the system prompt for the corresponding agent.
The agent ALWAYS reads it first, before any work.
