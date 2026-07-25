import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { LanguageSwitcher } from '@/components/marketing/language-switcher'
import { hashLinkProps } from '@/lib/hash-link-props'
import { cn, focusRing } from '@/lib/utils'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/locale'
import { getDictionary } from '@/i18n/dictionaries'
import { careersRoutePath, homeRoutePath } from '@/i18n/routes'

/**
 * Sticky marketing nav (landing-redesign.md §2.4 `MarketingNav` +
 * `MobileNavMenu`, §6.1). Desktop menu appears at 900px — a non-Tailwind-
 * default breakpoint, hence the `min-[900px]:` arbitrary variants (matches
 * the Claude Design export exactly).
 *
 * `active="careers"` marks the Careers link current on `/careers` and
 * `/careers/:slug` — Home passes nothing (no per-scroll-section tracking,
 * matches the source export's per-PAGE active prop, not scroll-position).
 *
 * Mobile disclosure animates via a plain CSS `grid-template-rows` transition
 * (task-landing-seo-prerender.md §3), not framer-motion — this component is
 * rendered on EVERY route (via each route's own `<MarketingNav>`), and
 * `/careers` + `/careers/:slug` otherwise have zero framer-motion usage at
 * all; a top-level `import ... from 'framer-motion'` here pulled its ~40 KB
 * gzip vendor chunk into their critical path for a once-per-visit,
 * user-triggered disclosure animation that a CSS transition does just as
 * well. `/` keeps framer-motion regardless (routes/index.tsx's `ScrollReveal`
 * uses it directly). Trade-off: the panel opens with a smooth transition but
 * closes instantly (no exit animation) — conditional mount (`{open && ...}`)
 * can't run a CSS "closing" transition without either staying always-mounted
 * (an a11y footgun: clipped-but-focusable content behind `overflow-hidden`)
 * or extra JS to delay unmount, neither of which is worth it for a mobile
 * burger menu.
 *
 * Hover underline-draw (§M.2, NEW) — an `::after` hairline that scales in
 * from 0 on hover/focus-visible, shared by every text link here AND
 * `footer.tsx` (same class, same "text link" semantics — one hover
 * language, not two). Decorative-noop on touch (no `:hover` there) —
 * harmless, per §M.2 "Nav mobile-меню ссылки".
 *
 * `locale` (task-landing-i18n.md, default `en`) — every route file passes
 * its OWN hardcoded locale (see `i18n/locale.ts` module doc); nothing here
 * ever detects the visitor's language client-side. Drives translated link
 * text, the correct locale-prefixed hrefs (`i18n/routes.ts`) and the
 * `<LanguageSwitcher>` (plan §4 A6).
 */
const NAV_LINK_CLASS = cn(
  'relative text-[0.94rem] font-normal text-foreground/72 transition-colors duration-200 ease-out hover:text-foreground',
  'after:absolute after:-bottom-1 after:left-0 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-primary after:transition-transform after:duration-200 after:ease-out hover:after:scale-x-100 focus-visible:after:scale-x-100',
  focusRing,
)

interface MarketingNavProps {
  active?: 'careers'
  locale?: Locale
}

