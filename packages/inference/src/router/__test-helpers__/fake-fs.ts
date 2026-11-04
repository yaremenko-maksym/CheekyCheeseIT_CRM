import { constants } from 'node:fs'
import type { StateFileHandle, StateFs } from '../state'

export type FakeFs = StateFs & {
  files: Map<string, string>
  modes: Map<string, number>
  /** Every step; a random temp name is recorded as `<path>.<rand>.tmp`. */
  calls: string[]
  /** The raw temp names opened for writing, in order. */
  tempNames: string[]
  /** Paths that are symlinks: an open with `O_NOFOLLOW` refuses them with ELOOP. */
  symlinks: Set<string>
  /** Paths that exist but are not regular files (a FIFO, a device). */
  specials: Set<string>
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
const has = (flags: number, flag: number | undefined): boolean =>
  flag !== undefined && (flags & flag) !== 0
const RANDOM_TMP = /\.[0-9a-f-]{36}\.tmp$/

/** An in-memory `StateFs` that records every step of the atomic replace. */
export function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const isDir = (path: string): boolean =>
    [...fs.files.keys()].some((f) => f.startsWith(`${path}/`))
  const exists = (path: string): boolean =>
    fs.files.has(path) || fs.specials.has(path) || fs.symlinks.has(path)
  const norm = (path: string): string => path.replace(RANDOM_TMP, '.<rand>.tmp')
  const log = (step: string, what: string): void => {
    fs.calls.push(`${step} ${norm(what)}`)
  }

  function readHandle(path: string): StateFileHandle {
    const bytes = new TextEncoder().encode(fs.files.get(path) ?? '')
    return {
      stat: async () => ({
        size: fs.statSize ?? bytes.length,
        isFile: () => !fs.specials.has(path) && !isDir(path),
      }),
      async read(buffer, offset, length, position) {
        fs.maxReadLength = Math.max(fs.maxReadLength, length)
        const chunk = bytes.subarray(position, position + length)
        buffer.set(chunk, offset)
        return { bytesRead: chunk.length }
      },
      writeFile: async () => {
        throw errno('EBADF')
      },
      sync: async () => log('sync', path),
      close: async () => log('close', path),
    }
  }

  const fs: FakeFs = {
    files: new Map(Object.entries(initial)),
    modes: new Map(),
    calls: [],
    tempNames: [],
    symlinks: new Set(),
    specials: new Set(),
    maxReadLength: 0,
    async open(path, flags, mode) {
      const write = has(flags, constants.O_WRONLY)
      log('open', `${norm(path)} ${write ? 'w' : 'r'}`)
      if (fs.symlinks.has(path) && has(flags, constants.O_NOFOLLOW)) throw errno('ELOOP')
      if (!write) {
        if (!exists(path) && !isDir(path)) throw errno('ENOENT')
        if (fs.openError !== undefined && fs.files.has(path)) throw errno(fs.openError)
        return readHandle(path)
      }
      fs.tempNames.push(path)
      if (has(flags, constants.O_EXCL) && exists(path)) throw errno('EEXIST')
      if (fs.failAt === 'open') throw errno('EACCES')
      if (mode !== undefined) fs.modes.set(path, mode)
      let pending = ''
      return {
        ...readHandle(path),
        async writeFile(data: string) {
          log('write', path)
          if (fs.failAt === 'write') throw errno('ENOSPC')
          pending = data
        },
        async sync() {
          log('sync', path)
          fs.files.set(path, pending)
        },
      }
    },
    async rename(from, to) {
      log('rename', `${norm(from)} ${to}`)
      if (fs.failAt === 'rename') throw errno('EIO')
      const text = fs.files.get(from)
      if (text === undefined) throw errno('ENOENT')
      fs.files.set(to, text)
      fs.files.delete(from)
    },
    async unlink(path) {
      log('unlink', path)
      fs.files.delete(path)
    },
  }
  return fs
}
