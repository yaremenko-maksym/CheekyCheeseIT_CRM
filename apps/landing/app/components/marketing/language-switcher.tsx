import { useEffect, useId, useRef, useState } from 'react'
import { Languages } from 'lucide-react'
import { LOCALES, LOCALE_LABEL, localizedPath, writeLocaleCookie, type Locale } from '@/i18n/locale'
import type { Dictionary } from '@/i18n/dictionary'
import { cn, focusRing } from '@/lib/utils'

/**
 * Language switcher (plan §1/§2/§4 A6, task-landing-i18n.md) — shared by
 * `MarketingNav`/`MarketingFooter`. Hard requirements from the plan:
 *
 * - Every one of the 5 locale options is a REAL `<a href>` in the markup
 *   (not JS-only routing without an href) — crawlers must be able to follow
 *   every locale link directly, independent of JS execution. `<a>` here on
 *   purpose, NOT `<Link>` — a plain same-origin anchor still gets
 *   intercepted by the router's own click-handling ONLY if it renders as a
 *   `<Link>`; a real `<a href>` triggers a normal (still same-SPA, still
 *   client-side-routable by history push if the app were listening — it
 *   isn't required to be, a full navigation to a locale prefix the router
 *   already knows how to mount is equally correct and even simpler here).
 * - Clicking writes the `pref_locale` cookie BEFORE navigating (nginx edge
 *   detection, Block B, reads it on the NEXT cold visit).
 * - Owner scope-change (5 locales, not 3): 5 options in a row would crowd a
 *   320px header — collapses to a compact popover/list on narrow viewports
 *   (`sm:` breakpoint) while keeping every option as a real `<a href>` in
 *   the DOM at all times (not conditionally rendered only when "open" —
 *   crawlers don't click to expand a disclosure).
 */
export function LanguageSwitcher({
  locale,
  path,
  t,
  variant = 'nav',
}: {
  /** Current page's locale — the active option (not itself a link). */
  locale: Locale
  /** Locale-agnostic, root-relative path of THIS page (e.g. `/`, `/careers`, `/careers/my-slug`) — every option links to the SAME document in its own locale. */
  path: string
  t: Dictionary['languageSwitcher']
  variant?: 'nav' | 'footer'
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Same close-on-Escape + return-focus pattern as `nav.tsx`'s
  // MobileNavDisclosure, plus close-on-outside-click/blur (this control can
  // be reopened easily, unlike the mobile nav's single full-panel disclosure).
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  const options = LOCALES.map((optionLocale) => ({
    locale: optionLocale,
    href: localizedPath(optionLocale, path),
    label: LOCALE_LABEL[optionLocale],
    name: t.names[optionLocale],
  }))

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t.label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // `min-h-11` (44px, review round 1 designer MED fix — landing-
          // redesign.md §6.7 project touch-target standard, not just the
          // 24px WCAG floor) — was ~33.7px, below spec on mobile.
          'inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border border-border bg-transparent px-2.5 py-1.5 text-[0.82rem] font-medium text-foreground/80 transition-colors duration-200 ease-out hover:border-[color-mix(in_oklch,var(--foreground)_30%,transparent)] hover:text-foreground',
          focusRing,
        )}
      >
        <Languages aria-hidden="true" className="size-3.5" />
        {LOCALE_LABEL[locale]}
      </button>

      {/*
       * Every option is ALWAYS present in the DOM as a real `<a href>`
       * (plan §1/§4 A6) — `hidden`/`flex` here only toggles CSS
       * `display`, it does not conditionally MOUNT/unmount the links (owner
       * scope-change: 5 locales in a row would crowd a 320px header, so this
       * is the single "compact dropdown" control the owner explicitly
       * allowed, at every viewport — not a responsive variant).
       */}
      <div
        id={menuId}
        role="menu"
        className={cn(
          'z-20 flex flex-col gap-0.5 rounded-[10px] border border-border bg-card p-1.5 shadow-lg',
          variant === 'nav'
            ? 'absolute top-[calc(100%+6px)] right-0 min-w-[168px]'
            : 'absolute bottom-[calc(100%+6px)] left-0 min-w-[168px]',
          open ? 'flex' : 'hidden',
        )}
      >
        {options.map((option) => (
          <a
            key={option.locale}
            role="menuitem"
            href={option.href}
            aria-current={option.locale === locale ? 'true' : undefined}
            onClick={() => {
              writeLocaleCookie(option.locale)
              setOpen(false)
            }}
            className={cn(
              // `min-h-11` (44px) — same touch-target fix as the trigger
              // button above; was ~37px.
              'flex min-h-11 items-center justify-between gap-3 rounded-[7px] px-2.5 py-2 text-[0.88rem] no-underline transition-colors duration-150 ease-out hover:bg-primary/10',
              option.locale === locale
                ? 'font-medium text-primary'
                : 'text-foreground/80 hover:text-foreground',
              focusRing,
            )}
          >
            <span>{option.name}</span>
            <span className="font-mono text-[0.72rem] text-muted-foreground">{option.label}</span>
          </a>
        ))}
      </div>
    </div>
  )
}
