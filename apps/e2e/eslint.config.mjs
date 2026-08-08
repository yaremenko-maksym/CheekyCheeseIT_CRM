import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import playwright from 'eslint-plugin-playwright'

import { playwrightTestQualityRules } from '../../eslint.test-rules.mjs'

// task-lint-teeth (2026-08-08): this package had NO eslint config, no `lint`
// script and no `typecheck` script. 110 Playwright spec files — the exact
// place our repeat defects live — were checked by nothing at all. `tsc
// --noEmit` on the existing tsconfig surfaced 28 real type errors on day one.
export default [
  {
    ignores: ['dist/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'playwright.config.ts'],
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
    files: ['tests/**/*.spec.ts'],
    plugins: {
      playwright,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: playwrightTestQualityRules,
  },
]
