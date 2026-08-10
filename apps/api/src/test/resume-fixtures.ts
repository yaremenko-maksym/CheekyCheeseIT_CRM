/**
 * Test fixtures for task-resume-base: build REAL PDF and DOCX bytes in-process.
 *
 * Why build instead of committing binary fixtures:
 *   - AC1 wants both formats exercised end-to-end through the real parsers;
 *     a committed binary would be opaque and unreviewable,
 *   - AC2 and the zip-bomb guard need DELIBERATELY malformed archives (a
 *     central directory that lies about its uncompressed size), which no
 *     honest zip writer would ever emit — so the writer has to be ours,
 *   - no extra dependency: the only zip library in the tree (`jszip`) is a
 *     transitive dep of mammoth and is not resolvable from this package.
 *
 * The zip writer emits STORED (uncompressed) entries only — enough for
 * `mammoth`, and it keeps the code short and readable.
 */
import { deflateRawSync, deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts } from 'pdf-lib'

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** A real, parseable one-page PDF whose text layer contains `lines`. */
export async function buildPdfWithText(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  let y = 780
  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 11, font })
    y -= 16
  }
  return Buffer.from(await doc.save())
}

/** A real PDF with `pageCount` pages and no text — the "scanned CV" shape. */
export async function buildEmptyPdf(pageCount = 1): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pageCount; i += 1) doc.addPage([595, 842])
  return Buffer.from(await doc.save())
}

// ---------------------------------------------------------------------------
// ZIP / DOCX
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  data: Buffer
  /**
   * Override the uncompressed size written into the headers. Used to forge a
   * "zip bomb": tiny on disk, enormous by declaration.
   */
  declaredUncompressedSize?: number
  /**
   * DEFLATE the payload instead of storing it. Needed for the archive that
   * lies DOWNWARDS — declaring a harmless size while shipping a stream that
   * really does expand to hundreds of megabytes. A stored entry cannot lie
   * that way (its bytes are physically present), so only a compressed one can
   * express the attack a declaration-only guard misses.
   */
  deflate?: boolean
}

interface ZipOptions {
  /**
   * Force the entry count written into the End Of Central Directory record.
   * A tampered archive can claim zero entries to switch a count-driven walk —
   * and with it the whole size accounting — off entirely.
   */
  declaredEntryCount?: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Minimal ZIP writer (STORED or DEFLATE entries) — see the module doc. */
export function buildZip(entries: ZipEntry[], options: ZipOptions = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data
    const method = entry.deflate ? 8 : 0
    const size = entry.declaredUncompressedSize ?? entry.data.length
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + payload.length
  }

  const centralBuf = Buffer.concat(centrals)
  const declaredCount = options.declaredEntryCount ?? entries.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(declaredCount, 8)
  eocd.writeUInt16LE(declaredCount, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

function documentXml(paragraphs: string[]): string {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A real, mammoth-parseable .docx whose body contains `paragraphs`. */
export function buildDocx(paragraphs: string[]): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(paragraphs), 'utf8') },
  ])
}

/**
 * A DOCX-shaped archive whose central directory DECLARES a ~4 GB uncompressed
 * part while weighing a few hundred bytes — the classic zip bomb the guard has
 * to reject from metadata alone, before anything is inflated.
 */
export function buildDocxZipBomb(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    {
      name: 'word/document.xml',
      data: Buffer.from(documentXml(['bomb']), 'utf8'),
      declaredUncompressedSize: 4_000_000_000,
    },
  ])
}

/**
 * The bomb that a DECLARATION-ONLY guard waves through: the central directory
 * claims a harmless `declaredUncompressedSize`, while the entry really carries
 * a deflate stream that expands to `realBytes`.
 *
 * This is the shape the old guard missed — it summed the claims, found them
 * tiny, and handed the buffer to `mammoth`, which only discovered the truth
 * after inflating the whole thing into memory.
 */
export function buildDocxLyingAboutSize(realBytes: number): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    {
      name: 'word/document.xml',
      // Highly compressible: megabytes of one byte cost a few hundred on disk.
      data: Buffer.alloc(realBytes, 0x41),
      declaredUncompressedSize: 128,
      deflate: true,
    },
  ])
}

