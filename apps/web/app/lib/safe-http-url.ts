/**
 * Returns the URL unchanged when it parses and uses the `http:` / `https:`
 * scheme, otherwise `null`. Use before rendering untrusted input into an
 * `href` — `javascript:`, `data:` etc. would execute on click.
 */
export function safeHttpUrl(value: string): string | null {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:' ? value : null
  } catch {
    return null
  }
}
