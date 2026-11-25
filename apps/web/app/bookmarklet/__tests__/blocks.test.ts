import { afterEach, describe, expect, it, vi } from 'vitest'

import { bytesToBase64Url, fromBase64Url } from '../../lib/base64url'
import {
  encodeBlockMap,
  fitBlockMap,
  mapTarget,
  readBlockMap,
  type Measure,
  type PageBlock,
} from '../blocks'
import { HASH_MAX } from '../limits'
import { crmTarget } from '../target'

const INLINE_TAGS = /^(span|b|i|a|em|strong)$/

/** A layout stand-in: `data-*` attributes say what a browser would have measured. */
const measure: Measure = (el) => ({
  x: 10,
  y: Number(el.getAttribute('data-y') ?? 20),
  w: el.hasAttribute('data-w0') ? 0 : 300,
  h: el.hasAttribute('data-h0') ? 0 : 18,
  fontSize: 16,
  fontWeight: el.localName === 'h1' ? 700 : 400,
  display: el.getAttribute('data-d') ?? (INLINE_TAGS.test(el.localName) ? 'inline' : 'block'),
  hidden: el.hasAttribute('data-hidden'),
})

const docOf = (body: string): Document =>
  new DOMParser().parseFromString(`<body>${body}</body>`, 'text/html')

const texts = (doc: Document): string[] => readBlockMap(doc, measure).map((b) => b.t)

const block = (t: string, r: PageBlock['r'] = 'main'): PageBlock => ({
  t,
  k: 'p',
  fs: 16,
  fw: 400,
  x: 0,
  y: 0,
  w: 100,
  r,
})

/** Base64url (no padding) to bytes, independent of the code under test. */
const bytesOf = (b64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

const inflate = async (b64: string): Promise<string> =>
  new Response(
    (new Response(bytesOf(b64)).body as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(
      new DecompressionStream('deflate-raw'),
    ),
  ).text()

const payloadOf = (url: string): Record<string, unknown> =>
  JSON.parse(fromBase64Url(String(url.split('#external=')[1]))) as Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readBlockMap', () => {
  it('groups inline runs into their block', () => {
    const blocks = readBlockMap(docOf('<p>Senior <b>Java</b> Engineer</p>'), measure)
    expect(blocks).toEqual([
      { t: 'Senior Java Engineer', k: 'p', fs: 16, fw: 400, x: 10, y: 20, w: 300, r: '-' },
    ])
  })

  it('treats inline-block and display:contents as part of the enclosing block', () => {
    const doc = docOf(
      '<h1>Lead <div data-d="inline-block">QA</div> <div data-d="contents">Engineer</div></h1>',
    )
    expect(readBlockMap(doc, measure)).toEqual([
      expect.objectContaining({ t: 'Lead QA Engineer', k: 'h1', fw: 700 }),
    ])
  })

  it('keeps the text after a nested block as its own block, in page order', () => {
    expect(texts(docOf('<div>before<p>inside</p>after</div>'))).toEqual([
      'before',
      'inside',
      'after',
    ])
  })

  it('drops invisible blocks', () => {
    const doc = docOf(
      [
        '<p>shown</p>',
        '<p data-hidden>hidden</p>',
        '<div data-hidden><p>hidden child</p></div>',
        '<p data-w0>no width</p>',
        '<p data-h0>no height</p>',
        '<div aria-hidden="true"><p>aria hidden</p></div>',
        '<script>var script = 1</script>',
        '<style>.style{}</style>',
        '<noscript>noscript</noscript>',
        '<template><p>template</p></template>',
      ].join(''),
    )
    expect(texts(doc)).toEqual(['shown'])
  })

  it('keeps the children of a zero-size block (a float container has no height)', () => {
    expect(texts(docOf('<div data-h0>own text<p>floated</p></div>'))).toEqual(['floated'])
  })

  it('drops blocks the browser renders with visibility:hidden or opacity:0', () => {
    document.body.innerHTML =
      '<p>shown</p><p style="visibility:hidden">invisible</p>' +
      '<div style="opacity:0"><p>transparent child</p></div>'
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 6, 200, 20))
    expect(readBlockMap(document).map((b) => b.t)).toEqual(['shown'])
    document.body.innerHTML = ''
  })

  it('marks the region', () => {
    const blocks = readBlockMap(
      docOf('<nav><a data-d="block">Jobs</a></nav><main><h1>Title</h1></main><p>loose</p>'),
      measure,
    )
    expect(blocks.map((b) => [b.t, b.r])).toEqual([
      ['Jobs', 'nav'],
      ['Title', 'main'],
      ['loose', '-'],
    ])
  })

  it('walks open shadow roots and same-origin iframes', () => {
    const doc = docOf(
      '<p>one</p><div id="host">light</div><p>three</p><iframe></iframe><p>five</p>',
    )
    const host = doc.getElementById('host') as HTMLElement
    const root = host.attachShadow({ mode: 'open' })
    // a browser computes display:contents for a slot
    root.innerHTML = '<p>two <slot data-d="contents"></slot></p>'
    Object.defineProperty(doc.querySelector('iframe'), 'contentDocument', {
      value: docOf('<p>four</p>'),
    })
    expect(texts(doc)).toEqual(['one', 'two light', 'three', 'four', 'five'])
  })

  it('skips only the iframe that refuses access', () => {
    const doc = docOf('<p>before</p><iframe></iframe><p>after</p>')
    Object.defineProperty(doc.querySelector('iframe'), 'contentDocument', {
      get() {
        throw new DOMException('Blocked a frame', 'SecurityError')
      },
    })
    expect(texts(doc)).toEqual(['before', 'after'])
  })

  it('caps the text of a block and the number of blocks', () => {
    const many = docOf(`<p>${'x'.repeat(2500)}</p>${'<p>n</p>'.repeat(700)}`)
    const blocks = readBlockMap(many, measure)
    expect(blocks).toHaveLength(600)
    expect(blocks[0]?.t).toHaveLength(2000)
  })
})

