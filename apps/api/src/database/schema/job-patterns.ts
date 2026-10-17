/**
 * The CHECK-constraint literals the job-sourcing / collection tables share.
 *
 * Declared once, in the lowest module of this import graph
 * (patterns <- metering <- job-sourcing <- job-collection), because the same
 * rule is enforced on columns of four different tables: a second copy is how
 * the four silently drift apart. Task 1.3 transcribes these into production DDL
 * BY HAND, so a claim made here has to be true where it is claimed.
 *
 * None of these is a secret detector. Each is an alphabet-and-length guard:
 * it makes the wrong KIND of value fail loudly instead of persisting quietly.
 */

/**
 * A public identity — an account key or a manifest id. A short lowercase id
 * (<= 100 characters) over a deliberately narrow alphabet that excludes every
 * uppercase letter, the base64 characters `+ / =` and `/`, so a bearer token,
 * a base64 blob or a URL with credentials cannot be stored even by accident.
 * Mirrors `jobAccountKeySchema`.
 */
export const JOB_PUBLIC_ID_PATTERN = '^[a-z0-9][a-z0-9._:-]{0,99}$'

/**
 * SR-M-1. The alphabet above still admits a long unbroken lowercase run — a
 * pasted raw hex or alphanumeric key reads as a legal id. A real identity is
 * SEGMENTED (`jsearch:rapidapi-main`, `dou.rss.jobs`), so a run of 24 or more
 * characters with no `. : _ -` separator is refused. This is a REFUSAL pattern:
 * a value matching it is rejected.
 */
export const JOB_UNBROKEN_RUN_PATTERN = '[a-z0-9]{24}'

/**
 * SR-M-2 / SPEC-M-1. A typed error code, upper-snake, at most 64 characters:
 * `HTTP_403`, `VERSION_STALE`. Mirrors `jobErrorCodeSchema`. The three error
 * code columns were unbounded `text`, so a 400-character upstream body — which
 * may carry an API key — was accepted into a column documented as holding a
 * typed code.
 */
export const JOB_ERROR_CODE_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$'

/** A sanitized sentence, not an upstream body. */
export const JOB_SANITIZED_TEXT_MAX = 500

/** An owner token, a claim owner, an attempt id, a trigger key: a short handle. */
export const JOB_HANDLE_MAX = 200

/** An adapter version string, a namespace segment set, a dirty-work reason. */
export const JOB_SHORT_TEXT_MAX = 100

/**
 * SR-M-3. A checkpoint is a page cursor plus remaining ids — bounded resume,
 * not a payload store. A config snapshot is one source's config. Both are
 * bounded by their serialized length so an adapter cannot grow history without
 * limit; `length(x::text)` is deterministic, unlike `pg_column_size`, which
 * depends on compression.
 */
export const JOB_JSONB_TEXT_MAX = 8192
