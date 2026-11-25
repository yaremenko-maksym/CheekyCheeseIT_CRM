import { describe, expect, it } from 'vitest'
import { encodeBlockMap, type PageBlock } from '@/bookmarklet/blocks'
import { bytesToBase64Url } from '@/lib/base64url'
import { decodeBlockMap, INFLATED_MAX } from '../decode-block-map'

const block = (t: string, more: Partial<PageBlock> = {}): PageBlock => ({
  t,
  k: 'h1',
  fs: 24,
  fw: 700,
  x: 10,
  y: 20,
  w: 600,
  r: 'main',
  ...more,
})

/** Raw text deflated and base64url'd, the way the bookmarklet packs JSON. */
async function pack(text: string): Promise<string> {
  const stream = (new Response(text).body as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(
    new CompressionStream('deflate-raw'),
  )
  return bytesToBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()))
}

describe('decodeBlockMap', () => {
  it('inverts encodeBlockMap, Cyrillic text included', async () => {
    const blocks = [block('Senior Go-розробник'), block('Acme', { k: 'span', r: 'header' })]
    expect(await decodeBlockMap(await encodeBlockMap(blocks))).toEqual(blocks)
  })

  it('cuts a long tag name the way the request schema does', async () => {
    const out = await decodeBlockMap(await encodeBlockMap([block('x', { k: 'a'.repeat(100) })]))
    expect(out?.[0]?.k).toBe('a'.repeat(40))
  })

  it.each([
    ['broken base64', '!!!not base64!!!'],
    ['bytes that are not deflate', bytesToBase64Url(new Uint8Array([0xff, 0xff, 0xff, 0xff]))],
    ['an empty string', ''],
  ])('returns null for %s', async (_, b) => {
    expect(await decodeBlockMap(b)).toBeNull()
  })

  it.each([
    ['JSON that is not an array', JSON.stringify({ t: 'x' })],
    ['an empty array', '[]'],
    ['a block with an unknown key', JSON.stringify([{ ...block('x'), extra: 1 }])],
    ['a block with a bad region', JSON.stringify([{ ...block('x'), r: 'side' }])],
    ['not JSON at all', 'Senior Go developer'],
    ['more than 600 blocks', JSON.stringify(Array.from({ length: 601 }, () => block('x')))],
  ])('returns null for %s', async (_, json) => {
    expect(await decodeBlockMap(await pack(json))).toBeNull()
  })

  it('takes 600 blocks', async () => {
    const blocks = Array.from({ length: 600 }, () => block('x'))
    expect(await decodeBlockMap(await pack(JSON.stringify(blocks)))).toHaveLength(600)
  })

  it('stops a stream that inflates past 256 KB (a deflate bomb)', async () => {
    expect(INFLATED_MAX).toBe(256 * 1024)
    // valid JSON of exactly the cap passes; one byte more is refused
    const exact = (n: number) => {
      const head = JSON.stringify([block('x')]).slice(0, -1)
      return `${head},${JSON.stringify(block(''))}${' '.repeat(n - head.length - JSON.stringify(block('')).length - 2)}]`
    }
    expect(exact(INFLATED_MAX)).toHaveLength(INFLATED_MAX)
    expect(await decodeBlockMap(await pack(exact(INFLATED_MAX)))).toHaveLength(2)
    expect(await decodeBlockMap(await pack(exact(INFLATED_MAX + 1)))).toBeNull()
    // a few KB of zeros that inflate to megabytes
    expect(await decodeBlockMap(await pack(' '.repeat(8 * 1024 * 1024)))).toBeNull()
  })
})
