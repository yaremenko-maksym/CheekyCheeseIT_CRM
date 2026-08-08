/**
 * sanitizeDownloadFilename - task-candidate-card-resume tidy-up (code-review
 * round 3). Shared between `apps/api` (Content-Disposition header, the
 * original call site) and `apps/web` (the resume-preview dialog's blob
 * download, `apps/web/.../ResumePreviewDialog.tsx`) - one module, two
 * callers, same reasoning as `safeTelegramHref` moving to a shared spot.
 *
 * Turns a candidate/user-controlled display name into something safe to use
 * as the BASE of a downloaded file's name (caller appends the extension).
 * The input is untrusted: for vacancy-application resumes specifically it
 * comes straight from an anonymous public form's `fullName` field, with no
 * format validation on write.
 *
 * Strips (all via the explicit backslash-u escapes in the regex below -
 * never literal characters, so this file stays plain ASCII):
 *   - a double quote, a backslash, CR, LF - breaks out of a quoted
 *     Content-Disposition `filename="..."` parameter (sec MED-5,
 *     task-file-storage-hardening section 7).
 *   - a forward slash - a path separator has no business inside a single
 *     file's base name; browsers/OSes already refuse it in a real filename,
 *     but nothing stops it from sitting in the string that gets shown or
 *     logged before that point.
 *   - Unicode bidi-override/isolate control characters (code points
 *     U+202A through U+202E: LRE/RLE/PDF/LRO/RLO, and U+2066 through
 *     U+2069: LRI/RLI/FSI/PDI) - the RLO filename-spoofing trick: a
 *     submitted name containing U+202E (RIGHT-TO-LEFT OVERRIDE) can make a
 *     string like "cv" + U+202E + "fdp.exe" DISPLAY reversed after that
 *     point, disguising an executable as a harmless PDF in a file-save
 *     dialog or downloads list.
 *   - other C0 control characters (U+0000 through U+001F) and C1 control
 *     characters plus DEL (U+007F through U+009F).
 *
 * Caps the result length (default 120) so an absurdly long display name
 * can't produce a filename problem on some filesystem/UI, and falls back to
 * 'file' if stripping leaves nothing usable (e.g. the input was entirely
 * control/bidi characters).
 */
// NOTE: this pattern intentionally matches control characters — stripping
// control/bidi chars is the whole point of it. If `no-control-regex` is ever
// enabled for this package, re-add an `eslint-disable-next-line` here.
// (The directive that used to live on this line was inert: no config enabled
// that rule, so ESLint reported it as an unused directive — task-lint-teeth.)
const UNSAFE_FILENAME_CHARS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069"\\\\/\\r\\n]',
  'g',
)

export function sanitizeDownloadFilename(name: string, maxLength = 120): string {
  const stripped = name.replace(UNSAFE_FILENAME_CHARS, '').trim()
  return stripped.slice(0, maxLength) || 'file'
}
