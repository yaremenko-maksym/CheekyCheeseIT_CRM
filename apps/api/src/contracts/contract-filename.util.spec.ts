import { describe, expect, it } from 'vitest'
import { safeContractFilename } from './contract-filename.util'

describe('safeContractFilename', () => {
  it('produces an ASCII-safe filename from a simple ASCII name', () => {
    const { asciiName, contentDisposition } = safeContractFilename('John Smith', 'SIGNED')
    expect(asciiName).toMatch(/^[A-Za-z0-9._-]+\.pdf$/)
    expect(contentDisposition).toContain('filename=')
    expect(contentDisposition).toContain('contract-')
  })

  it('strips quotes and newlines from displayName (injection guard)', () => {
    const { asciiName } = safeContractFilename('Иван "Quote"\nИванов', 'SIGNED')
    // No quotes, no newlines in ASCII fallback
    expect(asciiName).not.toMatch(/["'\n\r]/)
    expect(asciiName).toMatch(/^[A-Za-z0-9._-]+\.pdf$/)
  })

  it('collapses spaces to hyphens', () => {
    const { asciiName } = safeContractFilename('First Last Name', 'DRAFT')
    expect(asciiName).toContain('-')
    expect(asciiName).not.toContain(' ')
  })

  it('handles empty / whitespace-only name gracefully', () => {
    const { asciiName } = safeContractFilename('', 'DRAFT')
    expect(asciiName).toMatch(/^[A-Za-z0-9._-]+\.pdf$/)

    const { asciiName: ws } = safeContractFilename('   ', 'DRAFT')
    expect(ws).toMatch(/^[A-Za-z0-9._-]+\.pdf$/)
  })

  it('produces RFC 5987 filename* for non-ASCII names', () => {
    const { contentDisposition } = safeContractFilename('Іваненко Іван', 'DRAFT')
    expect(contentDisposition).toContain("filename*=UTF-8''")
    // UTF-8 percent-encoding: Cyrillic chars should be percent-encoded
    // Use string contains — regex * requires escaping, simpler to use toContain
    expect(contentDisposition).toContain('%')
  })

  it('uses "preview" prefix for non-SIGNED status', () => {
    const { asciiName } = safeContractFilename('Test User', 'DRAFT')
    expect(asciiName).toMatch(/^contract-preview-/)
  })

  it('uses plain "contract" prefix for SIGNED status', () => {
    const { asciiName } = safeContractFilename('Test User', 'SIGNED')
    expect(asciiName).toMatch(/^contract-/)
    expect(asciiName).not.toMatch(/^contract-preview-/)
  })

  it('Content-Disposition has both filename= and filename*= parts', () => {
    const { contentDisposition } = safeContractFilename('Тест Юзер', 'SIGNED')
    expect(contentDisposition).toContain('filename=')
    expect(contentDisposition).toContain('filename*=UTF-8')
  })
})
