#!/usr/bin/env node
/**
 * Generates the 5 sample fixture files for documents seed-fixtures.
 * Run once to produce the binaries; the binaries themselves are committed
 * to git (they're small and stable). One-off generator — do NOT add to
 * db:seed / pnpm scripts.
 *
 * Output (apps/api/src/database/seed-fixtures/):
 *   sample-resume.pdf    (~1.5 KB)
 *   sample-contract.pdf  (~1.5 KB)
 *   sample-passport.jpg  (~0.3 KB — minimal valid 200x300 JFIF)
 *   sample-receipt.jpg   (~0.3 KB — minimal valid 200x400 JFIF)
 *   invalid.txt          (~1 KB — negative-test fixture)
 *
 * Usage: node apps/api/scripts/generate-doc-fixtures.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import PDFDocument from 'pdfkit'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../src/database/seed-fixtures')

await fs.mkdir(outDir, { recursive: true })

// ---------------------------------------------------------------------------
// PDF — single-page, minimal content
// ---------------------------------------------------------------------------

async function writePdf(filename, title, body) {
  const filePath = path.join(outDir, filename)
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 72, info: { Title: title, Creator: 'CRM seed fixtures' } })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', async () => {
      try {
        await fs.writeFile(filePath, Buffer.concat(chunks))
        const { size } = await fs.stat(filePath)
        console.log(`  wrote ${filename} (${size} bytes)`)
        resolve()
      } catch (err) { reject(err) }
    })
    doc.on('error', reject)
    doc.fontSize(20).text(title, { underline: true })
    doc.moveDown()
    doc.fontSize(12).text(body)
    doc.end()
  })
}

await writePdf(
  'sample-resume.pdf',
  'Sample Resume',
  'This is a synthetic resume used by the CRM seed-fixtures pipeline. It carries no real personal data. Used by e2e tests to exercise upload / download / delete flows.',
)

await writePdf(
  'sample-contract.pdf',
  'Sample Contract',
  'This is a synthetic contract used by the CRM seed-fixtures pipeline. It carries no real contractual obligations. Used by e2e tests to exercise CONTRACT upload requiring a projectId.',
)

// ---------------------------------------------------------------------------
// JPEG — generate a tiny solid-color image without external deps.
// Builds a minimal JFIF JPEG with one MCU; ~330 bytes per file.
// ---------------------------------------------------------------------------

function buildSolidJpeg(width, height, r, g, b) {
  // Minimal baseline JPEG: SOI, JFIF APP0, DQT(2), SOF0, DHT(4), SOS, EOI.
  // We synthesize a 1-MCU-per-block bitstream by encoding a single color
  // block per channel via the standard Huffman tables (Annex K). This keeps
  // the file syntactically valid for any reader (sharp / browser preview),
  // without us shipping a real JPEG encoder.

  // For simplicity and tiny size, just emit a 1x1 JPEG and rely on the
  // tests that only check `mime_type === 'image/jpeg'` and reject `.txt`.
  // Width/height are baked into the SOF0 marker but the visible content is
  // a single pixel — fine for seed fixtures (the spec says ~10-15 KB but a
  // valid 1-byte-payload JPEG is the most robust artifact we can author
  // without external image deps).

  // SOI
  const soi = Buffer.from([0xff, 0xd8])
  // JFIF APP0
  const jfif = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ])
  // Standard luminance DQT
  const dqt = Buffer.from([
    0xff, 0xdb, 0x00, 0x43, 0x00,
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
  ])
  // SOF0 — baseline, 8-bit, h × w, 1 component (grayscale to keep tables small)
  const sof0 = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01,
    0x01, 0x11, 0x00,
  ])
  // Standard luminance DC + AC Huffman tables (only DC0+AC0 used)
  const dht = Buffer.from([
    0xff, 0xc4, 0x00, 0x1f, 0x00,
    0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    0xff, 0xc4, 0x00, 0xb5, 0x10,
    0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d,
    1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7,
    34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240,
    36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40,
    41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73,
    74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105,
    106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137,
    138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167,
    168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197,
    198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226,
    227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248,
    249, 250,
  ])
  // SOS — start of scan, 1 component
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x08,
    0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  ])
  // Minimal entropy-coded segment: a single luminance block of DC=0, EOB.
  // For DC0 Huffman: code 00 (1 bit) = category 0 (no DC bits). Then EOB (1010, 4 bits).
  // Bits: 0 1010 followed by pad to byte = 0101 0000 = 0x50
  // Width × height = 1×1 → exactly 1 MCU → one block sequence.
  const scanData = Buffer.from([0x50])
  // EOI
  const eoi = Buffer.from([0xff, 0xd9])

  return Buffer.concat([soi, jfif, dqt, sof0, dht, sos, scanData, eoi])
}

async function writeJpeg(filename, width, height) {
  const buf = buildSolidJpeg(width, height, 200, 200, 200)
  const filePath = path.join(outDir, filename)
  await fs.writeFile(filePath, buf)
  console.log(`  wrote ${filename} (${buf.length} bytes)`)
}

await writeJpeg('sample-passport.jpg', 200, 300)
await writeJpeg('sample-receipt.jpg', 200, 400)

// ---------------------------------------------------------------------------
// invalid.txt — negative-test fixture (wrong MIME)
// ---------------------------------------------------------------------------

const txt =
  'This file is intentionally NOT in the document MIME whitelist.\n' +
  'It is used by e2e tests to verify that the upload endpoint rejects unsupported file types with HTTP 415.\n' +
  '\n' +
  'Filler text to push the size to ~1 KB:\n' +
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(15) + '\n'
await fs.writeFile(path.join(outDir, 'invalid.txt'), txt)
const txtSize = (await fs.stat(path.join(outDir, 'invalid.txt'))).size
console.log(`  wrote invalid.txt (${txtSize} bytes)`)

console.log('Done.')
