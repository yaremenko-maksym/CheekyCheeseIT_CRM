import { describe, expect, it } from 'vitest'
import {
  conditionalHeadersOf,
  parseStoredValidators,
  validatorsOf,
  validatorsPatchOf,
} from './stored-validators'

const URL_ = 'https://feeds.example.com/jobs.xml'
const MODIFIED = 'Wed, 21 Oct 2026 07:28:00 GMT'
const BOTH = { url: URL_, etag: '"v1"', lastModified: MODIFIED }

describe('parseStoredValidators', () => {
  it('accepts a stored value as it is', () => {
    expect(parseStoredValidators(BOTH)).toEqual(BOTH)
    expect(parseStoredValidators({ url: URL_, etag: '"v1"', lastModified: null })).not.toBeNull()
    expect(parseStoredValidators({ url: URL_, etag: null, lastModified: MODIFIED })).not.toBeNull()
  })

  it.each([null, undefined, 'x', 42, {}, { url: URL_ }])('reads %j as no validators', (value) => {
    expect(parseStoredValidators(value)).toBeNull()
  })

  it('refuses a value with neither validator: there is nothing to send', () => {
    expect(parseStoredValidators({ url: URL_, etag: null, lastModified: null })).toBeNull()
  })

  it('bounds each field, accepting the bound itself', () => {
    const url = (n: number) =>
      `https://h.example.com/${'a'.repeat(n - 'https://h.example.com/'.length)}`
    expect(parseStoredValidators({ ...BOTH, url: url(1024) })).not.toBeNull()
    expect(parseStoredValidators({ ...BOTH, url: url(1025) })).toBeNull()
    expect(parseStoredValidators({ ...BOTH, url: '' })).toBeNull()
    expect(parseStoredValidators({ ...BOTH, etag: 'e'.repeat(512) })).not.toBeNull()
    expect(parseStoredValidators({ ...BOTH, etag: 'e'.repeat(513) })).toBeNull()
    expect(parseStoredValidators({ ...BOTH, lastModified: 'm'.repeat(128) })).not.toBeNull()
    expect(parseStoredValidators({ ...BOTH, lastModified: 'm'.repeat(129) })).toBeNull()
  })

  it('refuses a value that could not travel as a header (CR/LF, non-ASCII)', () => {
    expect(parseStoredValidators({ ...BOTH, etag: '"a"\r\nx: y' })).toBeNull()
    expect(parseStoredValidators({ ...BOTH, etag: '"é"' })).toBeNull()
    expect(parseStoredValidators({ ...BOTH, lastModified: `${MODIFIED}\n` })).toBeNull()
  })

  it('refuses an empty validator rather than sending an empty header', () => {
    expect(parseStoredValidators({ ...BOTH, etag: '' })).toBeNull()
  })
})

describe('validatorsOf', () => {
  it('keeps the values verbatim, with the URL they came from', () => {
    expect(validatorsOf(URL_, { etag: 'W/"v1"', lastModified: MODIFIED })).toEqual({
      url: URL_,
      etag: 'W/"v1"',
      lastModified: MODIFIED,
    })
  })

  it('stores the one validator the host showed', () => {
    expect(validatorsOf(URL_, { etag: '"v1"', lastModified: null })).toEqual({
      url: URL_,
      etag: '"v1"',
      lastModified: null,
    })
    expect(validatorsOf(URL_, { etag: null, lastModified: MODIFIED })).toEqual({
      url: URL_,
      etag: null,
      lastModified: MODIFIED,
    })
  })

  it('treats a blank value as absent', () => {
    expect(validatorsOf(URL_, { etag: '   ', lastModified: MODIFIED })).toEqual({
      url: URL_,
      etag: null,
      lastModified: MODIFIED,
    })
    expect(validatorsOf(URL_, { etag: '', lastModified: null })).toBeNull()
  })

  it('is null when the host showed none, or only a value that cannot be sent', () => {
    expect(validatorsOf(URL_, { etag: null, lastModified: null })).toBeNull()
    expect(validatorsOf(URL_, { etag: '"a"\r\nx: y', lastModified: null })).toBeNull()
  })
})

describe('conditionalHeadersOf', () => {
  it('asks with both validators', () => {
    expect(conditionalHeadersOf(BOTH)).toEqual({
      'if-none-match': '"v1"',
      'if-modified-since': MODIFIED,
    })
  })

  it('asks with only the validator that exists', () => {
    expect(conditionalHeadersOf({ ...BOTH, lastModified: null })).toEqual({
      'if-none-match': '"v1"',
    })
    expect(conditionalHeadersOf({ ...BOTH, etag: null })).toEqual({
      'if-modified-since': MODIFIED,
    })
  })
})

describe('validatorsPatchOf', () => {
  it('a SUCCEEDED run stores the validators it showed', () => {
    expect(validatorsPatchOf('SUCCEEDED', { nextValidators: BOTH })).toBe(
      JSON.stringify({ validators: BOTH }),
    )
  })

  it('a SUCCEEDED run that showed none drops the stored ones', () => {
    expect(validatorsPatchOf('SUCCEEDED', { nextValidators: null })).toBe('{}')
  })

  it.each(['FAILED', 'PARTIAL', 'CANCELLED', 'STARTED'])(
    'a %s run leaves the checkpoint alone',
    (outcome) => {
      expect(validatorsPatchOf(outcome, { nextValidators: BOTH })).toBeNull()
    },
  )

  it('a run that kept no metrics (recovery) leaves the checkpoint alone', () => {
    expect(validatorsPatchOf('SUCCEEDED', undefined)).toBeNull()
  })
})
