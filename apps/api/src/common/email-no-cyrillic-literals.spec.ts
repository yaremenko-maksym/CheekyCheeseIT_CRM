/**
 * Close-out guard of the email i18n migration (plan 2026-10-03-crm-i18n-emails, PR3).
 *
 * Every user-visible phrase of an outgoing email lives in the `@crm/shared` catalog and is
 * rendered in the RECIPIENT's locale. A Cyrillic string literal in an email module is therefore
 * a regression: a hard-coded phrase that bypasses the catalog and reaches an `en` recipient in
 * the wrong language.
 *
 * The check parses each module with the TypeScript compiler API and inspects only string-ish
 * AST nodes. Comments are trivia, not nodes, so Russian explanations stay legal by construction
 * (no regex-over-source false positives). Product wording (not comments) is what is guarded.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const CYRILLIC = /[А-Яа-яЁёІіЇїЄєҐґ]/

/** Email modules, relative to `apps/api/src`. Explicit on purpose: a rename must fail loudly. */
const EMAIL_MODULES = [
  'common/email-layout.ts',
  'notifications/notification-email-copy.ts',
  'notifications/notification-email.cron.ts',
  'users/personal-email-invite-mailer.service.ts',
] as const

/** Overridable so the guard can be pointed at a historical snapshot to prove it goes red. */
const SRC_ROOT = process.env.EMAIL_GUARD_SRC_ROOT ?? join(__dirname, '..')

/** Text of every string literal / template chunk in `source` that contains Cyrillic. */
export function findCyrillicLiterals(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (CYRILLIC.test(node.text)) found.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

describe('email modules carry no Cyrillic string literals', () => {
  describe('guard self-test (it can go red)', () => {
    it('flags a Cyrillic literal in code and ignores one in a comment', () => {
      const source = [
        '// Привет — комментарий, не находка',
        "const ok = 'hello'",
        "const bad = 'Привіт'",
        '/* ещё комментарий: Ёж */',
      ].join('\n')
      expect(findCyrillicLiterals('inline.ts', source)).toEqual(['Привіт'])
    })

    it('flags Cyrillic inside template literal parts', () => {
      expect(findCyrillicLiterals('t.ts', 'const a = `ліво ${x} право`')).toEqual([
        'ліво ',
        ' право',
      ])
      expect(findCyrillicLiterals('t.ts', 'const a = `щось`')).toEqual(['щось'])
    })

    it('stays silent on Latin-only code', () => {
      expect(findCyrillicLiterals('t.ts', "const a = 'x'; const b = `y ${a}`")).toEqual([])
    })
  })

  describe.each(EMAIL_MODULES)('%s', (relPath) => {
    const abs = join(SRC_ROOT, relPath)

    it('exists (a rename must update this list)', () => {
      expect(existsSync(abs)).toBe(true)
    })

    it('has no Cyrillic in string or template literals', () => {
      expect(findCyrillicLiterals(relPath, readFileSync(abs, 'utf8'))).toEqual([])
    })
  })
})
