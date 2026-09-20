/// <reference types="vite/client" />

declare module '*.css' {
  const content: Record<string, string>
  export default content
}

// task-i18n-stage2-task5. `@lingui/vite-plugin` (configured in vite.config.ts
// / vitest.config.ts) compiles a `.po` catalog into a JS module exporting
// `messages` at import time — see the plugin's own docs ("the file extension
// is mandatory" for the dynamic-import form we don't use yet; Task 6 will).
declare module '*.po' {
  import type { Messages } from '@lingui/core'
  export const messages: Messages
}
