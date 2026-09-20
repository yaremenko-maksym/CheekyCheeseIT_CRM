import type { LinguiConfig } from '@lingui/conf'

const config: LinguiConfig = {
  sourceLocale: 'uk',
  locales: ['uk', 'en'],
  format: 'po',
  catalogs: [
    {
      path: '<rootDir>/packages/shared/src/i18n/locales/{locale}/messages',
      include: [
        '<rootDir>/apps/web/app',
        '<rootDir>/apps/api/src',
        '<rootDir>/packages/shared/src',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/routeTree.gen.ts',
        // fix-round 1 (PR #695, SPEC-H-1a) — `apps/web/app/types/po.d.ts`
        // (`declare module '*.po' { const messages…; export { messages } }`)
        // is a pure type declaration, nothing to extract translatable
        // strings from. `lingui extract`'s babel parser tries to parse it
        // as an ordinary module anyway and throws `SyntaxError: Export
        // 'messages' is not defined` on the `export { messages }` inside
        // `declare module` — a `.d.ts` file has no runtime export to
        // satisfy that check against. Exclude the whole `.d.ts` class, not
        // just this one file: any future ambient declaration file would
        // hit the same parser error.
        '**/*.d.ts',
      ],
    },
  ],
  compileNamespace: 'ts',
  // apps/api uses NestJS's `experimentalDecorators: true` (apps/api/tsconfig.json)
  // — parameter decorators like `@Inject(...)` in a constructor signature are
  // only valid TS syntax under the legacy/experimental decorators proposal,
  // not under the Stage-3 decorators the extractor's babel parser assumes by
  // default. Without this, `lingui extract` throws "Decorators cannot be
  // used to decorate parameters" on every NestJS controller/service.
  extractorParserOptions: {
    tsExperimentalDecorators: true,
  },
}

export default config
