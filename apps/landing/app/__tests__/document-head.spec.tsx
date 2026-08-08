/**
 * useDocumentHead — task-landing-seo-prerender.md §1/§2: canonical/OG/
 * Twitter tags always present, JSON-LD upserted when passed and REMOVED on
 * navigation to a page without it (so a stale Organization/WebSite payload
 * from `/` never lingers after a client-side nav to `/careers`).
 */

/*
 * task-lint-teeth — `testing-library/no-node-access` is off for this FILE, and
 * only this file, for a structural reason rather than a stylistic one.
 *
 * The rule exists to stop tests inspecting a DOM subtree the component may not
 * have rendered into — the portal blindness that let an entire XSS suite pass
 * against an unprotected dialog on 2026-08-07. Its prescribed fix is to query
 * through `screen`, which is bound to `document.body`.
 *
 * This suite tests a hook whose entire job is writing <title>, <meta>, <link>
 * and JSON-LD into `document.head`. Nothing it produces is ever in
 * `document.body`, so no `screen` query can reach any of it — there is no
 * Testing Library API for the document head at all. `document.head.querySelector`
 * is not a shortcut here, it is the only possible assertion, and the subtree is
 * named explicitly, so the failure mode the rule guards against cannot occur.
 *
 * Scoped to this file deliberately: a repo-wide relaxation would re-open the
 * body-side hole this rule was turned on to close.
 */
/* eslint-disable testing-library/no-node-access */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDocumentHead } from '@/lib/use-document-head'

function Head(props: Parameters<typeof useDocumentHead>[0]) {
  useDocumentHead(props)
  return null
}

afterEach(() => {
  cleanup()
  while (document.head.firstChild) document.head.removeChild(document.head.firstChild)
})

describe('useDocumentHead', () => {
  it('sets title, description, canonical, OG and Twitter tags', () => {
    render(
      <Head
        title="Careers — CheekyCheeseIT"
        description="Open senior engineering roles."
        canonical="https://cheekycheese.tech/careers"
      />,
    )

    expect(document.title).toBe('Careers — CheekyCheeseIT')
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Open senior engineering roles.',
    )
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://cheekycheese.tech/careers',
    )
    expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(
      'https://cheekycheese.tech/careers',
    )
    expect(document.head.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe(
      'summary',
    )
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'index, follow',
    )
  })

  it('defaults robots to index,follow and switches to noindex when requested', () => {
    const { rerender } = render(
      <Head title="A" description="B" canonical="https://cheekycheese.tech/a" />,
    )
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'index, follow',
    )

    rerender(<Head title="A" description="B" canonical="https://cheekycheese.tech/a" noindex />)
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow',
    )
  })

  it('embeds jsonLd as a single application/ld+json script tag', () => {
    render(
      <Head
        title="Home"
        description="D"
        canonical="https://cheekycheese.tech/"
        jsonLd={[{ '@type': 'Organization' }, { '@type': 'WebSite' }]}
      />,
    )
    const script = document.getElementById('seo-json-ld')
    expect(script).toBeTruthy()
    expect(script?.getAttribute('type')).toBe('application/ld+json')
    expect(JSON.parse(script?.textContent ?? 'null')).toEqual([
      { '@type': 'Organization' },
      { '@type': 'WebSite' },
    ])
  })

  it('removes the json-ld tag when navigating to a page that passes no jsonLd', () => {
    const { rerender } = render(
      <Head
        title="Home"
        description="D"
        canonical="https://cheekycheese.tech/"
        jsonLd={{ '@type': 'Organization' }}
      />,
    )
    expect(document.getElementById('seo-json-ld')).toBeTruthy()

    rerender(<Head title="Careers" description="E" canonical="https://cheekycheese.tech/careers" />)
    expect(document.getElementById('seo-json-ld')).toBeNull()
  })

  // task-landing-i18n.md A5/A4 — <html lang> + hreflang alternate cluster.
  it('defaults <html lang> to en when htmlLang is omitted', () => {
    render(<Head title="A" description="B" canonical="https://cheekycheese.tech/a" />)
    expect(document.documentElement.lang).toBe('en')
  })

  it('sets <html lang> to the given locale', () => {
    render(
      <Head title="А" description="Б" canonical="https://cheekycheese.tech/ru/" htmlLang="ru" />,
    )
    expect(document.documentElement.lang).toBe('ru')
  })

  it('writes one <link rel="alternate" hreflang> per entry, and clears them on the next render with a different set', () => {
    const { rerender } = render(
      <Head
        title="A"
        description="B"
        canonical="https://cheekycheese.tech/careers"
        alternates={[
          { hreflang: 'en', href: 'https://cheekycheese.tech/careers/' },
          { hreflang: 'ru', href: 'https://cheekycheese.tech/ru/careers/' },
          { hreflang: 'x-default', href: 'https://cheekycheese.tech/careers/' },
        ]}
      />,
    )
    const links = document.head.querySelectorAll('link[rel="alternate"]')
    expect(links.length).toBe(3)
    expect(
      document.head.querySelector('link[rel="alternate"][hreflang="ru"]')?.getAttribute('href'),
    ).toBe('https://cheekycheese.tech/ru/careers/')

    rerender(
      <Head
        title="A"
        description="B"
        canonical="https://cheekycheese.tech/careers/other"
        alternates={[{ hreflang: 'en', href: 'https://cheekycheese.tech/careers/other/' }]}
      />,
    )
    expect(document.head.querySelectorAll('link[rel="alternate"]').length).toBe(1)
  })

  it('writes no alternate links when alternates is omitted (e.g. the site-wide 404)', () => {
    render(<Head title="A" description="B" canonical="https://cheekycheese.tech/404" noindex />)
    expect(document.head.querySelectorAll('link[rel="alternate"]').length).toBe(0)
  })
})
