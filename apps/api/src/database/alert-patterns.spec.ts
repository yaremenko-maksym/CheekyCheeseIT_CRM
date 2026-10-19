import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  alertContractPattern,
  alertPattern,
  findAlertScript,
  parsePrinted,
  readAlertPattern,
} from './__test-helpers__/alert-patterns'

/**
 * The alert PUBLISHES its patterns (`--print-pattern`, `--print-contract-pattern`) and this
 * package reads them. These tests pin the shape of that published interface, so that if the
 * alert changes how it prints them, the failure is here and says so — rather than a workaround
 * hiding it.
 */
describe('the alert’s published pattern interface', () => {
  it.each(['--print-pattern', '--print-contract-pattern'] as const)(
    '%s is byte-stable across invocations',
    (flag) => {
      expect(readAlertPattern(flag)).toBe(readAlertPattern(flag))
    },
  )

  it.each(['--print-pattern', '--print-contract-pattern'] as const)(
    '%s is something a RegExp constructor accepts, as one line',
    (flag) => {
      const printed = readAlertPattern(flag)
      expect(printed).not.toContain('\n')
      expect(() => new RegExp(printed, 'i')).not.toThrow()
    },
  )

  describe('findAlertScript walks up to the script, wherever the specs run from', () => {
    const SCRIPT_SUFFIX = join('scripts', 'devops', 'check-api-permission-denied.sh')

    it('finds it from deep inside the tree (Stryker runs from a deeper sandbox)', () => {
      const found = findAlertScript(join(__dirname, 'no', 'such', 'deeper', 'dir'))
      expect(found.endsWith(SCRIPT_SUFFIX)).toBe(true)
      expect(existsSync(found)).toBe(true)
    })

    it('finds it from the directory that holds it, on the first step', () => {
      const root = findAlertScript().slice(0, -SCRIPT_SUFFIX.length - 1)
      expect(findAlertScript(root)).toBe(join(root, SCRIPT_SUFFIX))
    })

    it('throws, naming where it looked, when no ancestor has it — and terminates at the root', () => {
      const outside = mkdtempSync(join(tmpdir(), 'no-alert-script-'))
      try {
        expect(() => findAlertScript(outside)).toThrow(/not found above .*no-alert-script-/)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  it('the pattern functions return exactly what the flags print, case-insensitive', () => {
    expect(alertContractPattern().source).toBe(readAlertPattern('--print-contract-pattern'))
    expect(alertPattern().source).toBe(readAlertPattern('--print-pattern'))
    expect(alertContractPattern().flags).toBe('i')
    expect(alertPattern().flags).toBe('i')
  })

  it('the full pattern is the contract plus the secondary text tier', () => {
    const contract = readAlertPattern('--print-contract-pattern')
    expect(readAlertPattern('--print-pattern').startsWith(`${contract}|`)).toBe(true)
  })

  it('the contract is anchored on the logger context and the SQLSTATE', () => {
    const contract = readAlertPattern('--print-contract-pattern')
    expect(contract).toContain('\\[DatabasePrivilege\\]')
    expect(contract).toContain('db_privilege_denied')
    expect(contract).toContain('sqlstate=42501')
  })

  describe('parsePrinted rejects any shape other than one newline-terminated line', () => {
    it('accepts exactly one non-empty line and strips its newline', () => {
      expect(parsePrinted('abc\n')).toBe('abc')
    })

    it.each([
      ['empty output', ''],
      ['only a newline', '\n'],
      ['no trailing newline', 'abc'],
      ['two lines', 'a\nb\n'],
      ['a trailing blank line', 'abc\n\n'],
      ['a leading blank line', '\nabc\n'],
    ])('throws on %s', (_name, output) => {
      expect(() => parsePrinted(output)).toThrow(/unexpected shape/)
    })
  })
})