/**
 * A structurally fine archive whose tail record claims it holds ZERO entries.
 * A walk driven by that count never inspects anything, so every size bound it
 * feeds silently reports "nothing here".
 */
export function buildDocxDeclaringNoEntries(): Buffer {
  return buildZip(
    [
      { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
      {
        name: 'word/document.xml',
        data: Buffer.from(documentXml(['bomb']), 'utf8'),
        declaredUncompressedSize: 4_000_000_000,
      },
    ],
    { declaredEntryCount: 0 },
  )
}

/** An honest, DEFLATE-compressed .docx — small on disk, whatever size in XML. */
export function buildDocxDeflated(paragraphs: string[]): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8'), deflate: true },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8'), deflate: true },
    {
      name: 'word/document.xml',
      data: Buffer.from(documentXml(paragraphs), 'utf8'),
      deflate: true,
    },
  ])
}

/**
 * The HIGH-1 bypass: the real document body lives at a NON-.xml path.
 *
 * `mammoth` resolves the main part from `_rels/.rels` and accepts any target
 * that exists (`findPartPath` -> `validTargets[0]`), so the extension is
 * decoration. A decoy `word/document.xml` keeps content-type detection happy
 * while the body — and all the parser work — sits in `word/document.dat`.
 */
export function buildDocxWithRenamedBody(
  paragraphs: string[],
  bodyName = 'word/document.dat',
): Buffer {
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${bodyName}"/>
</Relationships>`
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8'), deflate: true },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8'), deflate: true },
    // Decoy: present so the zip carries the literal name, tiny so a
    // by-extension budget sees almost nothing.
    { name: 'word/document.xml', data: Buffer.from(documentXml(['decoy']), 'utf8'), deflate: true },
    { name: bodyName, data: Buffer.from(documentXml(paragraphs), 'utf8'), deflate: true },
  ])
}

/**
 * Counted (parse-budget) bytes ONE page of a real Word document occupies, at
 * the densest rate measured.
 *
 * MEASURED, NOT CHOSEN. Five genuine Word documents were inspected through
 * `inspectDocxZip` on 2026-08-10 (aggregates only — the files are the owner's
 * private correspondence and none of them, nor any part of them, is in this
 * repo):
 *
 *   parsed bytes   81 KB · 97 KB · 241 KB · 331 KB · 353 KB
 *   pages known    1p · 5p · 24p
 *   bytes/page     p50 66 KB · max 81 KB
 *
 * This matters because a generated fixture is a terrible proxy: the
 * `documentXml` helper above spends ~60-90 bytes on a paragraph where Word
 * spends about a kilobyte on a bullet, so a budget "calibrated" on it would
 * carry an imaginary 40x of headroom and reject real CVs. The earlier round of
 * this work recorded a wider corpus (14 documents, 78-539 KB) from a machine
 * that no longer holds them; the numbers above are an independent
 * re-measurement of what is still there, and they agree.
 */
export const REAL_WORD_BYTES_PER_PAGE = 81 * 1024

/**
 * A DOCX that weighs, against the parse budget, what `pages` pages of a real
 * Word document weigh.
 *
 * The budget counts BYTES of parsable parts, so what has to match a real
 * document is the byte count — not the ratio of markup to prose. This builds
 * to the measured figure exactly rather than estimating it: the per-paragraph
 * cost is computed from the actual serialised form, because an estimate that
 * drifted low would quietly turn "a 40-page CV fits" into a claim about a
 * 29-page one.
 */
export function buildWordDensityDocx(pages: number): Buffer {
  const target = pages * REAL_WORD_BYTES_PER_PAGE
  const filler = 'Дослідження та розробка розподілених систем на TypeScript. '.repeat(8)
  // The exact overhead `documentXml` wraps around each paragraph.
  const wrapper = Buffer.byteLength('<w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p>')

  const paragraphs: string[] = []
  let bytes = 0
  while (bytes < target) {
    const text = `${paragraphs.length}. ${filler}`
    paragraphs.push(text)
    bytes += wrapper + Buffer.byteLength(text)
  }
  return buildDocxDeflated(paragraphs)
}

/**
 * A resume with a real embedded image, so budget-split assertions have
 * something to split. `imageBytes` of incompressible-ish PNG-named payload
 * lands in `word/media/`, which the parse budget must ignore.
 */
/**
 * The bypass that ended the guessing: a real document body with media magic
 * glued in front of it.
 *
 * `mammoth` parses through `@xmldom/xmldom`, which is error-tolerant by design
 * — it skips junk before `<?xml` and reads the document anyway. So these bytes
 * are an image to any signature check and a complete document to the parser.
 * Measured before isolation: 868 KB on disk, 19.5 MB parsed, 1 503 ms of
 * continuous event-loop stall.
 *
 * `prefix` is a parameter because PNG is only the most convenient of several
 * (EMF, ICO, TTF and RIFF all work) — which is the point: an allow-list of
 * signatures fails for the same reason an allow-list of extensions did.
 */
export function buildDocxWithMediaPrefixedBody(
  paragraphs: string[],
  prefix: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  bodyName = 'word/document.xml',
): Buffer {
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${bodyName}"/>
</Relationships>`
  const body = Buffer.concat([Buffer.from(prefix), Buffer.from(documentXml(paragraphs), 'utf8')])
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8'), deflate: true },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8'), deflate: true },
    { name: bodyName, data: body, deflate: true },
  ])
}

