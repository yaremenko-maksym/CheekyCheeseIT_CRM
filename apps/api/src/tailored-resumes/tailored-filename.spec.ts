import { describe, expect, it } from 'vitest'
import { tailoredFilename } from './tailored-filename'

describe('tailoredFilename (D15)', () => {
  it('builds "<name> - <title> - CV.pdf" in both forms', () => {
    expect(tailoredFilename('Jane Doe', 'Senior Go Engineer')).toEqual({
      ascii: 'Jane Doe - Senior Go Engineer - CV.pdf',
      utf8: 'Jane%20Doe%20-%20Senior%20Go%20Engineer%20-%20CV.pdf',
    })
  })

  it('strips "/", quotes and CR/LF, and collapses the gaps', () => {
    expect(tailoredFilename('Jane "J" Doe', 'Dev/Ops\r\nLead').ascii).toBe(
      'Jane J Doe - DevOpsLead - CV.pdf',
    )
    expect(tailoredFilename("O'Neil\\x", 'A\n\nB').ascii).toBe('ONeilx - AB - CV.pdf')
  })

  it('keeps the allowed punctuation .,&()-', () => {
    expect(tailoredFilename('J. Doe', 'R&D (Go), Sr.-Lead').ascii).toBe(
      'J. Doe - R&D (Go), Sr.-Lead - CV.pdf',
    )
    // RFC 5987 attr-char excludes the parentheses, so the extended form encodes them too.
    expect(tailoredFilename('J. Doe', 'R&D (Go)').utf8).toBe(
      'J.%20Doe%20-%20R%26D%20%28Go%29%20-%20CV.pdf',
    )
  })

  it('collapses whitespace runs and trims each part', () => {
    expect(tailoredFilename('  Jane \t  Doe ', '  Go  ').ascii).toBe('Jane Doe - Go - CV.pdf')
  })

  it('cuts each part at 80 characters', () => {
    const name = 'N'.repeat(100)
    const title = `${'T'.repeat(79)} X`
    const { ascii } = tailoredFilename(name, title)
    expect(ascii).toBe(`${'N'.repeat(80)} - ${'T'.repeat(79)} - CV.pdf`)
  })

  it('drops a part that reduces to nothing', () => {
    expect(tailoredFilename('Ім’я', 'Go').ascii).toBe('Go - CV.pdf')
    expect(tailoredFilename('', '').ascii).toBe('CV.pdf')
  })

  it('never lets a header-breaking character into either form', () => {
    const { ascii, utf8 } = tailoredFilename('a"b;c\r\n', 'x\\y/z')
    expect(ascii).not.toMatch(/["\\/\r\n;]/u)
    expect(utf8).not.toMatch(/["\\/\r\n;']/u)
  })
})
