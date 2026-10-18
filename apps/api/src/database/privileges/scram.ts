/**
 * Builds the SCRAM-SHA-256 verifier PostgreSQL stores in `pg_authid.rolpassword`, so the
 * deploy can set a role's password without ever sending the password itself.
 *
 * WHY (ADR §4, "Password handling in file 1", trap 1)
 * ---------------------------------------------------
 * `log_min_error_statement` defaults to `error`, so a FAILING statement is written to the
 * server log with its full text — an `ALTER ROLE … PASSWORD 'plain'` that fails on a typo
 * in the role name puts the plain password in the log, whatever `log_statement` says.
 * PostgreSQL stores a `PASSWORD` value that already looks like a verifier verbatim, so
 * computing it off-server removes the password from the statement entirely.
 *
 * THE FORMAT (RFC 5802 §3, PostgreSQL `scram_build_secret`)
 * ---------------------------------------------------------
 *   SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 StoredKey>:<base64 ServerKey>
 *   SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, iterations, 32 bytes)
 *   StoredKey      = SHA-256(HMAC(SaltedPassword, "Client Key"))
 *   ServerKey      = HMAC(SaltedPassword, "Server Key")
 *
 * SASLprep IS NOT IMPLEMENTED, AND THAT IS WHY NON-ASCII THROWS
 * ------------------------------------------------------------
 * PostgreSQL normalises a non-ASCII password with SASLprep (RFC 4013) before hashing. For
 * ASCII input normalisation is the identity, which covers the secrets this is for
 * (`openssl rand -hex 32`). Implementing SASLprep for a hex secret would be dead code;
 * guessing at it would produce a verifier the server rejects at login, and the failure
 * would reach the owner as "crm_app cannot log in" after a deploy. So it refuses instead.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

/** The shape of a stored verifier — shared with the SQL guard in the roles file. */
export const SCRAM_VERIFIER_PATTERN =
  /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/

/** PostgreSQL's own default (`scram_sha_256_iterations`); never go below it. */
export const DEFAULT_ITERATIONS = 4096

const SALT_BYTES = 16
const KEY_BYTES = 32

export function scramSha256Verifier(
  password: string,
  options: { salt?: Buffer; iterations?: number } = {},
): string {
  if (password.length === 0) {
    throw new Error('scram: refusing to build a verifier for an empty password')
  }
  // Printable ASCII INCLUDING space (0x20): SASLprep maps non-ASCII spaces to a plain
  // space and leaves a plain space alone, so a passphrase is as safe as a hex secret.

  if (!/^[\x20-\x7e]+$/.test(password)) {
    throw new Error(
      'scram: password must be printable ASCII — SASLprep (RFC 4013) is not implemented here, ' +
        'and a non-normalised verifier would be rejected at login',
    )
  }
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  if (iterations < DEFAULT_ITERATIONS) {
    throw new Error(`scram: iterations must be at least ${DEFAULT_ITERATIONS}`)
  }

  const salt = options.salt ?? randomBytes(SALT_BYTES)
  const saltedPassword = pbkdf2Sync(password, salt, iterations, KEY_BYTES, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest()

  return [
    `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}`,
    `${storedKey.toString('base64')}:${serverKey.toString('base64')}`,
  ].join('$')
}
