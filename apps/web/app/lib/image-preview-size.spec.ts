import { describe, expect, it } from 'vitest'
import { boundedSize } from './image-preview-size'

describe('boundedSize (task-ios-file-input-freeze)', () => {
  it('bounds a landscape 4000×3000 photo to a 1024 px long edge', () => {
    expect(boundedSize(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 })
  })

  it('bounds a portrait 3000×4000 photo by its height', () => {
    expect(boundedSize(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 })
  })

  it('returns null for an image that already fits (no upscaling, no re-encode)', () => {
    expect(boundedSize(1024, 600, 1024)).toBeNull()
    expect(boundedSize(800, 600, 1024)).toBeNull()
  })

  it('rounds to whole pixels', () => {
    expect(boundedSize(4032, 3024, 1000)).toEqual({ width: 1000, height: 750 })
    expect(boundedSize(3001, 2001, 1000)).toEqual({ width: 1000, height: 667 })
  })
})
