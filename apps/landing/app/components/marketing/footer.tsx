import { Link, useLocation } from '@tanstack/react-router'
import { BrandMark } from '@/components/brand-mark'
import { hashLinkProps } from '@/lib/hash-link-props'
import { cn, focusRing } from '@/lib/utils'
import { CONTACT_EMAIL } from '@/content/home'

/**
 * Hover underline-draw (§M.2) — same `::after` hairline pattern as
 * `nav.tsx`'s `NAV_LINK_CLASS`: one hover language for "text link" semantics
 * across the whole marketing surface, not two.
 */
const FOOTER_LINK_CLASS = cn(
  'relative text-[0.94rem] font-normal text-foreground/72 transition-colors duration-200 hover:text-foreground',
  'after:absolute after:-bottom-1 after:left-0 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-primary after:transition-transform after:duration-200 hover:after:scale-x-100 focus-visible:after:scale-x-100',
  focusRing,
)

/** 4-column marketing footer (landing-redesign.md §2.4 `MarketingFooter`). */
export function MarketingFooter() {
  const isHome = useLocation({ select: (location) => location.pathname === '/' })

  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-[1200px] px-5 pt-14 pb-10 md:px-10 lg:px-14">
        <div className="grid grid-cols-1 items-start gap-7 sm:grid-cols-2 lg:grid-cols-4">
          <div className="col-span-full mb-1 max-w-[340px] lg:col-span-1">
            <Link
              to="/"
              className={cn(
                'mb-4 inline-flex items-center gap-2.5 font-semibold tracking-[-0.02em]',
                focusRing,
              )}
            >
              <BrandMark variant="flat" className="h-6 w-6 text-primary" />
              <span>
                CheekyCheese<span className="text-primary">IT</span>
              </span>
            </Link>
            <p className="m-0 max-w-[32ch] text-[0.92rem] text-muted-foreground">
              An outsource &amp; outstaffing studio building AI, EdTech and E-Commerce products that
              scale.
            </p>
          </div>

          <div>
            <div className="mb-3.5 font-mono text-[0.72rem] tracking-[0.14em] text-muted-foreground uppercase">
              Studio
            </div>
            <div className="flex flex-col gap-2.5">
              <Link to="/" {...hashLinkProps('services', isHome)} className={FOOTER_LINK_CLASS}>
                Services
              </Link>
              <Link to="/" {...hashLinkProps('work', isHome)} className={FOOTER_LINK_CLASS}>
                Selected work
              </Link>
              <Link to="/" {...hashLinkProps('process', isHome)} className={FOOTER_LINK_CLASS}>
                How we work
              </Link>
            </div>
          </div>

          <div>
            <div className="mb-3.5 font-mono text-[0.72rem] tracking-[0.14em] text-muted-foreground uppercase">
              Company
            </div>
            <div className="flex flex-col gap-2.5">
              <Link to="/careers/" className={FOOTER_LINK_CLASS}>
                Careers
              </Link>
              <Link to="/" {...hashLinkProps('about', isHome)} className={FOOTER_LINK_CLASS}>
                About us
              </Link>
              <a href={`mailto:${CONTACT_EMAIL}`} className={FOOTER_LINK_CLASS}>
                Contact
              </a>
            </div>
          </div>

          <div>
            <div className="mb-3.5 font-mono text-[0.72rem] tracking-[0.14em] text-muted-foreground uppercase">
              Get in touch
            </div>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className={cn(
                'inline-flex items-center gap-2 text-[0.98rem] font-medium text-primary',
                focusRing,
              )}
            >
              {CONTACT_EMAIL}
            </a>
          </div>
        </div>

        <hr className="my-9 h-px border-0 bg-border" />

        <div className="flex flex-wrap items-center justify-between gap-3 text-[0.85rem] text-muted-foreground">
          <span>© 2026 CheekyCheeseIT. All rights reserved.</span>
          <span className="font-mono text-[0.78rem]">cheekycheese.tech</span>
        </div>
      </div>
    </footer>
  )
}
