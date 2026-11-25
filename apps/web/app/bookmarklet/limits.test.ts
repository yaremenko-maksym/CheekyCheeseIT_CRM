import {
  BLOCK_TEXT_MAX,
  BLOCKS_MAX,
  EXTERNAL_PREFILL_HASH_MAX,
  type PageBlock as SharedPageBlock,
} from '@crm/shared'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { PageBlock as BookmarkletPageBlock } from './blocks'
import {
  BLOCK_TEXT_MAX as BM_BLOCK_TEXT_MAX,
  BLOCKS_MAX as BM_BLOCKS_MAX,
  HASH_MAX,
} from './limits'
import { PREFILL_HASH_MAX } from '../lib/external-prefill'

describe('bookmarklet limit parity with @crm/shared', () => {
  it('mirrors the prefill hash ceiling across shared, bookmarklet and web ingest', () => {
    expect(EXTERNAL_PREFILL_HASH_MAX).toBe(HASH_MAX)
    expect(EXTERNAL_PREFILL_HASH_MAX).toBe(PREFILL_HASH_MAX)
  })

  it('mirrors the block count and block text ceilings between shared and bookmarklet', () => {
    expect(BLOCKS_MAX).toBe(BM_BLOCKS_MAX)
    expect(BLOCK_TEXT_MAX).toBe(BM_BLOCK_TEXT_MAX)
  })

  it('preserves exact type-level parity between shared and bookmarklet PageBlock', () => {
    expectTypeOf<SharedPageBlock>().toEqualTypeOf<BookmarkletPageBlock>()
  })
})
