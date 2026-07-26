import { Link, useLocation } from '@tanstack/react-router'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/marketing/language-switcher'
import { hashLinkProps } from '@/lib/hash-link-props'
import { cn, focusRing } from '@/lib/utils'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/locale'
import type { Dictionary } from '@/i18n/dictionary'
import { careersRoutePath, homeRoutePath } from '@/i18n/routes'

/**
 * Hover underline-draw (§M.2) — same `::after` hairline pattern as
 * `nav.tsx`'s `NAV_LINK_CLASS`: one hover language for "text link" semantics
 * across the whole marketing surface, not two.
 */
const FOOTER_LINK_CLASS = cn(
  'relative text-[0.94rem] font-normal text-foreground/72 transition-colors duration-200 ease-out hover:text-foreground',
  'after:absolute after:-bottom-1 after:left-0 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-primary after:transition-transform after:duration-200 after:ease-out hover:after:scale-x-100 focus-visible:after:scale-x-100',
  focusRing,
)

/**
 * 4-column marketing footer (landing-redesign.md §2.4 `MarketingFooter`).
 * `locale` (task-landing-i18n.md, default `en`) — same contract as
 * `MarketingNav`: passed explicitly by every route file, never detected.
 *
 * `dict` / `path` — see `nav.tsx`'s module doc (review round 1, HIGH-1b /
 * HIGH-3): the caller's already-resolved `Dictionary` (no internal
 * `getDictionary()` barrel lookup — code-splitting) and the current page's
 * locale-agnostic path (so the language switcher lands on the SAME document
 * in the new locale, not always home).
 */
export function MarketingFooter({
  locale = DEFAULT_LOCALE,
  dict,
  path = '/',
}: {
  locale?: Locale
  dict: Dictionary
  path?: string
}) {
  const t = dict
  const homePath = homeRoutePath(locale)
  const careersPath = careersRoutePath(locale)
  const isHome = useLocation({ select: (location) => location.pathname === homePath })

  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-[1200px] px-5 pt-14 pb-10 md:px-10 lg:px-14">
        <div className="grid grid-cols-1 items-start gap-7 sm:grid-cols-2 lg:grid-cols-4">
          <div className="col-span-full mb-1 max-w-[340px] lg:col-span-1">
            <Link
              to={homePath}
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
              {t.footer.tagline}
            </p>
          </div>

          <div>
            <div className="mb-3.5 font-mono text-[0.72rem] tracking-[0.14em] text-muted-foreground uppercase">
              {t.footer.studioHeading}
            </div>
            <div className="flex flex-col gap-2.5">
              <Link
                to={homePath}
                {...hashLinkProps('services', isHome)}
                className={FOOTER_LINK_CLASS}
              >
                {t.nav.services}
              </Link>
              <Link to={homePath} {...hashLinkProps('work', isHome)} className={FOOTER_LINK_CLASS}>
                {t.footer.selectedWork}
              </Link>
              <Link
                to={homePath}
                {...hashLinkProps('process', isHome)}
                className={FOOTER_LINK_CLASS}
              >
                {t.footer.howWeWork}
              </Link>
            </div>
          </div>

          <div>
            <div className="mb-3.5 font-mono text-[0.72rem] tracking-[0.14em] text-muted-foreground uppercase">
              {t.footer.companyHeading}
            </div>
            <div className="flex flex-col gap-2.5">
              <Link to={careersPath} className={FOOTER_LINK_CLASS}>
                {t.footer.careers}
              </Link>
              <Link to={homePath} {...hashLinkProps('about', isHome)} className={FOOTER_LINK_CLASS}>
                {t.footer.aboutUs}
              </Link>
              {/* task-landing-contact-and-hiring-strip.md AC1 — no more
                  mailto: CTA; scrolls/links to the real inline contact form
                  in `#contact` (same `hashLinkProps` pattern as every other
                  in-page link in this component). */}
              <Link
                to={homePath}
                {...hashLinkProps('contact', isHome)}
                className={FOOTER_LINK_CLASS}
              >
                {t.footer.contact}
              </Link>
            </div>
          </div>

          <div>
            <div className="mb-3.5 font-mono text-[0.72rem] tracking-[0.14em] text-muted-foreground uppercase">
              {t.footer.getInTouch}
            </div>
            {/* design-review round 1 LOW-2 — was the literal CONTACT_EMAIL
                text (`hr@cheekycheese.tech`) on a link that navigates to
                `/#contact`, not `mailto:` — a visitor who reads it as a
                copyable address gets a confusing surprise on click. The
                REAL mailto: fallback lives only under the contact form
                itself (owner decision §4: "ТОЛЬКО здесь") — this link's
                job is purely to get a visitor there, so its text is now a
                neutral CTA instead of an address that isn't one. */}
            <Link
              to={homePath}
              {...hashLinkProps('contact', isHome)}
              className={cn(
                'mb-4 inline-flex items-center gap-2 text-[0.98rem] font-medium text-primary',
                focusRing,
              )}
            >
              {t.footer.writeToUs}
            </Link>
            <LanguageSwitcher locale={locale} path={path} t={t.languageSwitcher} variant="footer" />
          </div>
        </div>

        <hr className="my-9 h-px border-0 bg-border" />

        <div className="flex flex-wrap items-center justify-between gap-3 text-[0.85rem] text-muted-foreground">
          <span>{t.footer.rights}</span>
          <span className="font-mono text-[0.78rem]">cheekycheese.tech</span>
        </div>
      </div>
    </footer>
  )
}