export function buildDocxWithMedia(
  paragraphs: string[],
  imageBytes: number,
  mediaName = 'word/media/image1.png',
): Buffer {
  // REAL PNG magic, then pseudo-random filler so it does not compress away.
  //
  // The bytes matter now, and this fixture used to prove less than it looked
  // like it did: it was random data at a `.png` PATH, so it only counted as an
  // image while the guard trusted filenames. Since the guard reads the
  // signature, a fixture without one would (correctly) be charged to the parse
  // budget — and the test asserting images are excluded would have been
  // testing the old, broken rule.
  const media = Buffer.alloc(imageBytes)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(media)
  for (let i = 8; i < imageBytes; i += 1) media[i] = (i * 2654435761) % 251
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8'), deflate: true },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8'), deflate: true },
    {
      name: 'word/document.xml',
      data: Buffer.from(documentXml(paragraphs), 'utf8'),
      deflate: true,
    },
    { name: mediaName, data: media },
  ])
}

// ---------------------------------------------------------------------------
// Hand-built PDFs (pdf-lib is far too slow to emit an operator-dense document)
// ---------------------------------------------------------------------------

function assemblePdf(objects: Record<number, Buffer>): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: Record<number, number> = {}
  let position = parts[0]!.length
  const numbers = Object.keys(objects)
    .map(Number)
    .sort((a, b) => a - b)
  for (const n of numbers) {
    offsets[n] = position
    const chunk = Buffer.concat([
      Buffer.from(`${n} 0 obj\n`, 'latin1'),
      objects[n]!,
      Buffer.from('\nendobj\n', 'latin1'),
    ])
    parts.push(chunk)
    position += chunk.length
  }
  const size = (numbers[numbers.length - 1] ?? 0) + 1
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let n = 1; n < size; n += 1) {
    xref += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`
  }
  parts.push(
    Buffer.from(
      `${xref}trailer\n<</Size ${size}/Root 1 0 R>>\nstartxref\n${position}\n%%EOF\n`,
      'latin1',
    ),
  )
  return Buffer.concat(parts)
}

/**
 * The PDF amplification attack: ONE content stream, referenced by every page
 * through `/Contents`, so N pages cost N executions of it for 1x the bytes.
 *
 * Tiny on disk (a few KB) and it passes the file-size and page-count gates,
 * which is the entire point — those measure the wrong thing.
 */
export function buildPdfSharedContentStream(pages: number, operatorsPerStream: number): Buffer {
  const ops: string[] = ['BT /F1 1 Tf\n']
  for (let i = 0; i < operatorsPerStream; i += 1) {
    ops.push(`1 0 0 1 ${10 + (i % 50)} ${700 - (i % 700)} Tm (lorem ipsum dolor) Tj\n`)
  }
  ops.push('ET\n')
  const stream = deflateSync(Buffer.from(ops.join(''), 'latin1'))

  const objects: Record<number, Buffer> = {}
  objects[1] = Buffer.from('<</Type/Catalog/Pages 2 0 R>>', 'latin1')
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`).join(' ')
  objects[2] = Buffer.from(`<</Type/Pages/Kids[${kids}]/Count ${pages}>>`, 'latin1')
  objects[3] = Buffer.concat([
    Buffer.from(`<</Length ${stream.length}/Filter/FlateDecode>>\nstream\n`, 'latin1'),
    stream,
    Buffer.from('\nendstream', 'latin1'),
  ])
  objects[4] = Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>', 'latin1')
  for (let i = 0; i < pages; i += 1) {
    objects[5 + i] = Buffer.from(
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
        '/Resources<</Font<</F1 4 0 R>>>>/Contents 3 0 R>>',
      'latin1',
    )
  }
  return assemblePdf(objects)
}

