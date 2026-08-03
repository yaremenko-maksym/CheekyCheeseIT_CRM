import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

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
      // security-review PR #456 round 2 ("форма F"): a relational `with: {...}`
      // traversal reaches raw `transactions` rows WITHOUT ever importing the
      // `transactions` table symbol — `projectsRelations`/`payoutRequestsRelations`
      // both declare a `transactions: many(transactions)` relation (schema.ts), so
      // `db.query.projects.findMany({ with: { transactions: true } })` is a live
      // path the import-ban above cannot see (there is no import to flag). No file
      // in this ban group uses a `transactions`-keyed relational include today
      // (verified: zero matches) — this is a preventive close, not a live-bug fix.
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
      ],
    },
  },
]
