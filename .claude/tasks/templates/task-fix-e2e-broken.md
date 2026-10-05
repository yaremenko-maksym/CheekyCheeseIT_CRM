# task-fix-e2e-broken (auto-generated)

## Agent: autotest

## Priority: CRITICAL

## Branch: fix/e2e-auto-{{timestamp}}

## Context

E2E tests failed on main. This task was created automatically by the watchdog.
CI Run: {{run_url}}
Commit: {{sha}}

## Task

1. Read `apps/e2e/tests/` — all spec files
2. Run playwright locally (or study the CI logs from the artifacts)
3. Find all failed tests — determine the cause (did the UI or the code change?)
4. Fix the tests — update locators, adapt to the current UI
5. Do NOT change business logic — only fix the tests

## Acceptance criteria

- [ ] All tests in apps/e2e/tests/ pass
- [ ] Branch pushed, PR created
