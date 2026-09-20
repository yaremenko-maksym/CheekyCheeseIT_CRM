import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import vitest from '@vitest/eslint-plugin'
import pluginLingui from 'eslint-plugin-lingui'

import { vitestTestQualityRules } from '../../eslint.test-rules.mjs'

// task-lint-teeth (2026-08-08): this package had NO eslint config and no
// `lint` script, so `pnpm lint` (turbo lint) skipped it entirely — silently,
// with no "0 packages matched" style warning. That mattered more here than
// anywhere else in the repo: packages/shared is the single source of truth for
// every Zod schema, i.e. the contract between apps/web and apps/api. Nothing
// was checking it.
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
    // task-i18n-stage2-task9 (plan §Task 9): same baseline-warning rule as
    // apps/web/eslint.config.mjs — see that file's comment for the full
    // rationale (`warn` for now, `error` from stage 6; third `ignore` entry
    // narrows to lines actually containing Cyrillic).
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    plugins: { lingui: pluginLingui },
    rules: {
      'lingui/no-unlocalized-strings': [
        'warn',
        {
          ignore: ['^(?![A-ZА-ЯЁІЇЄҐ])\\S+$', '^[A-Z0-9_-]+$', '^[^а-яёіїєґА-ЯЁІЇЄҐ]*$'],
          ignoreNames: [
            { regex: { pattern: 'className', flags: 'i' } },
            'data-testid',
            'src',
            'href',
            'type',
            'id',
            'key',
            'variant',
            'size',
            'role',
          ],
          ignoreFunctions: [
            'cn',
            'cva',
            'console.*',
            'Error',
            '*.includes',
            '*.startsWith',
            '*.endsWith',
            'vi.*',
            'expect',
            'describe',
            'it',
            'test',
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
