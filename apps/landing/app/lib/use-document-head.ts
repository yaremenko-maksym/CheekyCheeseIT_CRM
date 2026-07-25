import { useEffect } from 'react'
import type { HreflangAlternate } from './seo'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/locale'

/**
 * Per-route `<title>` + description/canonical/OG/Twitter/JSON-LD tags
 * (task-landing-redesign.md §Скоуп item 8, extended by
 * task-landing-seo-prerender.md §1/§2, extended AGAIN by task-landing-i18n.md
 * with `htmlLang`/`alternates` — plan §1/§4 A4/A5). This is a plain Vite
 * SPA — no SSR, no TanStack Start `head()`/`<HeadContent>` (those only
 * render server-side) — so the document head is updated imperatively from
 * the mounted route component, per
 * docs/superpowers/specs/2026-07-22-landing-refactor-design.md §2.3
 * ("документ-хед апдейтится в роуте; SSR нет и не планируется").
 *
 * Runs identically whether the page is live in a user's browser OR being
 * captured by `scripts/prerender.mjs` (a headless-browser snapshot of this
 * same client render) — the resulting tags land in the static HTML either way.
 *
 * `htmlLang`/`alternates` do NOT participate in plan §2's "без моргания"
 * concern — they never change the page's VISIBLE text (A3 only compares
 * innerText of the static prerender vs. post-hydration DOM); `lang` is an
 * a11y/SEO attribute and `alternate` links are invisible `<head>` metadata.
 * The locale itself is still decided exclusively by which route file
 * mounted (see `i18n/locale.ts` module doc) — this hook only reflects that
 * ALREADY-DECIDED locale onto the DOM.
 */
interface DocumentHeadOptions {
  title: string
  description: string
  /** Absolute canonical URL for this exact page — see `lib/seo.ts` `canonicalUrl()`. */
  canonical: string
  /**
   * schema.org structured data to embed as a single
   * `<script type="application/ld+json">` — pass an array to combine several
   * `@type`s on one page (e.g. Organization + WebSite on `/`, see `lib/seo.ts`).
   * Omit on pages with no structured data (careers list, 404) — the tag is
   * removed on navigation so it never lingers from a previously visited page.
   */
  jsonLd?: object | object[] | undefined
  /** Soft-404 / expired-content pages (e.g. a closed vacancy) should not be indexed. */
  noindex?: boolean | undefined
  /** Sets `<html lang>` (plan §4 A5) — defaults to `en`, the router-default locale. */
  htmlLang?: Locale | undefined
  /** Full hreflang cluster for this page — see `lib/seo.ts` `buildHreflangAlternates()` (plan §4 A4). Omitted entirely on pages with no locale variants (e.g. the site-wide 404). */
  alternates?: HreflangAlternate[] | undefined
}

function upsertMeta(attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function upsertLink(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', rel)
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

const JSON_LD_ELEMENT_ID = 'seo-json-ld'

function upsertJsonLd(data: object | object[] | undefined): void {
  const existing = document.getElementById(JSON_LD_ELEMENT_ID)
  if (data === undefined) {
    existing?.remove()
    return
  }
  const el = existing ?? document.createElement('script')
  el.id = JSON_LD_ELEMENT_ID
  el.setAttribute('type', 'application/ld+json')
  el.textContent = JSON.stringify(data)
  if (!existing) document.head.appendChild(el)
}

/** Marker attribute on every `<link rel="alternate" hreflang=...>` this hook writes — lets `upsertAlternateLinks` find and clear ONLY its own tags on each run, never touching unrelated `<link>` elements. */
const ALTERNATE_MARKER_ATTR = 'data-hreflang-alternate'

/**
 * Replaces the FULL set of `<link rel="alternate" hreflang=...>` tags on
 * every run (plan §4 A4) — unlike `upsertMeta`/`upsertLink` above (which
 * each own exactly one tag), the alternate CLUSTER's size varies per page
 * (locale-count minus any `excludeLocales`, plus `x-default`), so a stale
 * tag from a PREVIOUS render (e.g. navigating from a fully-translated
 * vacancy to one missing a locale) must be removed, not left behind.
 */
function upsertAlternateLinks(alternates: HreflangAlternate[] | undefined): void {
  for (const stale of document.head.querySelectorAll(`link[${ALTERNATE_MARKER_ATTR}]`)) {
    stale.remove()
  }
  if (!alternates) return
  for (const { hreflang, href } of alternates) {
    const el = document.createElement('link')
    el.setAttribute('rel', 'alternate')
    el.setAttribute('hreflang', hreflang)
    el.setAttribute('href', href)
    el.setAttribute(ALTERNATE_MARKER_ATTR, 'true')
    document.head.appendChild(el)
  }
}

export function useDocumentHead({
  title,
  description,
  canonical,
  jsonLd,
  noindex,
  htmlLang = DEFAULT_LOCALE,
  alternates,
}: DocumentHeadOptions): void {
  useEffect(() => {
    document.title = title
    document.documentElement.lang = htmlLang
    upsertMeta('name', 'description', description)
    upsertMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow')
    upsertMeta('property', 'og:title', title)
    upsertMeta('property', 'og:description', description)
    upsertMeta('property', 'og:type', 'website')
    upsertMeta('property', 'og:url', canonical)
    upsertMeta('name', 'twitter:card', 'summary')
    upsertMeta('name', 'twitter:title', title)
    upsertMeta('name', 'twitter:description', description)
    upsertLink('canonical', canonical)
    upsertAlternateLinks(alternates)
    upsertJsonLd(jsonLd)
  }, [title, description, canonical, jsonLd, noindex, htmlLang, alternates])
}
