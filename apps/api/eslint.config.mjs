import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import vitest from '@vitest/eslint-plugin'

import { vitestTestQualityRules } from '../../eslint.test-rules.mjs'

/**
 * task-project-draft-status security-review round 3 (SR-H-3): the ORIGINAL
 * version of the `with: { <key>: ... }` ban below hand-enumerated a SINGLE
 * relation key name (`projects`) — but Drizzle relation keys are arbitrary
 * strings chosen per-table in schema.ts (`dropProjects: many(projects, ...)`,
 * `project: one(projects, ...)` (six different source tables), `target:
 * one(projects, ...)`), and a hand-typed single-key list silently misses
 * every other one. Proven live before this fix: `db.query.projectMembers
 * .findMany({ with: { project: true } })` passed this rule with ZERO
 * errors — one of THOSE 11 real `with: { project: ... }` call sites in this
 * codebase is exactly the mechanism behind SR-H-1 (the salary cron minting
 * money against a DRAFT/REJECTED project).
 *
 * Fix: derive the banned key list MECHANICALLY from schema.ts itself
 * instead of enumerating it by hand — scan for every
 * `<key>: (one|many)(projects, ...)` relation definition and ban whatever
 * key names come back. A NEW relation added to `projects` under a new key
 * name is caught automatically the next time ESLint runs, with no human
 * required to remember to widen this file — the same 'eliminate, don't
 * detect' shape the rest of this ban already follows, applied to the ban's
 * OWN maintenance instead of just the code it scans.
 */
function deriveProjectRelationKeys() {
  const schemaPath = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    'src/database/schema.ts',
  )
  const src = readFileSync(schemaPath, 'utf8')
  const keys = new Set()
  // `<identifier>: one(projects` / `<identifier>: many(projects` — the exact
  // call shape Drizzle relation definitions use to point AT this table (see
  // `projectsRelations` and its callers in schema.ts). Deliberately does NOT
  // require the enclosing `relations(...)` block's own table name — the call
  // shape itself (`one`/`many` applied directly to the `projects` table
  // symbol) is specific enough not to false-match anything else in the file.
  const RELATION_TO_PROJECTS = /(\w+):\s*(?:one|many)\(\s*projects\b/g
  let match
  while ((match = RELATION_TO_PROJECTS.exec(src)) !== null) {
    keys.add(match[1])
  }
  if (keys.size === 0) {
    // Fail LOUD, not silently permissive: an empty derived list would widen
    // to a selector matching nothing at all, and the ban would go dark
    // without any error signal — worse than the hand-typed list it replaces.
    throw new Error(
      'eslint.config.mjs: derived ZERO relation keys pointing at `projects` from ' +
        'schema.ts — the scan regex or schema.ts itself changed shape. Fix the ' +
        'regex in deriveProjectRelationKeys() before this ban can run.',
    )
  }
  return [...keys]
}

const PROJECT_RELATION_KEYS = deriveProjectRelationKeys()

/**
 * security-review round 2 follow-on (task-project-draft-status), found while
 * fixing SR-L-3's computed-access selector: ESLint flat config merges the
 * `rules` of every config object matching a file KEY BY KEY. For the SAME
 * key (`no-restricted-imports`, `no-restricted-syntax`), the LAST matching
 * block's value REPLACES an earlier matching block's value WHOLESALE — it
 * does not concatenate the two. `src/documents/**\/*.ts` and
 * `src/admin/**\/*.ts` used to match TWO separate blocks below (the
 * `transactions` ban from security-review PR #456, and the `projects` ban
 * this task added) that both set those same two rule keys. From the moment
 * the `projects` ban shipped, its values silently REPLACED the
 * `transactions` ban's for those two modules — not just the computed-access
 * edge SR-L-3 named, the WHOLE ban, both rule keys. Verified by running
 * ESLint against a plain `db.query.transactions.findMany({})` AND a raw
 * `import { transactions } from '../database/schema'` inside
 * `src/documents/`: both passed with zero errors before this restructuring
 * — a real regression PR #456's own protection suffered the moment this
 * task's ban shipped alongside it, not a hypothetical.
 *
 * Fix: one block below per UNIQUE combination of which bans apply to a file
 * set, instead of two blocks with overlapping `files` and colliding rule
 * keys — `src/documents/**\/*.ts` + `src/admin/**\/*.ts` (both bans),
 * `src/projects/**\/*.ts` (transactions ban only — `projects/**` stays
 * exempt from its own ban), `src/interviews/**\/*.ts` +
 * `src/users/users-access.service.ts` (projects ban only — these were never
 * subject to the transactions ban). The selectors and messages themselves
 * are UNCHANGED from what shipped in the two original blocks; only which
 * `files:[]` block declares them moved, via the shared fragments below.
 */
