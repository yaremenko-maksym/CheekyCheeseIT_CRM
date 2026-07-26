import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, X } from 'lucide-react'
import { cn, focusRing } from '@/lib/utils'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/locale'
import type { Dictionary } from '@/i18n/dictionary'
import { careersRoutePath } from '@/i18n/routes'

/**
 * "Мы нанимаем" announcement strip (task-landing-contact-and-hiring-strip.md
 * Часть B) — rendered as a sibling immediately BEFORE `<MarketingNav>` in
 * every `*-page-content.tsx` (NOT inside `MarketingNav` itself): `MarketingNav`
 * is `sticky top-0`, so a strip placed before it in normal document flow
 * scrolls away with the page once the nav reaches the top and starts
 * sticking — the "announcement bar scrolls away, nav bar sticks" pattern the
 * task asks for ("над шапкой"), with zero changes needed inside `nav.tsx`.
 *
 * Returns `null` outright when `count <= 0` (task: "при нуле — не
 * рендерится вовсе") — every caller passes the SAME `PublicVacancy[].length`
 * (or an equivalent fetched total) it already has for its page, so this
 * never fires a second network request.
 *
 * No CLS (task: "полоса приходит из пререндера, а не появляется после
 * гидрации"): `count` is synchronous prop data (route-loader / already-
 * fetched list), never learned via a client-only effect — the strip is part
 * of the FIRST render tree, exactly like the rest of the page. `apps/landing`
 * is a plain CSR `createRoot()` app (see `client.tsx` module doc — no
 * `hydrateRoot`, so there is no hydration-mismatch constraint), so the
 * dismissed/localStorage check below runs in `useState`'s lazy initializer —
 * synchronously, on the very first client render, not in a `useEffect` — a
 * returning visitor who already dismissed THIS count never sees it flash in.
 * `scripts/prerender.mjs`'s headless-browser capture runs in a FRESH browser
 * context (empty localStorage) for every build, so the static prerendered
 * HTML always shows the strip when `count > 0` — exactly what a first-time
 * visitor and a crawler both see.
 */
const STORAGE_KEY = 'cc-hiring-strip-dismissed-count'

function readDismissedCount(): number | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    // localStorage unavailable (private mode / disabled) — never "dismissed".
    return null
  }
}

export function HiringStrip({
  count,
  locale = DEFAULT_LOCALE,
  dict,
}: {
  count: number
  locale?: Locale
  dict: Dictionary
}) {
  const t = dict.hiringStrip
  // `храни вместе с числом, а не булев флаг` (task) — storing the DISMISSED
  // count (not `true`) means a later count change makes the strip reappear
  // automatically: the comparison below is `dismissedCount === count`, so any
  // OTHER count no longer matches the stored value.
  const [dismissedCount, setDismissedCount] = useState<number | null>(() => readDismissedCount())

  if (count <= 0 || dismissedCount === count) return null

  const handleClose = () => {
    setDismissedCount(count)
    try {
      window.localStorage.setItem(STORAGE_KEY, String(count))
    } catch {
      // Non-fatal — the strip still closes for THIS render, it just won't
      // stay dismissed after a reload without localStorage.
    }
  }

  return (
    <div
      className={cn(
        'relative flex items-center justify-center gap-2 border-b border-primary/20 bg-primary/12 px-10 py-2 text-center text-[0.82rem] font-medium text-foreground sm:text-[0.85rem]',
      )}
    >
      <Link
        to={careersRoutePath(locale)}
        className={cn(
          'inline-flex flex-wrap items-center justify-center gap-1.5 rounded-sm px-1 text-balance underline-offset-2 hover:underline',
          focusRing,
        )}
      >
        <span>{t.text.replace('{count}', String(count))}</span>
        <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      </Link>
      <button
        type="button"
        onClick={handleClose}
        aria-label={t.close}
        className={cn(
          'absolute right-2 flex size-7 shrink-0 items-center justify-center rounded-full text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground',
          focusRing,
        )}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}
