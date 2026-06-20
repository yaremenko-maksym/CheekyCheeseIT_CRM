/**
 * CodeMirror extension: highlight {{...}} tokens by category.
 *
 * Uses MatchDecorator (auto-updates on doc change) to mark each token
 * with a CSS class based on its category:
 *   - cm-token-custom   → registered custom variable  (green)
 *   - cm-token-system   → known system variable       (blue)
 *   - cm-token-unknown  → unregistered / typo token   (amber/warning)
 *
 * The caller re-creates the extension whenever customVariables change
 * (stable reference via useMemo in the component).
 */
import { Decoration, MatchDecorator, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { CONTRACT_VARIABLE_DESCRIPTIONS } from '@crm/shared'
import type { CustomVariable } from '@crm/shared'

const TOKEN_RE = /\{\{([a-zA-Z0-9_]+)\}\}/g

const SYSTEM_KEYS = new Set(Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS))

export function buildTokenHighlightExtension(customVariables: CustomVariable[]) {
  const customKeys = new Set(customVariables.map((v) => v.key))

  const matcher = new MatchDecorator({
    regexp: TOKEN_RE,
    decoration: (match) => {
      const key = match[1] ?? ''
      let cls: string
      if (customKeys.has(key)) {
        cls = 'cm-token-custom'
      } else if (SYSTEM_KEYS.has(key)) {
        cls = 'cm-token-system'
      } else {
        cls = 'cm-token-unknown'
      }
      return Decoration.mark({ class: cls, attributes: { title: key } })
    },
  })

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: Parameters<ConstructorParameters<typeof ViewPlugin.fromClass>[0]>[0]) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate) {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (v) => v.decorations },
  )
}

/**
 * Global CSS injected once per page for token highlight classes.
 * Call `injectTokenHighlightStyles()` once before mounting the editor.
 */
let stylesInjected = false
export function injectTokenHighlightStyles() {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .cm-token-custom  { background: rgba(34,197,94,0.18); border-radius: 3px; color: #16a34a; }
    .cm-token-system  { background: rgba(59,130,246,0.15); border-radius: 3px; color: #2563eb; }
    .cm-token-unknown { background: rgba(245,158,11,0.18); border-radius: 3px; color: #d97706; }
    .dark .cm-token-custom  { color: #4ade80; }
    .dark .cm-token-system  { color: #60a5fa; }
    .dark .cm-token-unknown { color: #fbbf24; }
  `
  document.head.appendChild(style)
}
