import { describe, expect, it } from 'vitest'
import {
  editPdfKey,
  isTailoredPdfKey,
  runPdfKey,
  TAILORED_RESUMES_PREFIX,
  tailoredPrefix,
} from './tailored-keys'

describe('tailored resume S3 keys (D14)', () => {
  it('a row owns the prefix tailored-resumes/<rowId>/', () => {
    expect(TAILORED_RESUMES_PREFIX).toBe('tailored-resumes/')
    expect(tailoredPrefix('r')).toBe('tailored-resumes/r/')
  })

  it('a run PDF is run-<runId>.pdf under the row prefix', () => {
    expect(runPdfKey('r', 'u')).toBe('tailored-resumes/r/run-u.pdf')
    expect(runPdfKey('r', 'u').startsWith(tailoredPrefix('r'))).toBe(true)
  })

  it('an edit re-render PDF is edit-<renderId>.pdf under the row prefix', () => {
    expect(editPdfKey('r', 'e')).toBe('tailored-resumes/r/edit-e.pdf')
  })

  it('the sweep owns only the run and edit key shapes', () => {
    expect(isTailoredPdfKey('tailored-resumes/r/run-u.pdf')).toBe(true)
    expect(isTailoredPdfKey('tailored-resumes/r/edit-e.pdf')).toBe(true)
    expect(isTailoredPdfKey(runPdfKey('row-1', 'run-ab12'))).toBe(true)
    expect(isTailoredPdfKey(editPdfKey('row-1', 'edit-cd34'))).toBe(true)
    expect(isTailoredPdfKey('tailored-resumes/r/other.pdf')).toBe(false)
    expect(isTailoredPdfKey('tailored-resumes/r/run-u.png')).toBe(false)
    expect(isTailoredPdfKey('tailored-resumes/r/x/run-u.pdf')).toBe(false)
    expect(isTailoredPdfKey('x/tailored-resumes/r/run-u.pdf')).toBe(false)
    expect(isTailoredPdfKey('tailored-resumes/r/run-u.pdf.bak')).toBe(false)
    expect(isTailoredPdfKey('tailored-resumes//run-u.pdf')).toBe(false)
    expect(isTailoredPdfKey('resumes/r/staged/run-u.pdf')).toBe(false)
  })
})
