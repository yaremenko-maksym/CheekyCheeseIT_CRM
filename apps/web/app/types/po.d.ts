// `@lingui/vite-plugin` (apps/web/vite.config.ts) transforms any `*.po`
// import — including the dynamic `import(...)` in `app/lib/i18n.ts` that
// loads a compiled catalog at runtime — into a JS module exporting
// `messages` (the shape `I18n#loadAndActivate` expects). Without this
// declaration `tsc` has no ambient type for a `.po` specifier and the
// dynamic import in `app/lib/i18n.ts` fails to typecheck (TS2307/7016).
declare module '*.po' {
  const messages: Record<string, unknown>
  export { messages }
}