const TRANSACTIONS_IMPORT_PATTERN = {
  group: ['**/database/schema'],
  importNames: ['transactions'],
  message:
    'Raw `transactions` table access is banned outside apps/api/src/finance/** ' +
    '(security-review PR #456 round 2) — a soft-deleted row must never leak through ' +
    'a forgotten filter in another module. Import `nonDeletedTransactions` (the VIEW) ' +
    'for list/aggregate/join reads instead — see schema.ts for why.',
}

// security-review PR #456 round 2 ("форма F") + round 3 (MED-1): TWO
// separate ways to reach raw `transactions` rows WITHOUT ever importing the
// `transactions` table symbol, so the import-ban above cannot see either
// one — it can only flag an import statement, and neither of these needs
// one:
//
//   1. Relational include: `projectsRelations`/`payoutRequestsRelations`
//      both declare `transactions: many(transactions)` (schema.ts), so
//      `db.query.projects.findMany({ with: { transactions: true } })`
//      reaches the raw table through the relation's STRING key, not an
//      import (round 2, "форма F").
//   2. Drizzle relational query API property access:
//      `db.query.transactions.findMany({})` needs `db` (already imported
//      everywhere) and nothing else — `.transactions` is a property lookup
//      on `db.query`, not a symbol import. Round 3's review reproduced this
//      LIVE against this exact rule (0 errors, compiles clean) and
//      confirmed it is the MORE likely regression path of the two, not the
//      less likely one: the idiom already lives in ~30 call sites across
//      this codebase (e.g. `invoices.service.ts:650`), and
//      `projects.service.ts` read this exact way before that PR (see the
//      "round-1 sugar" comment in `admin-summary.service.ts`).
//   3. Computed property access: `db.query['transactions']` (security-
//      review round 2, SR-L-3, task-project-draft-status) — a `Literal`
//      property node, which selector 2's `property.name` check cannot see.
//      Not scoped to `object.property.name='query'` (unlike the `projects`
//      ban's own computed selector below) for the same reason selector 2 is
//      not scoped: `.transactions` does not collide with any real,
//      unrelated identifier in this codebase.
//
// No file in this ban group used forms 1/2 when the ban shipped (verified:
// zero matches for both). Known residuals, NOT closed by any selector here
// (same tier as the honestly-documented raw-SQL-literal residual, "форма E"
// — dynamic `import('../database/schema')` then `.transactions`, a
// re-export of `transactions` from a non-banned module re-imported under a
// different name, and a TEMPLATE-LITERAL computed key
// (`` db.query[`transactions`] ``, a different AST node shape than the
// string `Literal` form 3 matches): all require the same deliberate,
// Drizzle-convention-breaking effort as форма E, and none has ever appeared
// in this codebase.
const TRANSACTIONS_SYNTAX_SELECTORS = [
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
  {
    selector: "MemberExpression[computed=true][property.value='transactions']",
    message:
      'A computed `db.query["transactions"]` property access reaches raw, unfiltered ' +
      'transaction rows the same way `db.query.transactions` does (security-review round 2, ' +
      'SR-L-3) — the identifier-only selector above cannot see the bracket form. Use ' +
      '`nonDeletedTransactions` via an explicit query-builder select/join instead of the ' +
      'relational query API for this table.',
  },
]

const PROJECTS_IMPORT_PATTERN = {
  group: ['**/database/schema'],
  importNames: ['projects'],
  message:
    'Raw `projects` table access is banned in this module (task-project-draft-status) ' +
    '— a DRAFT or REJECTED project must never leak through a forgotten status filter. ' +
    'Import `visibleProjects` (the VIEW) for list/aggregate/join reads instead — see ' +
    'schema.ts for why. If this read genuinely needs to see every status (narrow ' +
    'admin/approver path, or a write), it belongs in apps/api/src/projects/** — see ' +
    "this rule's own comment in eslint.config.mjs for the full exception list.",
}

