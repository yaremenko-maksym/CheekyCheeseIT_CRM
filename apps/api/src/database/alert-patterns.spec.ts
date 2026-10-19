import { describe, expect, it } from 'vitest'
import {
  ALERT_CONTRACT_PATTERN,
  ALERT_PATTERN,
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

  it('the exported constants are exactly what the flags print, case-insensitive', () => {
    expect(ALERT_CONTRACT_PATTERN.source).toBe(readAlertPattern('--print-contract-pattern'))
    expect(ALERT_PATTERN.source).toBe(readAlertPattern('--print-pattern'))
    expect(ALERT_CONTRACT_PATTERN.flags).toBe('i')
    expect(ALERT_PATTERN.flags).toBe('i')
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