/**
 * A one-page PDF carrying a large Flate-compressed IMAGE XObject.
 *
 * This is the shape that made a byte-based PDF budget reject real CVs: the most
 * common image encoding in the wild is plain `/FlateDecode` over raw samples,
 * indistinguishable from a content stream by filter alone.
 */
/**
 * A PDF whose single content stream is EXACTLY `body`, flate-compressed.
 *
 * Exists because `buildPdfSharedContentStream` spends ~40 bytes per operator,
 * so the 32 MB decoded-content cap is reached at ~800 000 operators and a
 * genuinely dense stream is unreachable through it. That encoding — not any
 * limit in the guard — is why an earlier attempt to test the operator counter's
 * COST kept measuring a fast rejection instead of the expensive path, and why I
 * wrongly concluded the input was impossible to build.
 *
 * The guard documents that it re-scans whatever it is handed, so its cost is
 * set by its own regex over the decoded bytes — not by whether an operator
 * would satisfy a real PDF parser. Handing it raw bytes is therefore both
 * legitimate and the only way to reach the shapes that matter:
 *
 *   ' Tj'.repeat(10_000_000)  -> 28.6 MB decoded, ~28 KB on the wire, 10M matches
 *   ' TjX'.repeat(8_000_000)  -> 32.0 MB decoded, ~30 KB on the wire, ZERO matches
 *
 * The second is the one that shows what the early exit does NOT buy.
 */
export function buildPdfWithRawContentStream(body: string): Buffer {
  const compressed = deflateSync(Buffer.from(body, 'latin1'))
  return assemblePdf({
    1: Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    2: Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    3: Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
      'latin1',
    ),
    4: Buffer.concat([
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      compressed,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  })
}

export function buildPdfWithFlateImage(imageBytes: number): Buffer {
  const samples = Buffer.alloc(imageBytes)
  for (let i = 0; i < imageBytes; i += 1) samples[i] = (i * 2654435761) % 251
  const image = deflateSync(samples)
  const content = deflateSync(
    Buffer.from('BT /F1 1 Tf 1 0 0 1 10 700 Tm (resume) Tj ET\n', 'latin1'),
  )

  const objects: Record<number, Buffer> = {}
  objects[1] = Buffer.from('<</Type/Catalog/Pages 2 0 R>>', 'latin1')
  objects[2] = Buffer.from('<</Type/Pages/Kids[5 0 R]/Count 1>>', 'latin1')
  objects[3] = Buffer.concat([
    Buffer.from(`<</Length ${content.length}/Filter/FlateDecode>>\nstream\n`, 'latin1'),
    content,
    Buffer.from('\nendstream', 'latin1'),
  ])
  objects[4] = Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>', 'latin1')
  objects[5] = Buffer.from(
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
      '/Resources<</Font<</F1 4 0 R>>/XObject<</Im1 6 0 R>>>>/Contents 3 0 R>>',
    'latin1',
  )
  objects[6] = Buffer.concat([
    Buffer.from(
      `<</Type/XObject/Subtype/Image/Width 100/Height 100/ColorSpace/DeviceRGB` +
        `/BitsPerComponent 8/Length ${image.length}/Filter/FlateDecode>>\nstream\n`,
      'latin1',
    ),
    image,
    Buffer.from('\nendstream', 'latin1'),
  ])
  return assemblePdf(objects)
}