// task-project-draft-status. By the SAME "eliminate, don't detect" shape as
// the `transactions` ban above — see that fragment's own comment for the
// review history this pattern comes from — a raw read of the `projects`
// table that forgets the new `status` column would show a DRAFT or REJECTED
// project as though it were confirmed. `visible_projects` (a Postgres VIEW
// pre-filtered to `status = 'ACTIVE' AND archived_at IS NULL` — see
// schema.ts's doc on the view) is the fix; these selectors ban the
// relational `with: { <key>: ... }` traversal (see
// `deriveProjectRelationKeys()` above — SR-H-3 caught the FIRST version of
// this comment overclaiming "both bypass forms" when it only ever matched
// ONE relation key name), the `db.query.projects` property access, and its
// computed-literal form (SR-L-3, round 2).
//
// UNLIKE `transactions`, this ban is NOT module-wide — `projects` has real
// legitimate raw readers well beyond `finance/**`/`invoices/**` (which the
// transactions ban already exempted): it is written by archival cascades
// (`teams.service.ts`, `users.service.ts`, `transactions.service.ts`) and
// looked up by id for RBAC or historical-name denormalisation
// (`transactions.service.ts`, `pending-settlement.service.ts`,
// `credentials.service.ts`, `legends.service.ts`, `invoices.service.ts`,
// `job-sourcing.service.ts`) from modules that own no part of the
// confirmation flow — banning the import there would break real, unrelated
// code, not close a gap. `projects/**` (the home module — it owns the
// narrow admin/approver path to a still-DRAFT row) is exempt for the same
// reason `finance/**` is exempt from the `transactions` ban. This is the
// "легитимные исключения — назвать поимённо и обосновать" the task asks
// for: every module above is named, with the reason it still needs the raw
// table, rather than the ban simply not reaching them.
//
// security-review round 3 (SR-L-2): a previous version of this comment
// claimed `users.service.ts` / `teams.service.ts`'s own "which project
// counts as active" reads "were migrated to `visible_projects` by hand
// instead" — false, and contradicted the PR's own "Допущения" section two
// paragraphs up in the same diff. Those two files' project reads were
// DELIBERATELY left untouched (verified byte-for-byte against
// `origin/main`): an archival-cascade impact read must see a project
// regardless of its confirmation status — a DRAFT project's senior/drop
// archiving must still cascade-archive it — so filtering to ACTIVE-only
// there would be a real regression, not a fix. That is exactly why they are
// named above as legitimate raw readers instead of being swept into this
// ban.
//
// The modules this ban applies to (see the three block definitions below)
// have no such reader — every one of their previous
// `isNull(projects.archivedAt)`-style reads WAS migrated to
// `visible_projects` in the same PR that added this rule, so the ban closes
// every IDENTIFIER and STRING-LITERAL access route an AST selector can see
// — including the computed `db.query['projects']` bracket form (security-
// review round 2, SR-L-3: the round-1 selector matched ONLY the identifier
// form, `property.name === 'projects'` — a bracket-literal access uses a
// `Literal` property node instead, so `property.name` is `undefined` there
// and the round-1 selector let it through with zero errors, verified by
// running it). It does not (and, being AST-only, structurally cannot) catch
// a raw SQL string that never imports the `projects` symbol at all
// (`db.execute(sql\`...FROM projects...\`)`) — the same class of residual
// gap the `transactions` fragment above accepts for `sql\` templates,
// nested relational `with: {...}` reads` — nor a TEMPLATE-LITERAL computed
// key (`` db.query[`projects`] ``), a different AST node shape than the
// string `Literal` the selector below matches, and one nobody has ever
// written in this codebase; recorded here rather than silently absent, same
// as the SQL-string gap above.
const PROJECTS_SYNTAX_SELECTORS = [
  {
    // SR-H-3: selector built from PROJECT_RELATION_KEYS (derived above from
    // schema.ts itself) instead of a single hand-typed key name — catches
    // `with: { project: ... }`, `with: { dropProjects: ... }`, `with: {
    // target: ... }`, etc., not just `with: { projects: ... }`.
    selector: `Property[key.name=/^(${PROJECT_RELATION_KEYS.join('|')})$/]`,
    message:
      'A relational `with: { <key>: ... }` include reaches raw, unfiltered project rows ' +
      `(one of: ${PROJECT_RELATION_KEYS.join(', ')} — every key in schema.ts whose relation ` +
      "points at the `projects` table, see this rule's own comment in eslint.config.mjs) " +
      'without importing the `projects` symbol — the import-ban above cannot see it. Use ' +
      '`visibleProjects` via an explicit query-builder select/join instead of a relational ' +
      'traversal into this table.',
  },
  {
    // Scoped to `<x>.query.projects` specifically (object.property.name ===
    // 'query'), NOT a bare `.projects` anywhere — unlike `transactions`,
    // `.projects` collides with a real, unrelated identifier in this
    // codebase: `InterviewsService` (one of the modules this ban applies to)
    // injects `ProjectsService` as `private projects: ProjectsService` and
    // calls `this.projects.createFromInterview(...)` — a bare
    // `MemberExpression[property.name='projects']` selector flagged that
    // constructor-injected service call as though it were
    // `db.query.projects`, a false positive found by running this rule for
    // real (not by inspection) before it shipped.
    selector: "MemberExpression[property.name='projects'][object.property.name='query']",
    message:
      'A `.projects` property access (e.g. `db.query.projects.findMany(...)`) reaches raw, ' +
      'unfiltered project rows without importing the `projects` symbol at all — the import-ban ' +
      'above cannot see it. Use `visibleProjects` via an explicit query-builder select/join ' +
      'instead of the relational query API for this table.',
  },
  {
    // security-review round 2 (SR-L-3): the selector above matches an
    // IDENTIFIER property (`property.name === 'projects'`) — ESTree gives a
    // COMPUTED access with a string literal (`db.query['projects']`)
    // `property: { type: 'Literal', value: 'projects' }` instead, so
    // `property.name` is `undefined` there and the selector above silently
    // passed it (verified by running ESLint against exactly this form in a
    // banned module: 0 errors, before this selector existed). Same
    // identifier-vs-computed gap as SR-H-3 found in the relation-key
    // selector, one MemberExpression form over — the fix is the same shape,
    // a second selector rather than widening the first (esquery attribute
    // selectors test one property name per selector; `property.name` and
    // `property.value` are never both present on the same node, so one
    // selector cannot match both AST shapes).
    selector:
      "MemberExpression[computed=true][property.value='projects'][object.property.name='query']",
    message:
      'A computed `db.query["projects"]` property access reaches raw, unfiltered project ' +
      'rows the same way `db.query.projects` does (security-review round 2, SR-L-3) — the ' +
      'identifier-only selector above cannot see the bracket form. Use `visibleProjects` via ' +
      'an explicit query-builder select/join instead of the relational query API for this table.',
  },
]

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
    //
    // Three blocks below (this one, plus the `src/projects/**` one and the
    // `src/interviews/** + users-access.service.ts` one further down)
    // instead of the original two — see the shared-fragments comment above
    // `TRANSACTIONS_IMPORT_PATTERN` for why: this block is the modules where
    // BOTH the transactions ban and the projects ban apply, so it is the
    // only one whose `no-restricted-imports`/`no-restricted-syntax` combine
    // fragments from both.
    files: ['src/documents/**/*.ts', 'src/admin/**/*.ts'],
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
        { patterns: [TRANSACTIONS_IMPORT_PATTERN, PROJECTS_IMPORT_PATTERN] },
      ],
      'no-restricted-syntax': [
        'error',
        ...TRANSACTIONS_SYNTAX_SELECTORS,
        ...PROJECTS_SYNTAX_SELECTORS,
      ],
    },
  },
  {
    // `src/projects/**` — the transactions ban only. `projects/**` (the home
    // module — it owns the narrow admin/approver path to a still-DRAFT row)
    // stays exempt from its OWN ban (see `PROJECTS_SYNTAX_SELECTORS`'s own
    // comment above for why), so it must not pick up
    // `PROJECTS_IMPORT_PATTERN`/`PROJECTS_SYNTAX_SELECTORS` — only the
    // transactions fragments, unchanged from the original single combined
    // block.
    files: ['src/projects/**/*.ts'],
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
      'no-restricted-imports': ['error', { patterns: [TRANSACTIONS_IMPORT_PATTERN] }],
      'no-restricted-syntax': ['error', ...TRANSACTIONS_SYNTAX_SELECTORS],
    },
  },
  {
    // `src/interviews/**` + `src/users/users-access.service.ts` — the
    // projects ban only. Neither module was ever in the transactions ban's
    // file list, so only the projects fragments apply here.
    files: ['src/interviews/**/*.ts', 'src/users/users-access.service.ts'],
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
      'no-restricted-imports': ['error', { patterns: [PROJECTS_IMPORT_PATTERN] }],
      'no-restricted-syntax': ['error', ...PROJECTS_SYNTAX_SELECTORS],
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
