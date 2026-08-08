import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import vitest from '@vitest/eslint-plugin'

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
