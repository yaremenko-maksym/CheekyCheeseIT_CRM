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
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
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
    // task-project-draft-status. By the SAME "eliminate, don't detect" shape
    // as the `transactions` ban above — see that block's own comment for the
    // review history this pattern comes from — a raw read of the `projects`
    // table that forgets the new `status` column would show a DRAFT or
    // REJECTED project as though it were confirmed. `visible_projects` (a
    // Postgres VIEW pre-filtered to `status = 'ACTIVE' AND archived_at IS
    // NULL` — see schema.ts's doc on the view) is the fix; this bans the raw
    // import + both AST-level bypass forms the transactions ban already had
    // to close (relational `with: { projects: ... }` traversal via
    // `usersRelations.projects`'s STRING key, and `db.query.projects`
    // property access) in the files below.
    //
    // UNLIKE `transactions`, this ban is NOT module-wide — `projects` has
    // real legitimate raw readers well beyond `finance/**`/`invoices/**`
    // (which the transactions ban already exempted): it is written by
    // archival cascades (`teams.service.ts`, `users.service.ts`,
    // `transactions.service.ts`) and looked up by id for RBAC or historical-
    // name denormalisation (`transactions.service.ts`, `pending-settlement
    // .service.ts`, `credentials.service.ts`, `legends.service.ts`,
    // `invoices.service.ts`, `job-sourcing.service.ts`) from modules that own
    // no part of the confirmation flow — banning the import there would break
    // real, unrelated code, not close a gap. `projects/**` (the home module —
    // it owns the narrow admin/approver path to a still-DRAFT row) is
    // exempt for the same reason `finance/**` is exempt from the
    // `transactions` ban. This is the "легитимные исключения — назвать
    // поимённо и обосновать" the task asks for: every module above is named,
    // with the reason it still needs the raw table, rather than the ban
    // simply not reaching them. Each of THOSE modules' own "which project
    // counts as active" reads (the ones that previously used
    // `isNull(projects.archivedAt)` alone) were migrated to
    // `visible_projects` by hand instead — this ban cannot see that call
    // shape reappearing there without also breaking their legitimate writes.
    //
    // The files below have ZERO other legitimate raw need — every one of
    // their previous `isNull(projects.archivedAt)`-style reads was migrated
    // to `visible_projects` in the same PR that added this rule, so the ban
    // closes ALL raw access, not just the one call shape.
    files: [
      'src/documents/**/*.ts',
      'src/interviews/**/*.ts',
      'src/admin/**/*.ts',
      'src/users/users-access.service.ts',
    ],
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
              importNames: ['projects'],
              message:
                'Raw `projects` table access is banned in this module (task-project-draft-status) ' +
                '— a DRAFT or REJECTED project must never leak through a forgotten status filter. ' +
                'Import `visibleProjects` (the VIEW) for list/aggregate/join reads instead — see ' +
                'schema.ts for why. If this read genuinely needs to see every status (narrow ' +
                'admin/approver path, or a write), it belongs in apps/api/src/projects/** — see ' +
                'this rule\'s own comment in eslint.config.mjs for the full exception list.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='projects']",
          message:
            'A relational `with: { projects: ... }` include reaches raw, unfiltered project rows ' +
            "(via usersRelations.projects's string key) without importing the `projects` symbol — " +
            'the import-ban above cannot see it. Use `visibleProjects` via an explicit query-builder ' +
            'select/join instead of a relational traversal into this table.',
        },
        {
          // Scoped to `<x>.query.projects` specifically (object.property.name
          // === 'query'), NOT a bare `.projects` anywhere — unlike
          // `transactions`, `.projects` collides with a real, unrelated
          // identifier in this codebase: `InterviewsService` (one of the
          // files this very rule applies to) injects `ProjectsService` as
          // `private projects: ProjectsService` and calls
          // `this.projects.createFromInterview(...)` — a bare
          // `MemberExpression[property.name='projects']` selector flagged
          // that constructor-injected service call as though it were
          // `db.query.projects`, a false positive found by running this rule
          // for real (not by inspection) before it shipped.
          selector: "MemberExpression[property.name='projects'][object.property.name='query']",
          message:
            'A `.projects` property access (e.g. `db.query.projects.findMany(...)`) reaches raw, ' +
            'unfiltered project rows without importing the `projects` symbol at all — the import-ban ' +
            'above cannot see it. Use `visibleProjects` via an explicit query-builder select/join ' +
            'instead of the relational query API for this table.',
        },
      ],
    },
  },
  {
    // SEC-1 (mega-audit wave 2, round 4, optional hardening) — makes the
    // "unify the two readers" mistake IMPOSSIBLE at the AST level, not just
    // noticed later by a reviewer. `computeCompanyAccountBalanceForDisplay`
    // (company-account-balance.ts) is display-ONLY: it degrades gracefully
    // on the known off-currency condition instead of throwing, which is
    // EXACTLY WRONG for a money-moving gate (createExpense/paySalary/
    // settleByCompany/createDividend — see that function's docstring). The
    // one legitimate caller is `CompanyAccountService.computeBalance()`
    // (company-account.service.ts). `transactions.service.ts` and
    // `pending-settlement.service.ts` — home to three of the four gates —
    // are out of THIS task's zone (PR #549), so a future edit there that
    // swapped the throwing reader for the display-safe one (looking like a
    // harmless "these two readers should just be one function" refactor)
    // could not be caught by a runtime test living in this task's files.
    // Banning the import at the lint level closes that gap regardless of
    // which finance/** file the edit happens to land in.
    files: ['src/finance/**/*.ts'],
    ignores: ['src/finance/company-account.service.ts', '**/*.spec.ts'],
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
              group: ['**/company-account-balance', './company-account-balance'],
              importNames: ['computeCompanyAccountBalanceForDisplay'],
              message:
                'computeCompanyAccountBalanceForDisplay is display-ONLY (SEC-1, mega-audit ' +
                'wave 2 round 4) — it degrades instead of throwing on a corrupted balance, ' +
                'which is exactly wrong for a money-moving gate. Only ' +
                'CompanyAccountService.computeBalance() may import it. A gate ' +
                '(createExpense/paySalary/settleByCompany/createDividend) must import ' +
                'computeCompanyAccountBalanceFromLedger instead, which still throws.',
            },
          ],
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
