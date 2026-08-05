import { describe, it, expect } from 'vitest'
import { sanitizeDownloadFilename } from './filename'

// Unicode bidi-override control characters, built from code points (never
// pasted as literal characters into this source file) so the raw bytes
// under test are explicit and the file itself stays plain ASCII.
const RLO = String.fromCodePoint(0x202e) // RIGHT-TO-LEFT OVERRIDE
const LRO = String.fromCodePoint(0x202d) // LEFT-TO-RIGHT OVERRIDE
const RLI = String.fromCodePoint(0x2067) // RIGHT-TO-LEFT ISOLATE
const NUL = String.fromCodePoint(0x0000)
const DEL = String.fromCodePoint(0x007f)

describe('sanitizeDownloadFilename', () => {
  it('leaves an ordinary name untouched (no over-stripping of legitimate characters)', () => {
    expect(sanitizeDownloadFilename("O'Brien-Petrenko Jr.")).toBe("O'Brien-Petrenko Jr.")
  })

  it('strips a double quote, backslash, CR and LF (backend Content-Disposition pin)', () => {
    expect(sanitizeDownloadFilename('Ev"il\\Name\r\n')).toBe('EvilName')
  })

  it('strips a forward slash (path separator has no business in a filename base)', () => {
    expect(sanitizeDownloadFilename('a/b/c')).toBe('abc')
  })

  // The actual threat this function was added to close (code-review round 3,
  // task-candidate-card-resume): RLO filename spoofing — a submitted name
  // that visually disguises a malicious extension as a harmless one.
  it('strips RIGHT-TO-LEFT OVERRIDE (RLO filename-spoofing)', () => {
    const spoofed = `cv${RLO}fdp.exe`
    const result = sanitizeDownloadFilename(spoofed)
    expect(result).not.toContain(RLO)
    expect(result).toBe('cvfdp.exe')
  })

  it('strips LEFT-TO-RIGHT OVERRIDE and RIGHT-TO-LEFT ISOLATE', () => {
    expect(sanitizeDownloadFilename(`a${LRO}b${RLI}c`)).toBe('abc')
  })

  it('strips C0/C1 control characters (NUL, DEL)', () => {
    expect(sanitizeDownloadFilename(`a${NUL}b${DEL}c`)).toBe('abc')
  })

  it('trims leading/trailing whitespace left behind after stripping', () => {
    expect(sanitizeDownloadFilename(`  Ivan${RLO}  `)).toBe('Ivan')
  })

  it('caps the result at the default max length (120)', () => {
    const long = 'a'.repeat(200)
    const result = sanitizeDownloadFilename(long)
    expect(result).toHaveLength(120)
  })

  it('respects a custom max length', () => {
    expect(sanitizeDownloadFilename('abcdefghij', 5)).toBe('abcde')
  })

  it('falls back to "file" when stripping leaves nothing usable', () => {
    expect(sanitizeDownloadFilename(`${RLO}${NUL}${DEL}`)).toBe('file')
  })

  it('falls back to "file" for an empty string', () => {
    expect(sanitizeDownloadFilename('')).toBe('file')
  })
})
