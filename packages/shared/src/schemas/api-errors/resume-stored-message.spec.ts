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

  const decode = (stored: string | null) =>
    decodeResumeMessage(stored, 'RESUME_ERROR_DETAILS_UNAVAILABLE')

  it('decodes what it encoded', () => {
    expect(decode('{"code":"RESUME_DOCX_TOO_LARGE","params":{"mb":50}}')).toEqual({
      code: 'RESUME_DOCX_TOO_LARGE',
      params: { mb: 50 },
    })
    expect(decode('{"code":"RESUME_RENDER_FAILED"}')).toEqual({ code: 'RESUME_RENDER_FAILED' })
  })

  it('a legacy Russian row, null, broken JSON and non-object JSON decode to null (shown verbatim)', () => {
    expect(decode('Не удалось собрать PDF резюме.')).toBeNull()
    expect(decode(null)).toBeNull()
    expect(decode('{not json')).toBeNull()
    expect(decode('123')).toBeNull()
    expect(decode('[]')).toBeNull()
    expect(decode('{"message":"no code key"}')).toBeNull()
    expect(decode('{"code":42}')).toBeNull()
  })

  // QA-LOW-3: our JSON shape with a code this build does not know shows the area's generic line.
  it('our shape with an unknown code decodes to the fallback code', () => {
    expect(decode('{"code":"GENERIC"}')).toEqual({ code: 'RESUME_ERROR_DETAILS_UNAVAILABLE' })
    expect(
      decodeResumeMessage('{"code":"RESUME_FROM_THE_FUTURE"}', 'RESUME_RENDER_FAILED'),
    ).toEqual({ code: 'RESUME_RENDER_FAILED' })
  })

  // QA-LOW-2: a line rendered without its param would read "larger than  MB".
  it('a known code missing a required param, or with a malformed one, decodes to the fallback code', () => {
    expect(decode('{"code":"RESUME_FILE_TOO_LARGE"}')).toEqual({
      code: 'RESUME_ERROR_DETAILS_UNAVAILABLE',
    })
    expect(decode('{"code":"RESUME_FILE_TOO_LARGE","params":{"max":10}}')).toEqual({
      code: 'RESUME_ERROR_DETAILS_UNAVAILABLE',
    })
    expect(decode('{"code":"RESUME_NO_TEXT","params":{"x":{}}}')).toEqual({
      code: 'RESUME_ERROR_DETAILS_UNAVAILABLE',
    })
  })

  it('a param the line does not need does not demote a valid code', () => {
    expect(decode('{"code":"RESUME_NO_TEXT","params":{"x":1}}')).toEqual({
      code: 'RESUME_NO_TEXT',
      params: { x: 1 },
    })
  })
})
