import type { StateFs } from '../state'

export type FakeFs = StateFs & {
  files: Map<string, string>
  modes: Map<string, number>
  calls: string[]
  /** Throw at this step of the next write: 'open' | 'write' | 'rename'. */
  failAt?: 'open' | 'write' | 'rename' | undefined
  /** Errno code `stat` throws for the state path (ENOENT is implied by a missing file). */
  statError?: string
}

const errno = (code: string): Error => Object.assign(new Error(code), { code })

/** An in-memory `StateFs` that records every step of the atomic replace. */
export function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const fs: FakeFs = {
    files: new Map(Object.entries(initial)),
    modes: new Map(),
    calls: [],
    async stat(path) {
      if (fs.statError !== undefined) throw errno(fs.statError)
      const text = fs.files.get(path)
      if (text === undefined) throw errno('ENOENT')
      return { size: Buffer.byteLength(text) }
    },
    async readFile(path) {
      const text = fs.files.get(path)
      if (text === undefined) throw errno('ENOENT')
      return new TextEncoder().encode(text)
    },
    async open(path, flags, mode) {
      fs.calls.push(`open ${path} ${flags}`)
      if (fs.failAt === 'open' && flags === 'w') throw errno('EACCES')
      if (mode !== undefined) fs.modes.set(path, mode)
      let pending = ''
      return {
        async writeFile(data: string) {
          fs.calls.push(`write ${path}`)
          if (fs.failAt === 'write') throw errno('ENOSPC')
          pending = data
        },
        async sync() {
          fs.calls.push(`sync ${path}`)
          if (flags === 'w') fs.files.set(path, pending)
        },
        async close() {
          fs.calls.push(`close ${path}`)
        },
      }
    },
    async rename(from, to) {
      fs.calls.push(`rename ${from} ${to}`)
      if (fs.failAt === 'rename') throw errno('EIO')
      const text = fs.files.get(from)
      if (text === undefined) throw errno('ENOENT')
      fs.files.set(to, text)
      fs.files.delete(from)
    },
  }
  return fs
}
