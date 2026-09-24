/**
 * SR-M-1 (PR #704 fix-round 1). `@lingui/message-utils` publishes ONLY
 * `package.json` `exports` subpaths (no root `"."` entry, no top-level
 * `main`/`types` field) and its `./compileMessage` subpath's `types`
 * condition points at `dist/compileMessage.d.mts` / `dist/compileMessage.d.cts`
 * — resolvable under `moduleResolution: "bundler" | "node16" | "nodenext"`,
 * NOT under this package's pinned `moduleResolution: "Node"` (classic;
 * `version-pins.md`'s Lingui-6-blocker note documents the same dual-package
 * `.d.ts` shape blocking a different upgrade). `tsc --noEmit` on
 * `api-error.ts`'s `import { compileMessage } from
 * '@lingui/message-utils/compileMessage'` fails with TS7016 ("implicitly
 * has an 'any' type") without this file — the import resolves and works at
 * RUNTIME regardless (Node's own `exports`-aware resolver, and the
 * package's `compileMessage.js` CJS-compat shim at its root, both find the
 * real file; only `tsc`'s classic type resolution cannot), so this shim
 * supplies the type half.
 *
 * Mirrors `dist/compileMessage.d.cts`'s `compileMessage` signature exactly,
 * and `@lingui/core`'s own `MessageCompiler = (message: string) =>
 * CompiledMessage` (`i18n.setMessagesCompiler`'s parameter type) — kept
 * structurally compatible with a plain `unknown[]` return instead of
 * re-declaring `@lingui/core`'s private `CompiledMessage` shape, since
 * nothing in this codebase inspects the compiled token array itself; it
 * only ever gets handed straight back into `@lingui/core`.
 */
declare module '@lingui/message-utils/compileMessage' {
  export function compileMessage(message: string, mapText?: (value: string) => string): unknown[]
}