export function MarketingNav({ active, locale = DEFAULT_LOCALE }: MarketingNavProps) {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const burgerRef = useRef<HTMLButtonElement>(null)
  const t = getDictionary(locale)
  const homePath = homeRoutePath(locale)
  const careersPath = careersRoutePath(locale)
  const isHome = useLocation({ select: (location) => location.pathname === homePath })

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Close the mobile menu on route change (careers -> vacancy, etc).
  useEffect(() => {
    setOpen(false)
  }, [active])

  // a11y §9 — Escape closes the disclosure and returns focus to the burger
  // (not present in the Claude Design export; added here as a must-have).
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        burgerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <header
      className={cn(
        // §M v3.3 п.5 — `backdrop-filter` on a `sticky` element sitting over
        // continuously-scrolling content forces iOS Safari to resample the
        // backdrop on EVERY scroll frame (functionally equivalent to an
        // animated blur even with no `transition`/`animation` on the filter
        // itself) — the likely main contributor to "everything feels janky
        // on iPhone". CSS-only `@media (hover: none)` variant (not the
        // `useCoarsePointer()` hook used elsewhere) so there's zero flash of
        // blur before hydration: raise the background opacity from 72% to
        // ~95% and drop `backdrop-filter` to `none` entirely on touch;
        // desktop/hover-capable devices are unaffected (blur there doesn't
        // create the same per-frame repaint cost).
        'sticky top-0 z-50 border-b border-transparent bg-[color-mix(in_oklch,var(--background)_72%,transparent)] backdrop-blur-md backdrop-saturate-150 transition-colors duration-300 [@media(hover:none)]:bg-[color-mix(in_oklch,var(--background)_95%,transparent)] [@media(hover:none)]:[backdrop-filter:none]',
        scrolled && 'border-border',
      )}
    >
      <div className="mx-auto flex h-[66px] max-w-[1200px] items-center justify-between px-5 md:px-10 lg:px-14">
        <Link
          to={homePath}
          className={cn(
            'inline-flex items-center gap-2.5 font-semibold tracking-[-0.02em]',
            focusRing,
          )}
          aria-label={t.nav.brandHome}
        >
          <BrandMark className="h-8 w-8 text-primary" />
          <span>
            CheekyCheese<span className="text-primary">IT</span>
          </span>
        </Link>

        <nav
          aria-label={t.nav.primaryNav}
          className="hidden min-[900px]:flex min-[900px]:items-center min-[900px]:gap-6"
        >
          <Link to={homePath} {...hashLinkProps('services', isHome)} className={NAV_LINK_CLASS}>
            {t.nav.services}
          </Link>
          <Link to={homePath} {...hashLinkProps('work', isHome)} className={NAV_LINK_CLASS}>
            {t.nav.work}
          </Link>
          <Link
            to={careersPath}
            aria-current={active === 'careers' ? 'page' : undefined}
            className={cn(NAV_LINK_CLASS, active === 'careers' && 'text-foreground')}
          >
            {t.nav.careers}
          </Link>
          <Link to={homePath} {...hashLinkProps('contact', isHome)} className={NAV_LINK_CLASS}>
            {t.nav.contact}
          </Link>
          <LanguageSwitcher locale={locale} path="/" t={t.languageSwitcher} variant="nav" />
          <Button asChild size="sm">
            <Link to={homePath} {...hashLinkProps('contact', isHome)}>
              {t.nav.startProject}
            </Link>
          </Button>
        </nav>

        <div className="flex items-center gap-2 min-[900px]:hidden">
          <LanguageSwitcher locale={locale} path="/" t={t.languageSwitcher} variant="nav" />
          <button
            ref={burgerRef}
            type="button"
            aria-label={t.nav.toggleMenu}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              'flex size-11 items-center justify-center rounded-[10px] border border-border bg-transparent text-foreground transition-colors duration-200 ease-out hover:border-[color-mix(in_oklch,var(--foreground)_30%,transparent)]',
              focusRing,
            )}
          >
            <span className="relative block h-3 w-[18px]">
              <span
                className={cn(
                  'absolute left-0 h-0.5 w-[18px] rounded-sm bg-current transition-[top,transform] duration-300 ease-out',
                  open ? 'top-[5px] rotate-45' : 'top-px',
                )}
              />
              <span
                className={cn(
                  'absolute left-0 h-0.5 w-[18px] rounded-sm bg-current transition-[top,transform] duration-300 ease-out',
                  open ? 'top-[5px] -rotate-45' : 'top-[9px]',
                )}
              />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <MobileNavDisclosure
          active={active}
          isHome={isHome}
          locale={locale}
          homePath={homePath}
          careersPath={careersPath}
        />
      )}
    </header>
  )
}

const ENTER_TRANSITION_CLASS =
  'grid overflow-hidden border-t border-border bg-background transition-[grid-template-rows,opacity] duration-[350ms] ease-out min-[900px]:hidden'

/**
 * Only ever mounted while `open` — see MarketingNav's module doc for why
 * this is a plain CSS transition instead of framer-motion. Starts at
 * `grid-rows-[0fr]` (0 height) and flips to `grid-rows-[1fr]` one animation
 * frame after mount, so the browser has a "from" state to actually
 * transition from (mounting directly at the target state would just snap
 * open with no animation).
 */
function MobileNavDisclosure({
  active,
  isHome,
  locale,
  homePath,
  careersPath,
}: {
  active?: 'careers' | undefined
  isHome: boolean
  locale: Locale
  homePath: ReturnType<typeof homeRoutePath>
  careersPath: ReturnType<typeof careersRoutePath>
}) {
  const [entered, setEntered] = useState(false)
  const t = getDictionary(locale)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      className={cn(
        ENTER_TRANSITION_CLASS,
        entered ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
    >
      <nav
        aria-label={t.nav.primaryMobileNav}
        className="mx-auto flex max-w-[1200px] min-h-0 flex-col gap-1 overflow-hidden px-5 pt-3.5 pb-5"
      >
        <Link
          to={homePath}
          {...hashLinkProps('services', isHome)}
          className={cn(NAV_LINK_CLASS, 'px-1 py-3.5 text-[1.05rem]')}
        >
          {t.nav.services}
        </Link>
        <Link
          to={homePath}
          {...hashLinkProps('work', isHome)}
          className={cn(NAV_LINK_CLASS, 'px-1 py-3.5 text-[1.05rem]')}
        >
          {t.nav.work}
        </Link>
        <Link
          to={careersPath}
          aria-current={active === 'careers' ? 'page' : undefined}
          className={cn(
            NAV_LINK_CLASS,
            'px-1 py-3.5 text-[1.05rem]',
            active === 'careers' && 'text-foreground',
          )}
        >
          {t.nav.careers}
        </Link>
        <Link
          to={homePath}
          {...hashLinkProps('contact', isHome)}
          className={cn(NAV_LINK_CLASS, 'px-1 py-3.5 text-[1.05rem]')}
        >
          {t.nav.contact}
        </Link>
        <Button asChild block className="mt-3">
          <Link to={homePath} {...hashLinkProps('contact', isHome)}>
            {t.nav.startProject}
          </Link>
        </Button>
      </nav>
    </div>
  )
}
