import { describe, expect, it } from 'vitest'
import { isS3NotFound } from './s3-not-found.util'

describe('isS3NotFound', () => {
  it.each([
    ['a NoSuchKey error', { name: 'NoSuchKey' }],
    ['a HEAD NotFound error', { name: 'NotFound' }],
    ['any error with HTTP 404 metadata', { name: 'Unknown', $metadata: { httpStatusCode: 404 } }],
  ])('is true for %s', (_label, error) => {
    expect(isS3NotFound(error)).toBe(true)
  })

  it.each([
    ['a timeout', { name: 'TimeoutError', $metadata: { httpStatusCode: 500 } }],
    ['an error without metadata', { name: 'AccessDenied' }],
    ['null', null],
    ['a string', 'NoSuchKey'],
  ])('is false for %s', (_label, error) => {
    expect(isS3NotFound(error)).toBe(false)
  })
})
