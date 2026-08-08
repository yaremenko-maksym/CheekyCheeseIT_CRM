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
import { deflateRawSync } from 'node:zlib'
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
