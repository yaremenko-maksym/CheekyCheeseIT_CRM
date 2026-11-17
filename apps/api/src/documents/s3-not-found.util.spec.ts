import { describe, expect, it } from 'vitest'
import { isS3NoSuchKey, isS3NotFound } from './s3-not-found.util'

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

// GetObject names a missing object NoSuchKey; a missing bucket is also HTTP 404 and must not pass.
describe('isS3NoSuchKey', () => {
  it.each([
    ['a NoSuchKey name', { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }],
    ['a NoSuchKey code', { name: 'S3ServiceException', Code: 'NoSuchKey' }],
  ])('is true for %s', (_label, error) => {
    expect(isS3NoSuchKey(error)).toBe(true)
  })

  it.each([
    ['NoSuchBucket with HTTP 404', { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }],
    ['a NoSuchBucket code', { name: 'S3ServiceException', Code: 'NoSuchBucket' }],
    ['a HEAD NotFound', { name: 'NotFound', $metadata: { httpStatusCode: 404 } }],
    ['a bare HTTP 404', { name: 'Unknown', $metadata: { httpStatusCode: 404 } }],
    ['null', null],
    ['a string', 'NoSuchKey'],
  ])('is false for %s', (_label, error) => {
    expect(isS3NoSuchKey(error)).toBe(false)
  })

  it('is false for a function, even one named NoSuchKey: only an error object counts', () => {
    expect(isS3NoSuchKey(function NoSuchKey() {})).toBe(false)
  })
})
