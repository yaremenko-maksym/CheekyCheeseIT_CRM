const PART_MAX = 80

/** One part of the name: only `[A-Za-z0-9 .,&()-]`, whitespace collapsed, cut at 80, trimmed. */
const part = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9 .,&()-]/gu, '')
    .replace(/ +/gu, ' ')
    .trim()
    .slice(0, PART_MAX)
    .trim()

/**
 * D15 — the tailored PDF's download name, `<display name> - <title> - CV.pdf`. Both forms carry the
 * same reduced text: `ascii` for `filename="…"`, `utf8` percent-encoded for `filename*=UTF-8''…`.
 * A part that reduces to nothing is dropped, so the name never starts with a bare separator.
 */
export function tailoredFilename(
  displayName: string,
  title: string,
): { ascii: string; utf8: string } {
  const ascii = [part(displayName), part(title), 'CV.pdf'].filter((p) => p !== '').join(' - ')
  return {
    ascii,
    utf8: encodeURIComponent(ascii).replace(/\(/gu, '%28').replace(/\)/gu, '%29'),
  }
}
