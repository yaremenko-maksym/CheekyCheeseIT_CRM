/**
 * task-i18n-stage4-task6. Same shim as `apps/api/src/common/lingui-message-
 * utils.d.ts` (SR-M-1, PR #704 fix-round 1) — `@lingui/message-utils`
 * publishes ONLY `package.json` `exports` subpaths (no root `"."` entry, no
 * top-level `main`/`types` field) and its `./compileMessage` subpath's
 * `types` condition points at `dist/compileMessage.d.mts` /
 * `dist/compileMessage.d.cts` — resolvable under `moduleResolution: "bundler"
 * | "node16" | "nodenext"`, NOT under this package's pinned `moduleResolution:
 * "Node"` (classic; `version-pins.md`'s Lingui-6-blocker note documents the
 * same dual-package `.d.ts` shape blocking a different upgrade). `tsc
 * --noEmit` on `catalog.ts`'s `import { compileMessage } from
 * '@lingui/message-utils/compileMessage'` fails with TS7016 ("implicitly has
 * an 'any' type") without this file — the import resolves and works at
 * RUNTIME regardless (Node's own `exports`-aware resolver, and the package's
 * `compileMessage.js` CJS-compat shim at its root, both find the real file;
 * only `tsc`'s classic type resolution cannot), so this shim supplies the
 * type half.
 *
 * Mirrors `dist/compileMessage.d.cts`'s `compileMessage` signature exactly —
 * kept local (not imported from the `apps/api` copy, which this package
 * cannot depend on) so both shims independently stay in sync with the same
 * upstream `.d.cts`.
 */
declare module '@lingui/message-utils/compileMessage' {
  export type CompiledMessage = unknown[]
  export function compileMessage(
    message: string,
    mapText?: (value: string) => string,
  ): CompiledMessage
}
