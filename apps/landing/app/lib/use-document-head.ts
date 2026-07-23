import { useEffect } from 'react'

/**
 * Per-route `<title>` + description/OG tags (task-landing-redesign.md
 * §Скоуп item 8). This is a plain Vite SPA — no SSR, no TanStack Start
 * `head()`/`<HeadContent>` (those only render server-side) — so the document
 * head is updated imperatively from the mounted route component, per
 * docs/superpowers/specs/2026-07-22-landing-refactor-design.md §2.3
 * ("документ-хед апдейтится в роуте; SSR нет и не планируется").
 */
interface DocumentHeadOptions {
  title: string
  description: string
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

export function useDocumentHead({ title, description }: DocumentHeadOptions): void {
  useEffect(() => {
    document.title = title
    upsertMeta('name', 'description', description)
    upsertMeta('property', 'og:title', title)
    upsertMeta('property', 'og:description', description)
    upsertMeta('property', 'og:type', 'website')
  }, [title, description])
}
