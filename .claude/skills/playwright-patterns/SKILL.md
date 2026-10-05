---
name: playwright-patterns
description: 'When AutoTest or Coder writes Playwright E2E / flow tests for the CRM (apps/e2e). Contains a CRM-specific cookbook on top of ECC playwright knowledge: strict-mode resolution, radix-radio async submit, retries policy, testid conventions, screenshot hygiene. Use before every new spec.ts file and when diagnosing flaky tests.'
when_to_use: "Use when AutoTest or Coder writes or edits a Playwright .spec.ts in apps/e2e, or diagnoses a flaky E2E. Examples: 'writing E2E for a new page', 'getByRole does not find it', 'strict-mode violation', 'radix radio submit is flaky', 'the test is unstable in CI', 'need a data-testid for the spec'."
allowed-tools:
  - Read
  - Edit
  - Grep
  - Glob
  - mcp__playwright__*
---

# Playwright Patterns (CRM)

A custom cookbook on top of the ECC playwright slot. The CRM uses Playwright @1.40+, Radix UI, mock-based fixtures (`apps/e2e/tests/fixtures/`). Lessons lifted from `.claude/agents/memory/autotest/lessons.md` + `coder/lessons.md` (2026-05-19 — 2026-06-02).

## When to invoke

- Before writing a new `.spec.ts` in `apps/e2e/tests/`
- Before editing an existing spec if UI texts / role labels change
- When investigating a flaky test (CI fail, passes locally)
- When working with Radix components (Dialog, RadioGroup, Select, DropdownMenu)
- When fixing strict-mode locator errors
- Before adding a `data-testid` to a new component (see the naming convention below)

## Patterns

### 1. Strict-mode + `getByText` — conflict with descriptive texts

