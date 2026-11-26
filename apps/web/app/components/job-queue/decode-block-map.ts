import { z } from 'zod'
import { BLOCKS_MAX, pageBlockSchema, type PageBlock } from '@crm/shared'

/** Inflated bytes past which a block map is refused: a crafted link must not deflate-bomb the tab. */
export const INFLATED_MAX = 256 * 1024

const blockMapSchema = z.array(pageBlockSchema).min(1).max(BLOCKS_MAX)

/**
 * The bookmarklet's `b` (JSON, `deflate-raw`, base64url — `encodeBlockMap`) back to blocks, each
 * one checked against `pageBlockSchema`. `null` on any failure: the dialog then behaves as without a map.
 */
export async function decodeBlockMap(b: string): Promise<PageBlock[] | null> {
  try {
    const packed = Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    )
    const reader = (new Response(packed).body as ReadableStream<Uint8Array<ArrayBuffer>>)
      .pipeThrough(new DecompressionStream('deflate-raw'))
      .getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > INFLATED_MAX) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      await new Blob(chunks).arrayBuffer(),
    )
    const parsed = blockMapSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
