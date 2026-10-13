/** Removes NUL, C0/C1 control characters and DEL, keeping only `\n` and `\t`. */
export function stripUnstorableChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    if (!isControl || code === 0x0a || code === 0x09) out += ch
  }
  return out
}
