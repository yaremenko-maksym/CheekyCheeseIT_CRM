#!/usr/bin/env node
/**
 * Resume text extraction, in a process that is not the API.
 *
 * Runs `mammoth` (DOCX) or `unpdf` (PDF) — the two libraries whose appetite we
 * cannot predict — behind the sandbox in `sandboxed-process.ts`: hard deadline,
 * memory ceiling, niceness 19, at most two at a time. Whatever they choose to
 * parse, they parse it here, and the event loop that serves HTTP is elsewhere.
 *
 * Deliberately plain CommonJS shipped as an ASSET rather than compiled TypeScript:
 * it must resolve identically from `src/assets` under Vitest and from
 * `dist/assets` in the image, exactly like the fonts and the Typst template. A
 * `.ts` worker would exist only after a build and would make the tests either
 * skip or lie.
 *
 * Protocol — argv in, one JSON line out:
 *   argv: <filePath> <mime> <maxChars>
 *   stdout: {"ok":true,"text":"..."} | {"ok":false,"error":"..."}
 * Nothing else is ever written to stdout; the parent parses it strictly.
 */
const { readFileSync } = require('node:fs')

const PDF_MIME = 'application/pdf'

function emit(payload) {
  process.stdout.write(JSON.stringify(payload))
}

async function extract(filePath, mime, maxChars) {
  const buffer = readFileSync(filePath)

  if (mime === PDF_MIME) {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const proxy = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(proxy, { mergePages: true })
    return String(text ?? '')
  }

  const mammoth = require('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return String(result.value ?? '')
}

async function main() {
  const [, , filePath, mime, maxCharsRaw] = process.argv
  const maxChars = Number(maxCharsRaw)
  if (!filePath || !mime || !Number.isFinite(maxChars) || maxChars <= 0) {
    emit({ ok: false, error: 'bad worker invocation' })
    process.exitCode = 2
    return
  }

  try {
    const text = await extract(filePath, mime, maxChars)
    // Truncate HERE, before the text crosses the pipe: the cap exists so that a
    // 50 MiB expansion never has to be held, moved or normalised by the API
    // process, and sending it first would defeat the point of the cap.
    emit({ ok: true, text: text.length > maxChars ? text.slice(0, maxChars) : text })
  } catch (err) {
    emit({ ok: false, error: err && err.message ? String(err.message) : 'extraction failed' })
    process.exitCode = 1
  }
}

void main()
