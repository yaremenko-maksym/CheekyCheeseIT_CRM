import path from 'path'

import { build, type Plugin, type Rollup } from 'vite'

const VIRTUAL_ID = 'virtual:bookmarklet'
const RESOLVED_ID = `\0${VIRTUAL_ID}`
const ENTRY = path.resolve(__dirname, 'app/bookmarklet/entry.ts')

/**
 * Bundles `app/bookmarklet/entry.ts` into one minified IIFE and wraps it as a `javascript:` URL.
 * The bundle runs on foreign pages, so it is built on its own: no app plugins, no shared chunks,
 * nothing of the CRM but the extractor.
 */
export async function buildBookmarklet(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: __dirname,
    publicDir: false,
    build: {
      write: false,
      minify: true,
      copyPublicDir: false,
      rollupOptions: { input: ENTRY, output: { format: 'iife' } },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[]
  const chunk = outputs[0]?.output.find((o): o is Rollup.OutputChunk => o.type === 'chunk')
  if (!chunk) throw new Error('bookmarklet build produced no chunk')
  return `javascript:${encodeURIComponent(chunk.code.trim())}`
}

/** `import bookmarklet from 'virtual:bookmarklet'` → the `javascript:` URL as a string. */
export function bookmarkletPlugin(): Plugin {
  let cached: Promise<string> | undefined
  return {
    name: 'crm-bookmarklet',
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
    async load(id) {
      if (id !== RESOLVED_ID) return undefined
      // no addWatchFile: in dev it becomes an import of the directory; the app watcher covers it
      // a failed build is not cached, so the next load tries again
      cached ??= buildBookmarklet().catch((error: unknown) => {
        cached = undefined
        throw error
      })
      return `export default ${JSON.stringify(await cached)}`
    },
    handleHotUpdate({ file, server, modules }) {
      if (!file.startsWith(path.dirname(ENTRY)) && !file.endsWith('/app/lib/base64url.ts'))
        return undefined
      cached = undefined
      const own = server.moduleGraph.getModuleById(RESOLVED_ID)
      return own ? [...modules, own] : modules
    },
  }
}
