// force-pid.cjs — test-only preload (NODE_OPTIONS=--require). Gives every node process that loads
// it the NEXT pid from the counter file FORCE_PID_FILE, instead of the OS pid.
//
// Why: pino writes `"pid":<n>` BEFORE the request url in every record, so the byte offset of the
// url's closing quote depends on how many digits the pid has. The SR-H-7 fixture needs that quote
// at exactly byte 16384 (docker json-file's chunk boundary). A fixture that measures the offset in
// one process and builds the record in another breaks whenever the two pids differ in digit count
// (9999 -> 10000, 99999 -> 100000) — which depends on how many processes the CI job spawned
// earlier, i.e. on unrelated changes. This shim lets a test pin that straddle deterministically.
const fs = require('node:fs')
const file = process.env.FORCE_PID_FILE
if (file) {
  const next = Number(fs.readFileSync(file, 'utf8')) + 1
  fs.writeFileSync(file, String(next))
  Object.defineProperty(process, 'pid', { value: next, configurable: true })
}
