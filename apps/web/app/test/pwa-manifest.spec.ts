/**
 * Task 0.7 PWA hardening — static guards for the manifest and the safe-area
 * custom properties. Pins: the install scope is "/", the display mode is
 * standalone, and the --safe-* variables are defined from env() (they resolve
 * to 0 until the viewport opts into viewport-fit=cover, so defining them is a
 * no-op for the current layout).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '../..')

const manifest = JSON.parse(
  readFileSync(resolve(webRoot, 'public/site.webmanifest'), 'utf8'),
) as Record<string, unknown>

describe('site.webmanifest (PWA scope)', () => {
  it('sets id, start_url and scope to "/" and display to standalone', () => {
    expect(manifest.id).toBe('/')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
  })
})

describe('index.html iOS home-screen meta tags', () => {
  const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')

  function metaContent(name: string): string | undefined {
    const match = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)
    return match?.[1]
  }

  it('declares apple-mobile-web-app-capable as "yes"', () => {
    expect(metaContent('apple-mobile-web-app-capable')).toBe('yes')
  })

  it('sets apple-mobile-web-app-title to the manifest short_name', () => {
    expect(metaContent('apple-mobile-web-app-title')).toBe(manifest.short_name)
  })
})

describe('globals.css safe-area custom properties', () => {
  const css = readFileSync(resolve(webRoot, 'app/styles/globals.css'), 'utf8')

  it.each(['top', 'right', 'bottom', 'left'])(
    'defines --safe-%s from env(safe-area-inset-*)',
    (side) => {
      expect(css).toContain(`--safe-${side}: env(safe-area-inset-${side});`)
    },
  )
})
