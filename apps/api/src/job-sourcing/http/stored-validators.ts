import { z } from 'zod'

/**
 * Source fetch strategy U6b: the validators a host showed on its first request, kept in the run
 * `checkpoint` (key `validators`) so the next routine run can ask "has it changed?".
 *
 * The values come from the host and are sent back as request headers, so a value that is not
 * printable ASCII (a CR/LF would split a header) is refused here rather than at the socket. The
 * caps keep the serialised form well inside the checkpoint's 8192-character bound beside a cursor.
 */
const HEADER_VALUE = /^[\x20-\x7e]+$/

export const storedValidatorsSchema = z
  .object({
    /** The first request's URL: the validators are only valid for the resource they came from. */
    url: z.string().min(1).max(1024),
    etag: z.string().max(512).regex(HEADER_VALUE).nullable(),
    lastModified: z.string().max(128).regex(HEADER_VALUE).nullable(),
  })
  .refine((v) => v.etag !== null || v.lastModified !== null)

export type StoredValidators = z.infer<typeof storedValidatorsSchema>

/** A stored value that parses, or `null`: a damaged or absent value is "no validators", never a failure. */
export function parseStoredValidators(value: unknown): StoredValidators | null {
  const parsed = storedValidatorsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The validators a response showed, for `url`, or `null` when it showed none that can be stored. */
export function validatorsOf(
  url: string,
  shown: { etag: string | null; lastModified: string | null },
): StoredValidators | null {
  return parseStoredValidators({
    url,
    etag: blankToNull(shown.etag),
    lastModified: blankToNull(shown.lastModified),
  })
}

const blankToNull = (v: string | null): string | null => (v === null || v.trim() === '' ? null : v)

/** The request headers that ask "has it changed since?". Only the validator the host showed. */
export function conditionalHeadersOf(stored: StoredValidators): Record<string, string> {
  return {
    ...(stored.etag !== null && { 'if-none-match': stored.etag }),
    ...(stored.lastModified !== null && { 'if-modified-since': stored.lastModified }),
  }
}
