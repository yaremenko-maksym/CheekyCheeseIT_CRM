/**
 * Invisible formatting characters that can reorder or hide text (bidi overrides/isolates,
 * zero-width space, word joiner, BOM, ALM). ZWJ/ZWNJ are kept: legitimate in emoji and Persian/Indic text.
 */
function isInvisibleFormatting(code: number): boolean {
  return (
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  )
}

/**
 * Removes NUL, C0/C1 control characters and DEL (keeping only `\n` and `\t`), invisible
 * bidi/zero-width formatting characters, and lone surrogates. Valid surrogate pairs are kept.
 */
export function stripUnstorableChars(s: string): string {
  let out = ''
  // `for...of` iterates by code point: a lone surrogate is yielded as a single unit in 0xD800-0xDFFF.
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    const isLoneSurrogate = code >= 0xd800 && code <= 0xdfff
    if (isLoneSurrogate || isInvisibleFormatting(code)) continue
    if (!isControl || code === 0x0a || code === 0x09) out += ch
  }
  return out
}
