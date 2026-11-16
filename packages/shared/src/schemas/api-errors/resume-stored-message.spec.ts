import { describe, expect, it } from 'vitest'
import { decodeResumeMessage, encodeResumeMessage } from './resume-stored-message'

describe('resume stored message (backlog 443)', () => {
  it('encodes a code without params as bare JSON', () => {
    expect(encodeResumeMessage('RESUME_NO_TEXT')).toBe('{"code":"RESUME_NO_TEXT"}')
  })

  it('encodes params next to the code', () => {
    expect(encodeResumeMessage('RESUME_PDF_TOO_MANY_PAGES', { max: 30 })).toBe(
      '{"code":"RESUME_PDF_TOO_MANY_PAGES","params":{"max":30}}',
    )
  })

  it('decodes what it encoded', () => {
    expect(decodeResumeMessage('{"code":"RESUME_DOCX_TOO_LARGE","params":{"mb":50}}')).toEqual({
      code: 'RESUME_DOCX_TOO_LARGE',
      params: { mb: 50 },
    })
    expect(decodeResumeMessage('{"code":"RESUME_RENDER_FAILED"}')).toEqual({
      code: 'RESUME_RENDER_FAILED',
    })
  })

  it('a legacy Russian row, null, broken JSON and a foreign code all decode to null', () => {
    expect(decodeResumeMessage('Не удалось собрать PDF резюме.')).toBeNull()
    expect(decodeResumeMessage(null)).toBeNull()
    expect(decodeResumeMessage('{not json')).toBeNull()
    expect(decodeResumeMessage('{"code":"GENERIC"}')).toBeNull()
    expect(decodeResumeMessage('{"code":"RESUME_NO_TEXT","params":{"x":{}}}')).toBeNull()
  })
})
