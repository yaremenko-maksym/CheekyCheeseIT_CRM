import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import vitest from '@vitest/eslint-plugin'

import { vitestTestQualityRules } from '../../eslint.test-rules.mjs'

export default [
  {
    ignores: ['dist/**'],
  },
  {
    files: ['src/**/*.ts'],
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
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  {
    // security-review PR #456 round 2 (verdict BLOCK, 4834458611/4840207923):
    // "eliminate, don't detect". A raw read of the `transactions` table that
    // forgets to exclude a soft-deleted row was demonstrated in THREE modules
    // outside `finance/**` (invoices, company-account, documents) — a text
    // scanner meant to catch a forgotten filter was defeated 7/7 with
    // realistic variants. `documents/`, `admin/`, `projects/` no longer have
    // ANY legitimate need for the raw table after the fix (every read there
    // was converted to `nonDeletedTransactions`, a Postgres VIEW pre-filtered
    // to `deleted_at IS NULL` — see schema.ts's doc on the view) — so the
    // import itself is banned here, at the AST level, immune to every
    // syntactic form the text scanner missed (`.rightJoin`, `alias()`, raw
    // `sql` templates, nested relational `with: {...}` reads all still
    // require this import to exist somewhere in the file). `invoices/` and
    // `finance/**` keep legitimate raw access (single-row reads that must
    // stay visible to ADMIN/ACCOUNTANT after a soft-delete, and idempotency-
    // by-hash lookups) — those route through `transaction-visibility.util.ts`
    // instead (fetch + guard fused into one call, so the round-2-demonstrated
    // "delete just the guard" bypass no longer has a line to delete).
    // Spec files are exempt — real-DB integration specs legitimately insert
    // `transactions` rows directly to seed fixtures.
    files: ['src/documents/**/*.ts', 'src/admin/**/*.ts', 'src/projects/**/*.ts'],
    ignores: ['**/*.spec.ts'],
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
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/database/schema'],
              importNames: ['transactions'],
              message:
                'Raw `transactions` table access is banned outside apps/api/src/finance/** ' +
                '(security-review PR #456 round 2) — a soft-deleted row must never leak through ' +
                'a forgotten filter in another module. Import `nonDeletedTransactions` (the VIEW) ' +
                'for list/aggregate/join reads instead — see schema.ts for why.',
            },
          ],
        },
      ],
      // security-review PR #456 round 2 ("форма F") + round 3 (MED-1): TWO
      // separate ways to reach raw `transactions` rows WITHOUT ever importing
      // the `transactions` table symbol, so the import-ban above cannot see
      // either one — it can only flag an import statement, and neither of
      // these needs one:
      //
      //   1. Relational include: `projectsRelations`/`payoutRequestsRelations`
      //      both declare `transactions: many(transactions)` (schema.ts), so
      //      `db.query.projects.findMany({ with: { transactions: true } })`
      //      reaches the raw table through the relation's STRING key, not an
      //      import (round 2, "форма F").
      //   2. Drizzle relational query API property access:
      //      `db.query.transactions.findMany({})` needs `db` (already
      //      imported everywhere) and nothing else — `.transactions` is a
      //      property lookup on `db.query`, not a symbol import. Round 3's
      //      review reproduced this LIVE against this exact rule (0 errors,
      //      compiles clean) and confirmed it is the MORE likely regression
      //      path of the two, not the less likely one: the idiom already
      //      lives in ~30 call sites across this codebase (e.g.
      //      `invoices.service.ts:650`), and `projects.service.ts` read this
      //      exact way before this PR (see the "round-1 sugar" comment in
      //      `admin-summary.service.ts`).
      //
      // No file in this ban group uses either form today (verified: zero
      // matches for both) — this closes two reachable paths, not two live
      // bugs. Known residuals, NOT closed by either selector below (same tier
      // as the honestly-documented raw-SQL-literal residual, "форма E" —
      // dynamic `import('../database/schema')` then `.transactions`, and a
      // re-export of `transactions` from a non-banned module re-imported
      // under a different name): both require the same deliberate,
      // Drizzle-convention-breaking effort as форма E, and neither has ever
      // appeared in this codebase.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='transactions']",
          message:
            'A relational `with: { transactions: ... }` include reaches raw, ' +
            'unfiltered transaction rows without importing the `transactions` symbol — ' +
            'the import-ban above cannot see it (security-review PR #456 round 2, "форма F"). ' +
            'Banned here for the same reason: use `nonDeletedTransactions` via an explicit ' +
            'query-builder select/join instead of a relational traversal into this table.',
        },
        {
          selector: "MemberExpression[property.name='transactions']",
          message:
            'A `.transactions` property access (e.g. `db.query.transactions.findMany(...)`) ' +
            'reaches raw, unfiltered transaction rows without importing the `transactions` ' +
            'symbol at all — the import-ban above cannot see it (security-review PR #456 ' +
            'round 3, MED-1). Use `nonDeletedTransactions` via an explicit query-builder ' +
            'select/join instead of the relational query API for this table.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.spec.ts'],
    plugins: {
      vitest,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: vitest.environments.env.globals,
    },
    rules: vitestTestQualityRules,
  },
]
