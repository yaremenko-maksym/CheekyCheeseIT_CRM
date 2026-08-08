/**
 * Single source of truth for the test-quality rule set (task-lint-teeth, 2026-08-08).
 *
 * WHY THIS FILE EXISTS AT ALL, instead of the rules being pasted into each
 * package's `eslint.config.mjs`: five packages have tests, and a rule set
 * copy-pasted five times drifts. One package quietly loses a rule, nobody
 * notices, and we are back to hand-searching for vacuum tests — which is the
 * exact failure this task was opened to fix. Kept as plain rule maps rather
 * than a flat-config array so each package keeps full control over its own
 * `files`/`ignores`/parser wiring.
 *
 * The plugin objects are passed IN by the caller rather than imported here.
 * This file lives at the repo root, where the plugins are not direct
 * dependencies, so a top-level `import vitest from '@vitest/eslint-plugin'`
 * would resolve against the root's node_modules and break under pnpm's
 * strict, non-hoisted layout. Each package imports its own plugin copy and
 * hands it over; resolution stays package-local and honest.
 *
 * Severity is `error`, never `warn`, on purpose. A warning leaves the exit
 * code at 0, which means CI stays green while the defect ships — the same
 * "green but not actually checked" pathology these rules exist to catch.
 */

/**
 * Vitest — the four defects this session actually hit, plus the two adjacent
 * ones that share a root cause with them.
 *
 * Applies to: @crm/api, @crm/web, @crm/landing, @crm/shared.
 */
export const vitestTestQualityRules = {
  // A test body with no assertion at all. The headline defect: it cannot fail,
  // so it reports "passing" for code that was never exercised.
  'vitest/expect-expect': [
    'error',
    {
      // `assertX(...)` local helpers wrap the real `expect` in several specs;
      // without this they read as assertion-free to the rule.
      assertFunctionNames: ['expect', 'expect*', 'assert*', 'verify*'],
    },
  ],

  // An assertion reachable only through an `if`/`try`/`catch`. When the branch
  // is not taken the assertion never runs and the test still goes green — it
  // silently degrades into a no-op instead of failing.
  'vitest/no-conditional-expect': 'error',

  // An assertion outside any `it`/`test` block. It runs at collection time, so
  // the test it was meant to guard has no assertion of its own.
  'vitest/no-standalone-expect': 'error',

  // A malformed assertion: `expect(x).toBe` with the matcher never called,
  // `expect()` with no argument, a missing `await` on an async matcher. Reads
  // like a check, executes as nothing — the classic can't-fail test.
  'vitest/valid-expect': 'error',

  // `expect(promise).resolves...` whose promise is neither awaited nor
  // returned. The assertion resolves after the test has already passed, so a
  // rejection is reported against an unrelated test, or lost entirely.
  'vitest/valid-expect-in-promise': 'error',

  // A `describe` callback that is async or takes a done-callback: its body can
  // silently fail to register the tests inside it, and zero registered tests
  // also reports as green.
  'vitest/valid-describe-callback': 'error',
}

/**
 * Testing Library — the portal blindness.
 *
 * Applies to: @crm/web, @crm/landing.
 *
 * `container`-scoped queries were the concrete defect of 2026-08-07/08: Radix
 * renders a Dialog into a portal hung off `document.body`, NOT inside the
 * `container` node that `render()` returns. So `container.querySelector('script')`
 * inspects a subtree the dialog was never in, always finds nothing, and the
 * XSS-sanitisation assertion built on it passes with the sanitiser fully
 * removed. Three review rounds went into finding that by hand.
 */
export const testingLibraryTestQualityRules = {
  // Queries scoped to `container` / the render result instead of `screen`.
  // `screen` is bound to `document.body`, so it sees portalled content.
  'testing-library/prefer-screen-queries': 'error',

  // `container.querySelector(...)` and friends — the precise form the vacuum
  // test used. Distinct from the rule above, which only covers Testing Library
  // query methods; this one covers escaping into raw DOM through `container`.
  'testing-library/no-container': 'error',

  // Raw DOM traversal (`.querySelector`, `.firstChild`, `.children`) on any
  // node, not just `container`. Same blindness, one step removed.
  'testing-library/no-node-access': 'error',

  // An async query (`findBy*`) or event helper whose promise is not awaited:
  // the assertion runs before the DOM settles, so it passes on an empty tree.
  'testing-library/await-async-queries': 'error',
  'testing-library/await-async-utils': 'error',

  // `getBy*` inside `waitFor` for an element expected to be absent — passes
  // instantly for the wrong reason. `queryBy*` is the honest form.
  'testing-library/prefer-presence-queries': 'error',
}

/**
 * Playwright — same four defects, different runner.
 *
 * Applies to: @crm/e2e, whose 110 spec files had no linter at all.
 */
export const playwrightTestQualityRules = {
  'playwright/expect-expect': 'error',
  'playwright/no-conditional-expect': 'error',
  'playwright/no-standalone-expect': 'error',
  'playwright/valid-expect': 'error',
  'playwright/valid-expect-in-promise': 'error',
  'playwright/valid-describe-callback': 'error',

  // Playwright-specific: `expect(await locator.textContent()).toBe(...)`
  // resolves once with no retry, so it races the UI and is flaky-by-
  // construction. `expect(locator).toHaveText(...)` retries until timeout.
  'playwright/prefer-web-first-assertions': 'error',

  // `test.only` / `test.describe.only` left in a commit silently skips every
  // other spec in the file while still reporting a green run.
  'playwright/no-focused-test': 'error',
}