**Rule:** `getByText('...')` without `exact: true` fails strict mode if the new descriptive text matches as a substring with an existing role `<label>` (rendered from the uk/en catalog). Real incident: adding a descriptive hint that mentioned a role (a senior's team with its HR and accountant) to a RadioGroup broke `users.spec.ts` because an existing role label matched as a substring.

**Decision rule:**

- Before adding words that name a role (the `ADMIN` / `SENIOR` / `JUNIOR` / `HR` / `ACCOUNTANT` labels) to a new helper text — `grep -rn "getByText" apps/e2e/tests/*.spec.ts` to check for conflicts.
- If the conflict is unavoidable — select by `data-testid` (`getByTestId(...)`) or by role with the catalog descriptor (`getByRole('...', { name: i18n._(...) })`), not by a raw substring.
- In the spec, too, prefer `getByTestId(...)` / `getByRole('button', { name: i18n._(...) })` over `getByText('X')` for UI elements.

### 2. Radix RadioGroupItem + async submit — flaky POST verification

**Rule:** In a mock-based E2E, a dialog submit button with Zod `safeParse` often silently falls into `toast.error` due to a race between the Radix `RadioGroupItem` click and the form.state update. The POST-body test `JOIN_DROP_TEAM` was flaky on CI.

**Decision rule:**

- Instead of `waitForRequest(POST)`, test the UI contract: "selecting the radio surfaces the drop-team picker", "toast.success appeared".
- The full shape of the POST body belongs on Vitest unit tests (Coder zone), not E2E.
- If the POST body is genuinely needed in E2E:
  1. Fill ALL fields before the radio.
  2. Click the `label` (not `radio.click()`).
  3. Do NOT place `waitForRequest` BEFORE the submit click — race condition.

### 3. CI retries policy

**Rule:** On GHA — `retries: 2` under `CI=1`. Locally retries=0 (we see the flake right away).

**Source:** `apps/e2e/playwright.config.ts` section `retries: process.env.CI ? 2 : 0`. Real incident 2026-05-30: 4 tests (team-redirect, team-empty, finance-flow, tech-autocomplete) on the default local matrix failed due to a parallel race with TEAMS fixtures extensions. Under CI=1 retry they all passed. For local dev — the flake is acceptable, the GHA shard will close it.

### 4. data-testid convention

**Rule:** `data-testid` is MANDATORY for:

- back-button / dialog-close / cancel-button (Playwright strict mode fails on duplicates with sidebar/content nav elements)
- submit / confirm buttons in dialogs
- form fields (especially autocomplete / combobox)

**Naming:**

- `kebab-case` always.
- Component prefix: `team-form-submit`, `archive-confirm-input`.
- Do not use role words in `data-testid` if they are already in the UI text (avoid the conflict with getByText).

### 5. Two archive-confirm dialogs

**Rule:** The CRM has TWO different archiving components:

| Component                                 | testids                                                                | Usage                  |
| ----------------------------------------- | ---------------------------------------------------------------------- | ---------------------- |
| `components/users/ArchiveConfirmDialog`   | `archive-confirm-dialog`                                               | User archive           |
| `components/archive/ArchiveConfirmDialog` | `archive-confirm-input` + `archive-confirm-submit` (NO wrapper testid) | Team / project archive |

When writing a spec — determine exactly which component renders. Do NOT copy testids between them.

### 6. Screenshot hygiene

**Rule:** Debug screenshots — in `/tmp/autotest-<runid>/`, **NOT** in `apps/e2e/`. Others' commits later sweep them via `git add .`.

**Implementation:**

```ts
const runId = process.env.GITHUB_RUN_ID || Date.now()
const debugDir = `/tmp/autotest-${runId}`
await page.screenshot({ path: `${debugDir}/team-form.png` })
```

### 7. Atomicity of UI text + spec

**Rule:** When changing UI texts — update the selectors in `spec.ts` IN THE SAME commit as the UI. A mismatch → a flaky E2E on main.

**Mechanism:** The Coder, in a "change UI text" task, includes 2 files in the diff (component.tsx + spec.ts) or explicitly notes in the task that the spec was also updated.

### 8. Interaction tests for autocomplete / combobox

**Rule (for Vitest, but relevant as context):** Interaction tests are mandatory for autocomplete/combobox/dropdown — `Tab + ArrowDown` committing the highlighted option must be a unit test, not only Enter. The smoke test "Enter adds" missed the Tab bug in TechAutocomplete.

**E2E side:** Do not rely on "type X → submit". Verify that the choice happens via keyboard navigation (`page.keyboard.press('ArrowDown')` + `Enter`) + via mouse click — both paths.

### 9. userEvent setup for unit testing (cross-reference)

**Rule (Vitest+RTL):** `userEvent.setup({ delay: null })` stabilizes tests — otherwise race conditions with `act()` warnings.

Apply in all Vitest interaction tests (by default).

### 10. Text in assertions — from the catalog, not as a literal (i18n, since 2026-09-19)

**Rule (E2E and Vitest):** elements are found by `data-testid` and roles; where text is needed, the string is taken
from the `uk` catalog (`i18n._(descriptor)` / importing the descriptor), not written as a literal. Changing the wording
or the language must not redden the tests. A `data-testid` is not built from translatable text (incident
`pending-kind-heading-<zone>-<title>`, i18n audit §2).

## Anti-patterns

| ❌ Don't                                                   | ✅ Do                                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `page.getByText(<raw role label>)` for a button click      | `page.getByTestId(...)` or `page.getByRole('button', { name: i18n._(ROLE_LABELS.ACCOUNTANT) })` — text from the catalog |
| `radio.click()` + immediate `waitForRequest(POST)`         | Click label → wait for UI contract (toast/visible field) → assertions without waitForRequest                            |
| Debug screenshots in `apps/e2e/debug-*.png` in the repo    | `/tmp/autotest-<runid>/*.png` (git-ignored)                                                                             |
| UI text change without a spec.ts update in the same commit | Atomic commit: component.tsx + spec.ts together                                                                         |
| `it.skip('...flaky...')` to skip an unstable test          | Isolate the root cause (race / timing / async) + add a retry in the config                                              |
| `--no-verify` to shove through a push with a failing E2E   | Run the test in isolation, add `it.retry(2)` locally, push without --no-verify                                          |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/autotest/lessons.md` (2026-05-18 — 2026-05-30)
  - `.claude/agents/memory/coder/lessons.md` (2026-05-19, 2026-05-21, 2026-05-30, 2026-06-02 lines on testids / strict-mode / no-verify ban)
- Project config: `apps/e2e/playwright.config.ts`, `apps/e2e/tests/fixtures/`
- Related agent docs:
  - `.claude/agents/autotest.md` section "Anti-patterns" (Phase 4 will be cleaned up in favor of this skill)
  - `.claude/agents/coder.md` §6.1 (testids checklist by component type)
- Related skills:
  - `dev-flow-resilience` (for E2E + watchdog interaction)
  - `superpowers:test-driven-development`, `superpowers:systematic-debugging`
