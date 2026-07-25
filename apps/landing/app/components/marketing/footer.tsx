import { Link, useLocation } from '@tanstack/react-router'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/marketing/language-switcher'
import { hashLinkProps } from '@/lib/hash-link-props'
import { cn, focusRing } from '@/lib/utils'
import { CONTACT_EMAIL } from '@/content/home'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/locale'
import { getDictionary } from '@/i18n/dictionaries'
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
 */
export function MarketingFooter({ locale = DEFAULT_LOCALE }: { locale?: Locale }) {
  const t = getDictionary(locale)
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
              <a href={`mailto:${CONTACT_EMAIL}`} className={FOOTER_LINK_CLASS}>
                {t.footer.contact}
              </a>
            </div>
          </div>

          <div>
            <div className="mb-3.5 font-mono text-[0.72rem] tracking-[0.14em] text-muted-foreground uppercase">
              {t.footer.getInTouch}
            </div>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className={cn(
                'mb-4 inline-flex items-center gap-2 text-[0.98rem] font-medium text-primary',
                focusRing,
              )}
            >
              {CONTACT_EMAIL}
            </a>
            <LanguageSwitcher locale={locale} path="/" t={t.languageSwitcher} variant="footer" />
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