describe('fitBlockMap', () => {
  it('fitBlockMap cuts a nav/header/footer block text to 80 chars even under budget', () => {
    const blocks = [block('n'.repeat(100), 'nav'), block('h'.repeat(100), 'header')]
    blocks.push(block('f'.repeat(100), 'footer'), block('a'.repeat(100), 'aside'))
    const fitted = fitBlockMap(blocks, 100000)
    expect(fitted.map((b) => b.t.length)).toEqual([80, 80, 80, 100])
  })

  it('drops nav/header/footer blocks first when that is enough', () => {
    const blocks = [
      block('n'.repeat(80), 'nav'),
      block('a'.repeat(300)),
      block('f'.repeat(80), 'footer'),
    ]
    const max = JSON.stringify([block('a'.repeat(300))]).length
    expect(fitBlockMap(blocks, max)).toEqual([block('a'.repeat(300))])
  })

  it('then cuts the longest blocks, and the JSON of the result fits', () => {
    const blocks = [block('n'.repeat(80), 'nav'), block('a'.repeat(1000)), block('b'.repeat(10))]
    const max = 400
    const fitted = fitBlockMap(blocks, max)
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(max)
    expect(fitted.map((b) => b.r)).toEqual(['main', 'main'])
    expect(fitted[1]?.t).toBe('b'.repeat(10))
    expect(fitted[0]?.t.length).toBeGreaterThan(10)
    expect(fitted[0]?.t.length).toBeLessThan(1000)
    // the longest prefix that fits: one more character would not
    const longer = [
      { ...block(''), t: 'a'.repeat((fitted[0]?.t.length ?? 0) + 1) },
      block('b'.repeat(10)),
    ]
    expect(JSON.stringify(longer).length).toBeGreaterThan(max)
  })

  it('drops trailing blocks when even empty texts do not fit', () => {
    const fitted = fitBlockMap([block('a'), block('b'), block('c')], 140)
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(140)
    expect(fitted.length).toBeGreaterThan(0)
    expect(fitted.length).toBeLessThan(3)
  })
})

