import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useDocumentHead } from '@/lib/use-document-head'
import { canonicalUrl } from '@/lib/seo'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { cn, focusRing } from '@/lib/utils'
import '../styles/globals.css'

export const Route = createRootRoute({
  component: RootDocument,
  notFoundComponent: NotFoundPage,
})

function RootDocument() {
  return <Outlet />
}

/**
 * Site-wide 404 (task-landing-seo-prerender.md §1 AC2 — "404.html корректен").
 * Renders for any path that matches no route (TanStack Router's default
 * `notFoundComponent` slot). Also captured verbatim as the static
 * `dist/404.html` by `scripts/prerender.mjs` for static-host/CDN fallback —
 * distinct from `careers_.$slug.tsx`'s `NotFoundState`, which is specifically
 * an expired/unknown *vacancy slug*, not a site-wide unknown path.
 */
function NotFoundPage() {
  useDocumentHead({
    title: 'Page not found — CheekyCheeseIT',
    description: "The page you're looking for doesn't exist or has moved.",
    canonical: canonicalUrl('/404'),
    noindex: true,
  })
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav />
      <main className="flex flex-1 items-center justify-center px-5 py-24 text-center">
        <div>
          <h1 className="mb-3 text-[1.6rem] font-semibold tracking-[-0.015em] text-foreground">
            Page not found
          </h1>
          <p className="mb-6 text-muted-foreground">
            The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
          </p>
          <Link
            to="/"
            className={cn('inline-flex items-center gap-2 font-medium text-primary', focusRing)}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back home
          </Link>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
