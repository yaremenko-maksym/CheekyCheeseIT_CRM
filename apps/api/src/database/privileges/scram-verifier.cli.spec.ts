/**
 * The deploy's verifier CLI agrees with `scram.ts`, takes its password on stdin, and
 * refuses what it cannot hash correctly.
 *
 * The CLI duplicates the derivation on purpose — it must run on a bare CI checkout with
 * no build and no `node_modules` (see its header). A duplicate that nobody compares is a
 * duplicate that drifts, so this spec runs the real file as a child process, with a fixed
 * salt, and requires its output to equal the TypeScript implementation's byte for byte.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scramSha256Verifier } from './scram'

const CLI = join(__dirname, 'scram-verifier.cli.mjs')
const SALT_HEX = '00112233445566778899aabbccddeeff'

function run(password: string, env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [CLI], {
    input: password,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim()
}

describe('scram-verifier.cli.mjs', () => {
  it('produces exactly what scram.ts produces for the same password and salt', () => {
    const password = 'f3a9c1d8e7b64520f3a9c1d8e7b64520'
    expect(run(password, { SCRAM_SALT_HEX: SALT_HEX })).toBe(
      scramSha256Verifier(password, { salt: Buffer.from(SALT_HEX, 'hex') }),
    )
  })

  it('agrees for a passphrase containing spaces', () => {
    const password = 'correct horse battery staple'
    expect(run(password, { SCRAM_SALT_HEX: SALT_HEX })).toBe(
      scramSha256Verifier(password, { salt: Buffer.from(SALT_HEX, 'hex') }),
    )
  })

  it('strips exactly one trailing newline, so `echo "$SECRET" |` works', () => {
    const password = 'hunter2'
    expect(run(`${password}\n`, { SCRAM_SALT_HEX: SALT_HEX })).toBe(
      run(password, { SCRAM_SALT_HEX: SALT_HEX }),
    )
  })

  it('does not trim other whitespace, because trimming is how a wrong password gets set', () => {
    expect(run('hunter2 ', { SCRAM_SALT_HEX: SALT_HEX })).not.toBe(
      run('hunter2', { SCRAM_SALT_HEX: SALT_HEX }),
    )
  })

  it('refuses an empty password', () => {
    expect(() => run('')).toThrow()
  })

  it('refuses a non-ASCII password', () => {
    expect(() => run('пароль')).toThrow()
  })

  it('uses a fresh random salt when none is supplied', () => {
    expect(run('hunter2')).not.toBe(run('hunter2'))
  })

  it('ORCH-L-2: refuses an invalid SCRAM_SALT_HEX instead of silently shortening the salt', () => {
    // `Buffer.from(hex, 'hex')` stops at the first invalid pair and returns what it got —
    // so `SCRAM_SALT_HEX=oops` yielded a ZERO-BYTE salt and a verifier the server accepts.
    // A silently weakened salt is worse than a refusal: it is a working credential with
    // less entropy than anyone reading the deploy log would believe.
    for (const bad of ['oops', 'abc', '00112233445566778899aabbccddeefg', '']) {
      expect(() => run('hunter2', { SCRAM_SALT_HEX: bad })).toThrow()
    }
  })

  it('ORCH-L-2: refuses a salt that is valid hex but too short to be a salt', () => {
    // 15 bytes of perfectly good hex. PostgreSQL's own default is 16, and the whole point
    // of a salt is its length, so "parses" is not the bar.
    expect(() => run('hunter2', { SCRAM_SALT_HEX: '00112233445566778899aabbccddee' })).toThrow()
    expect(() =>
      run('hunter2', { SCRAM_SALT_HEX: '00112233445566778899aabbccddeeff' }),
    ).not.toThrow()
  })

  it('ORCH-L-3: writes exactly one trailing newline and nothing else', () => {
    // Every other test here compares `.trim()`ed output, so the framing was unasserted. It
    // is load-bearing twice: the value is interpolated into a `-c crm_roles.app_verifier=`
    // connection option, where an embedded newline is a malformed option rather than a bad
    // password, and `$(…)` strips ALL trailing newlines, so a drift from one to two would
    // be invisible in the deploy and visible only here.
    const raw = execFileSync(process.execPath, [CLI], {
      input: 'hunter2',
      encoding: 'utf8',
      env: { ...process.env, SCRAM_SALT_HEX: SALT_HEX },
    })
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.endsWith('\n\n')).toBe(false)
    expect(raw.slice(0, -1)).not.toContain('\n')
  })
})
