/**
 * Regression test for the test-quality ESLint rules themselves (task-lint-teeth).
 *
 * WHY THIS EXISTS: on 2026-08-07/08 three review rounds were spent hand-hunting
 * tests that passed with the protection they claimed to test fully removed. The
 * eslint.test-rules.mjs rule set was added so a linter does that hunting from
 * now on. But a rule set is only load-bearing while it is actually wired in —
 * one bad merge to eslint.config.mjs and it silently stops firing, with every
 * gate still green. That is the exact failure mode this whole task was opened
 * to remove, so the rules get a test like any other guard.
 *
 * The headline case is the real, unedited pre-fix file from that session:
 * `fixtures/2026-08-07-JobSuggestionDialog.vacuum.tsx.txt` is
 * `apps/web/app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx`
 * exactly as it stood at commit c71f7fe2 on `feature/job-sourcing-slice1`
 * (`git show c71f7fe2:<path>`), before the fix landed. It is stored with a
 * `.txt` suffix so no runner, bundler or linter picks it up as live source.
 *
 * The defect in it: JobSuggestionDialog renders through a Radix Dialog, which
 * portals its content onto `document.body` — NOT into the `container` node that
 * `render()` returns. So `expect(container.querySelector('script')).toBeNull()`
 * interrogates a subtree the dialog was never in, finds nothing whatever the
 * markdown sanitiser did, and reports the XSS defence as working even when it
 * is entirely absent.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '../..')

/**
 * Lint `code` under the real apps/web flat config, as if it lived at `asPath`.
 * The path drives config matching, so this exercises the same `files:` block a
 * genuine test file in that directory would hit — no bespoke test-only config.
 */
async function lintAs(code: string, asPath: string) {
  const eslint = new ESLint({ cwd: webRoot })
  const [result] = await eslint.lintText(code, { filePath: resolve(webRoot, asPath) })
  return result?.messages ?? []
}

const rulesFired = (messages: Awaited<ReturnType<typeof lintAs>>) =>
  new Set(messages.filter((m) => m.severity === 2).map((m) => m.ruleId))

describe('test-quality lint rules', () => {
  describe('the real 2026-08-07 vacuum test (portal blindness)', () => {
    const vacuumSource = readFileSync(
      resolve(here, 'fixtures/2026-08-07-JobSuggestionDialog.vacuum.tsx.txt'),
      'utf8',
    )
    // Lint it back at its original home so the test-file config block applies.
    const asPath = 'app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx'

    it('is rejected — the container-scoped queries are flagged as errors', async () => {
      const messages = await lintAs(vacuumSource, asPath)
      const errors = messages.filter((m) => m.severity === 2)

      expect(errors.length).toBeGreaterThan(0)
      expect(rulesFired(messages)).toContain('testing-library/no-container')
    })

    it('flags the two assertions that were blind to the portal, by line', async () => {
      const messages = await lintAs(vacuumSource, asPath)

      // The exact defect: `container.querySelector(...)` inside an assertion
      // that was supposed to prove sanitisation. Both survive in the fixture.
      const containerLines = messages
        .filter((m) => m.ruleId === 'testing-library/no-container')
        .map((m) => m.line)
        .sort((a, b) => a - b)

      expect(containerLines).toEqual([148, 161])

      const sourceLines = vacuumSource.split('\n')
      expect(sourceLines[147]).toContain("expect(container.querySelector('script')).toBeNull()")
      expect(sourceLines[160]).toContain("expect(container.querySelector('img')).toBeNull()")
    })

    it('does NOT rely on no-node-access, which is exempt for this path', async () => {
      // Documents a real property of the config rather than asserting a rule we
      // do not actually enforce here. `eslint.config.mjs` turns
      // `testing-library/no-node-access` OFF for this file: its repaired,
      // present-day version asserts that an injected `<script>`/`<img>` was
      // never created, scoped to `document.body` precisely BECAUSE the dialog
      // portals there — and "no script element exists" has no accessible-query
      // form. `no-container`, asserted above, is the rule that actually catches
      // the vacuum test, and it stays ON for this path.
      //
      // If someone ever removes that exemption, this expectation flips and they
      // will be told to update it — which is the point: the test tracks the
      // config, it does not quietly assume it.
      const messages = await lintAs(vacuumSource, asPath)
      expect(rulesFired(messages)).not.toContain('testing-library/no-node-access')
      expect(rulesFired(messages)).toContain('testing-library/no-container')
    })

    it('accepts the screen-scoped form the fix replaced it with', async () => {
      // `screen` is bound to document.body, so it sees portalled content. This
      // is the shape the repaired file uses today; it must lint clean, or the
      // rule set would be punishing the correct pattern too.
      const fixed = [
        "import { render, screen } from '@testing-library/react'",
        "import { describe, expect, it } from 'vitest'",
        '',
        "describe('dialog', () => {",
        "  it('renders no script element', async () => {",
        '    render(null as never)',
        "    expect(await screen.findByTestId('job-suggestion-description')).toBeTruthy()",
        "    expect(screen.queryByTestId('injected-script')).toBeNull()",
        '  })',
        '})',
        '',
      ].join('\n')

      const messages = await lintAs(fixed, asPath)
      expect(messages.filter((m) => m.severity === 2)).toEqual([])
    })
  })

  describe('the other defects from that session', () => {
    const asPath = 'app/components/__tests__/sample.test.tsx'

    it('rejects a test with no assertion at all', async () => {
      const code = [
        "import { describe, it } from 'vitest'",
        '',
        "describe('thing', () => {",
        "  it('does something', () => {",
        '    const value = 1 + 1',
        '    void value',
        '  })',
        '})',
        '',
      ].join('\n')

      expect(rulesFired(await lintAs(code, asPath))).toContain('vitest/expect-expect')
    })

    it('rejects an assertion that only runs inside a conditional', async () => {
      const code = [
        "import { describe, expect, it } from 'vitest'",
        '',
        "describe('thing', () => {",
        "  it('checks something', () => {",
        '    const result: { ok: boolean; value?: number } = { ok: false }',
        '    if (result.ok) {',
        '      expect(result.value).toBe(42)',
        '    }',
        '  })',
        '})',
        '',
      ].join('\n')

      expect(rulesFired(await lintAs(code, asPath))).toContain('vitest/no-conditional-expect')
    })

    it('rejects an assertion outside any test block', async () => {
      const code = [
        "import { describe, expect, it } from 'vitest'",
        '',
        "describe('thing', () => {",
        '  expect(1).toBe(1)',
        '',
        "  it('has a real body', () => {",
        '    expect(2).toBe(2)',
        '  })',
        '})',
        '',
      ].join('\n')

      expect(rulesFired(await lintAs(code, asPath))).toContain('vitest/no-standalone-expect')
    })

    it('rejects a malformed assertion whose matcher is never called', async () => {
      // `.toBe` referenced but not invoked: reads like a check, executes as
      // nothing, and the test can never fail.
      const code = [
        "import { describe, expect, it } from 'vitest'",
        '',
        "describe('thing', () => {",
        "  it('pretends to check', () => {",
        '    expect(1)',
        '  })',
        '})',
        '',
      ].join('\n')

      expect(rulesFired(await lintAs(code, asPath))).toContain('vitest/valid-expect')
    })
  })
})
