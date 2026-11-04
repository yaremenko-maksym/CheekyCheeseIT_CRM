import { constants } from 'node:fs'
import type { StateFileHandle, StateFs } from '../state'

export type FakeFs = StateFs & {
  files: Map<string, string>
  modes: Map<string, number>
  calls: string[]
  /** Paths that are symlinks: an open with `O_NOFOLLOW` refuses them with ELOOP. */
  symlinks: Set<string>
  /** Throw at this step of the next write: 'open' | 'write' | 'rename'. */
  failAt?: 'open' | 'write' | 'rename' | undefined
  /** Errno code a read-open of an existing file throws (ENOENT is implied by a missing file). */
  openError?: string
  /** A size `stat` reports instead of the real one: a file that grows after the check. */
  statSize?: number
  /** The largest `length` any `read` asked for. */
  maxReadLength: number
}

const errno = (code: string): Error => Object.assign(new Error(code), { code })
const isWrite = (flags: number): boolean => (flags & constants.O_WRONLY) !== 0
const noFollow = (flags: number): boolean =>
  constants.O_NOFOLLOW !== undefined && (flags & constants.O_NOFOLLOW) !== 0

/** An in-memory `StateFs` that records every step of the atomic replace. */
export function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const isDir = (path: string): boolean =>
    [...fs.files.keys()].some((f) => f.startsWith(`${path}/`))

  function readHandle(path: string): StateFileHandle {
    const bytes = new TextEncoder().encode(fs.files.get(path) ?? '')
    return {
      stat: async () => ({ size: fs.statSize ?? bytes.length }),
      async read(buffer, offset, length, position) {
        fs.maxReadLength = Math.max(fs.maxReadLength, length)
        const chunk = bytes.subarray(position, position + length)
        buffer.set(chunk, offset)
        return { bytesRead: chunk.length }
      },
      writeFile: async () => {
        throw errno('EBADF')
      },
      sync: async () => {
        fs.calls.push(`sync ${path}`)
      },
      close: async () => {
        fs.calls.push(`close ${path}`)
      },
    }
  }

  const fs: FakeFs = {
    files: new Map(Object.entries(initial)),
    modes: new Map(),
    calls: [],
    symlinks: new Set(),
    maxReadLength: 0,
    async open(path, flags, mode) {
      const write = isWrite(flags)
      fs.calls.push(`open ${path} ${write ? 'w' : 'r'}`)
      if (fs.symlinks.has(path) && noFollow(flags)) throw errno('ELOOP')
      if (!write) {
        if (!fs.files.has(path) && !isDir(path)) throw errno('ENOENT')
        if (fs.openError !== undefined && fs.files.has(path)) throw errno(fs.openError)
        return readHandle(path)
      }
      if (fs.failAt === 'open') throw errno('EACCES')
      if (mode !== undefined) fs.modes.set(path, mode)
      let pending = ''
      return {
        ...readHandle(path),
        async writeFile(data: string) {
          fs.calls.push(`write ${path}`)
          if (fs.failAt === 'write') throw errno('ENOSPC')
          pending = data
        },
        async sync() {
          fs.calls.push(`sync ${path}`)
          fs.files.set(path, pending)
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
