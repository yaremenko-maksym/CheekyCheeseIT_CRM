// `@lingui/vite-plugin` (apps/web/vite.config.ts) transforms any `*.po`
// import — including the `import.meta.glob(...)` in `app/lib/i18n.ts` that
// loads a compiled catalog at runtime — into a JS module exporting
// `messages` (the shape `I18n#loadAndActivate` expects, typed as `Messages`
// itself rather than a loose `Record<string, unknown>` so that call sites
// don't need their own cast — fix-round 1, PR #695: the loose type passed
// `tsc` at declaration time but failed at the `i18n.loadAndActivate(...)`
// call site, `Messages`'s index signature being `string | CompiledMessage`,
// not `unknown`). Without this declaration `tsc` has no ambient type for a
// `.po` specifier and the import in `app/lib/i18n.ts` fails to typecheck
// (TS2307/7016).
import type { Messages } from '@lingui/core'

declare module '*.po' {
  const messages: Messages
  export { messages }
}