describe('encodeBlockMap', () => {
  it('encodeBlockMap round-trips through deflate-raw', async () => {
    const blocks = [block('Senior Java Engineer — Київ'), block('x'.repeat(5000), 'nav')]
    const encoded = await encodeBlockMap(blocks)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(await inflate(encoded))).toEqual(blocks)
    expect(encoded.length).toBeLessThan(JSON.stringify(blocks).length / 10)
  })
})

describe('bytesToBase64Url', () => {
  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const encoded = bytesToBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(Array.from(bytesOf(encoded))).toEqual(Array.from(bytes))
  })
})

describe('mapTarget', () => {
  const ORIGIN = 'https://app.example.com'
  const HREF = 'https://jobs.example.com/1'
  const hashOf = (url: string): string => String(url.split('#external=')[1])

  it('carries the encoded map as b next to the read vacancy', async () => {
    const doc = docOf('<main><h1>Senior Java Engineer</h1><p>We build things.</p></main>')
    const url = await mapTarget(ORIGIN, doc, HREF, '', measure)
    const payload = payloadOf(url)
    expect(JSON.parse(await inflate(String(payload.b)))).toEqual(readBlockMap(doc, measure))
    expect(payload.pageText).toBe('Senior Java Engineer\n\nWe build things.')
  })

  it('fits a long Cyrillic page with its map under HASH_MAX', async () => {
    const para = `<p>${'Обовʼязки: розробка сервісів, рев’ю коду. '.repeat(45)}</p>`
    const doc = docOf(`<main><h1>Розробник</h1>${para.repeat(30)}</main>`)
    const text = 'Ми шукаємо розробника в команду платформи. '.repeat(1500)
    const url = await mapTarget(ORIGIN, doc, HREF, text, measure)
    expect(hashOf(url).length).toBeLessThanOrEqual(HASH_MAX)
    const payload = payloadOf(url)
    expect(typeof payload.b).toBe('string')
    expect(String(payload.description).length).toBeGreaterThan(1000)
  })

  it('opens without b, base payload intact, when the map cannot fit', async () => {
    // A deflate that gains nothing on CJK text (3 UTF-8 bytes a character): even the third,
    // quarter-size try encodes to more than the half of the hash the vacancy leaves.
    vi.stubGlobal(
      'CompressionStream',
      class {
        constructor() {
          return new TransformStream()
        }
      },
    )
    const doc = docOf(`<p>${'漢'.repeat(2000)}</p>`.repeat(4))
    const selection = '字'.repeat(20000)
    const url = await mapTarget(ORIGIN, doc, HREF, selection, measure)
    vi.unstubAllGlobals()
    expect(hashOf(url).length).toBeLessThanOrEqual(HASH_MAX)
    expect(payloadOf(url).b).toBeUndefined()
    // the vacancy keeps the whole hash, as without a map
    expect(url).toBe(crmTarget(ORIGIN, doc, HREF, selection))
    expect(hashOf(url).length).toBeGreaterThan(HASH_MAX / 2)
  })

  it('opens without b when reading the map throws', async () => {
    const doc = docOf('<p>Senior Java Engineer</p>')
    const url = await mapTarget(ORIGIN, doc, HREF, '', () => {
      throw new Error('layout gone')
    })
    expect(payloadOf(url).b).toBeUndefined()
    expect(payloadOf(url).pageText).toBe('Senior Java Engineer')
  })

  it('opens without b when the page shows no block', async () => {
    const url = await mapTarget(ORIGIN, docOf('<p data-hidden>x</p>'), HREF, '', measure)
    expect(payloadOf(url).b).toBeUndefined()
  })
})
