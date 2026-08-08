import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import vitest from '@vitest/eslint-plugin'
import testingLibrary from 'eslint-plugin-testing-library'

import { testingLibraryTestQualityRules, vitestTestQualityRules } from '../../eslint.test-rules.mjs'

export default [
  {
    ignores: ['dist/**', 'app/routeTree.gen.ts'],
  },
  {
    files: ['app/**/*.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  {
    // Same glob as vitest.config.ts `test.include`, so the linter's idea of
    // "this is a test file" cannot drift from the runner's.
    files: ['app/**/*.{spec,test}.{ts,tsx}'],
    plugins: {
      vitest,
      'testing-library': testingLibrary,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: vitest.environments.env.globals,
    },
    rules: {
      ...vitestTestQualityRules,
      ...testingLibraryTestQualityRules,
    },
  },
  {
    /**
     * `testing-library/no-node-access` — narrow, per-file exemptions.
     *
     * The rule stays ON for every other test in this package; these six files
     * assert on things that NO Testing Library query can reach, so the rule
     * cannot be satisfied here without deleting the assertion. Kept as one
     * reviewable list rather than ~40 scattered inline disables: adding a file
     * here is a visible act in a diff, whereas an inline disable in a 400-line
     * spec is not. The sibling rules — `no-container` and
     * `prefer-screen-queries`, the two that actually caught the 2026-08-07
     * portal-blindness defect — remain ON for every file below.
     *
     * Each entry is exempt for a stated, structural reason:
     */
    files: [
      // XSS/sanitisation assertions against a Radix Dialog. These queries are
      // deliberately scoped to `document.body` BECAUSE the dialog portals
      // there — this file is the repaired version of the very test that used
      // `container` and was blind to the portal (see
      // app/test/test-quality-rules.spec.ts). An injected `<script>` has no
      // ARIA role and no accessible name by definition; "no script element was
      // created" is not expressible as a screen query.
      'app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx',
      // Same class: proves a receipt panel never renders `<object>`/`<iframe>`
      // and never emits a `javascript:` or `data:` href. Absence-of-a-dangerous-
      // element checks have no accessible-query form.
      'app/routes/_authenticated/finance/components/dialogs/__tests__/receipt-panel.test.tsx',
      // Rendered-markdown structure: `<mark class="preview-token-…">` spans and
      // the table cells around them. Token highlighting is a class contract, and
      // a `<mark>` carries no role.
      'app/routes/_authenticated/admin/__tests__/contracts-editor-layout.test.tsx',
      // Visual state asserted through utility classes (active pill background,
      // shadow). There is no accessible surface for "this button is painted with
      // bg-primary" — the a11y state (aria-pressed/aria-selected) is asserted
      // separately in the same file, by role.
      'app/components/ui/__tests__/segmented-toggle.test.tsx',
      // SVG internals (`<polyline>` vs `<path>`) of a sparkline. SVG shape
      // elements are presentational and expose no queryable role.
      'app/routes/_authenticated/routing/components/__tests__/EarningsSparkline.test.tsx',
      // Walks up from a label to its surrounding card to read the card's text.
      // The card is a plain styled `<div>` with no role and no testid; giving it
      // one would be a product change, which this task is explicitly barred from
      // making (see task-lint-teeth "Границы"). Flagged in the PR body as the
      // one entry here that a follow-up could remove.
      'app/components/user-profile/tabs/__tests__/OverviewTab.share-card.test.tsx',
    ],
    plugins: {
      'testing-library': testingLibrary,
    },
    rules: {
      'testing-library/no-node-access': 'off',
    },
  },
]
