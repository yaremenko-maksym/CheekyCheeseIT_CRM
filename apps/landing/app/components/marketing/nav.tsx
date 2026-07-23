import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'framer-motion'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { cn, focusRing } from '@/lib/utils'

/**
 * Sticky marketing nav (landing-redesign.md §2.4 `MarketingNav` +
 * `MobileNavMenu`, §6.1). Desktop menu appears at 900px — a non-Tailwind-
 * default breakpoint, hence the `min-[900px]:` arbitrary variants (matches
 * the Claude Design export exactly).
 *
 * `active="careers"` marks the Careers link current on `/careers` and
 * `/careers/:slug` — Home passes nothing (no per-scroll-section tracking,
 * matches the source export's per-PAGE active prop, not scroll-position).
 */
const NAV_LINK_CLASS = cn(
  'text-[0.94rem] font-normal text-foreground/72 transition-colors duration-200 hover:text-foreground',
  focusRing,
)

interface MarketingNavProps {
  active?: 'careers'
}

export function MarketingNav({ active }: MarketingNavProps) {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const burgerRef = useRef<HTMLButtonElement>(null)

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
        'sticky top-0 z-50 border-b border-transparent bg-[color-mix(in_oklch,var(--background)_72%,transparent)] backdrop-blur-md backdrop-saturate-150 transition-colors duration-300',
        scrolled && 'border-border',
      )}
    >
      <div className="mx-auto flex h-[66px] max-w-[1200px] items-center justify-between px-5 md:px-10 lg:px-14">
        <Link
          to="/"
          className={cn(
            'inline-flex items-center gap-2.5 font-semibold tracking-[-0.02em]',
            focusRing,
          )}
          aria-label="CheekyCheeseIT home"
        >
          <BrandMark className="h-8 w-8 text-primary" />
          <span>
            CheekyCheese<span className="text-primary">IT</span>
          </span>
        </Link>

        <nav
          aria-label="Primary"
          className="hidden min-[900px]:flex min-[900px]:items-center min-[900px]:gap-8"
        >
          <Link to="/" hash="services" className={NAV_LINK_CLASS}>
            Services
          </Link>
          <Link to="/" hash="work" className={NAV_LINK_CLASS}>
            Work
          </Link>
          <Link
            to="/careers"
            aria-current={active === 'careers' ? 'page' : undefined}
            className={cn(NAV_LINK_CLASS, active === 'careers' && 'text-foreground')}
          >
            Careers
          </Link>
          <Link to="/" hash="contact" className={NAV_LINK_CLASS}>
            Contact
          </Link>
          <Button asChild size="sm">
            <Link to="/" hash="contact">
              Start a project
            </Link>
          </Button>
        </nav>

        <button
          ref={burgerRef}
          type="button"
          aria-label="Toggle menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex size-11 items-center justify-center rounded-[10px] border border-border bg-transparent text-foreground min-[900px]:hidden',
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

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.2, 0.6, 0.2, 1] }}
            className="overflow-hidden border-t border-border bg-background min-[900px]:hidden"
          >
            <nav
              aria-label="Primary mobile"
              className="mx-auto flex max-w-[1200px] flex-col gap-1 px-5 pt-3.5 pb-5"
            >
              <Link
                to="/"
                hash="services"
                className={cn(NAV_LINK_CLASS, 'px-1 py-3.5 text-[1.05rem]')}
              >
                Services
              </Link>
              <Link to="/" hash="work" className={cn(NAV_LINK_CLASS, 'px-1 py-3.5 text-[1.05rem]')}>
                Work
              </Link>
              <Link
                to="/careers"
                aria-current={active === 'careers' ? 'page' : undefined}
                className={cn(
                  NAV_LINK_CLASS,
                  'px-1 py-3.5 text-[1.05rem]',
                  active === 'careers' && 'text-foreground',
                )}
              >
                Careers
              </Link>
              <Link
                to="/"
                hash="contact"
                className={cn(NAV_LINK_CLASS, 'px-1 py-3.5 text-[1.05rem]')}
              >
                Contact
              </Link>
              <Button asChild block className="mt-3">
                <Link to="/" hash="contact">
                  Start a project
                </Link>
              </Button>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}
