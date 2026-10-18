#!/usr/bin/env node
/**
 * Reads a password on STDIN, prints its SCRAM-SHA-256 verifier on STDOUT.
 *
 *   APP_VERIFIER="$(printf %s "$CRM_APP_DB_PASSWORD" | node apps/api/src/database/privileges/scram-verifier.cli.mjs)"
 *
 * STDIN and not an argument, deliberately: any value in a command's argv is readable by
 * any local user through `ps` (ADR §4, trap 2), and that applies to the CI runner as much
 * as to the VPS.
 *
 * Plain `.mjs` with no imports beyond `node:crypto`, deliberately: the deploy runs this on
 * a CI runner with a bare checkout, before and independently of any build, so it must not
 * need `tsx`, a build step or `node_modules`. The logic is duplicated from
 * `scram.ts` — a short, pinned derivation — and
 * `scram-verifier.cli.spec.ts` runs this file against that one and requires identical
 * output, so the copy cannot drift.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

const ITERATIONS = 4096

function read(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (c) => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}

function verifier(password, salt) {
  const saltedPassword = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest()
  return `SCRAM-SHA-256$${ITERATIONS}:${salt.toString('base64')}$${storedKey.toString(
    'base64',
  )}:${serverKey.toString('base64')}`
}

const raw = await read(process.stdin)
// One trailing newline is what `echo` adds and what a secret never contains; anything
// else is passed through, because trimming a password is how a wrong one gets set.
const password = raw.endsWith('\n') ? raw.slice(0, -1) : raw

if (password.length === 0) {
  process.stderr.write('scram-verifier: empty password on stdin — refusing\n')
  process.exit(2)
}
if (!/^[\x20-\x7e]+$/.test(password)) {
  process.stderr.write(
    'scram-verifier: password must be printable ASCII (SASLprep is not implemented)\n',
  )
  process.exit(2)
}

// A fixed salt may be supplied ONLY so the spec can compare this file's output with
// `scram.ts` byte for byte; the deploy never sets it. By environment variable rather than
// an argument, for the same reason the password comes in on stdin.
const saltHex = process.env.SCRAM_SALT_HEX
const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(16)
process.stdout.write(`${verifier(password, salt)}\n`)
