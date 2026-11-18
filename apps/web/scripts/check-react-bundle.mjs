// After `vite build`: the emitted JS must define exactly one React runtime, and it must be 19.
// A React runtime defines its shared internals once; the property name differs by major
// (19: __CLIENT_INTERNALS_…, 18: __SECRET_INTERNALS_…), and minifiers keep property names.
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve(import.meta.dirname, '../dist/assets')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
if (files.length === 0) {
  console.error(`check-react-bundle: no .js files in ${dir} — run vite build first`)
  process.exit(1)
}
// `=` not followed by `=`: a definition, not a comparison or a read.
const def19 = /__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE\s*=(?!=)/g
const def18 = /__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED\s*=(?!=)/g
let react19 = 0
let react18 = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8')
  react19 += src.match(def19)?.length ?? 0
  react18 += src.match(def18)?.length ?? 0
}
console.log(`check-react-bundle: ${files.length} JS files, React 19 runtimes: ${react19}, React 18 runtimes: ${react18}`)
if (react19 !== 1 || react18 !== 0) {
  console.error('check-react-bundle: expected exactly one React 19 runtime and no React 18 runtime')
  process.exit(1)
}
