/**
 * task-landing-i18n.md review round 1, HIGH-3 — regression test for the
 * language switcher hardcoded-`path="/"` bug: clicking a locale on
 * `/careers/` or `/careers/<slug>/` must land on the SAME document in the
 * new locale, not always the home page (plan §2 "ведёт на тот же документ
 * в другой локали").
 *
 * Renders `<MarketingNav>` (and `<MarketingFooter>`) directly with the
 * `path` prop each `*-page-content.tsx` actually passes for `/`,
 * `/careers`, `/careers/<slug>` — the exact prop-threading path the bug
 * lived in (a component-level render of `<LanguageSwitcher>` alone, or an
 * E2E test that only ever starts from `/`, would NOT have caught this —
 * see the review comment this test responds to). Covers the full matrix:
 * 3 path shapes × 5 starting locales, BOTH directions (prefixed -> en root
 * included explicitly).
 *
 * `await screen.findByRole(...)` before the first DOM read on every case —
 * TanStack Router's initial mount is async (Suspense-gated), same
 * requirement documented in `vacancy-apply-form.spec.tsx`'s module doc.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { LOCALES, localizedPath, type Locale } from '@/i18n/locale'
import { getDictionary } from '@/i18n/dictionaries'

afterEach(() => cleanup())

async function renderNav(locale: Locale, path: string) {
  const rootRoute = createRootRoute({
    component: () => <MarketingNav locale={locale} dict={getDictionary(locale)} path={path} />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const result = render(<RouterProvider router={router} />)
  await screen.findByRole('banner')
  return result
}

async function renderFooter(locale: Locale, path: string) {
  const rootRoute = createRootRoute({
    component: () => <MarketingFooter locale={locale} dict={getDictionary(locale)} path={path} />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const result = render(<RouterProvider router={router} />)
  await screen.findByRole('contentinfo')
  return result
}

/** Every switcher option's `href` for the given `path`, keyed by target locale. */
function expectedHrefs(path: string): Record<Locale, string> {
  return Object.fromEntries(LOCALES.map((l) => [l, localizedPath(l, path)])) as Record<
    Locale,
    string
  >
}

function switcherHrefs(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')]
    .map((el) => el.getAttribute('href'))
    .filter((href, index, all): href is string => Boolean(href) && all.indexOf(href) === index)
}

const PATHS = ['/', '/careers', '/careers/senior-ml-engineer']
const STARTING_LOCALES: Locale[] = ['en', 'ru', 'uk', 'es', 'pt']

describe('MarketingNav language switcher — path matrix (review round 1 HIGH-3)', () => {
  for (const path of PATHS) {
    for (const startLocale of STARTING_LOCALES) {
      it(`from locale="${startLocale}" on "${path}": every locale option links to the SAME document`, async () => {
        await renderNav(startLocale, path)
        const hrefs = switcherHrefs()
        const expected = Object.values(expectedHrefs(path))
        for (const href of expected) {
          expect(hrefs, `missing ${href} in switcher hrefs for path="${path}"`).toContain(href)
        }
      })
    }
  }

  it('explicit prefixed-locale -> en-root transition: /ru/careers/ switcher includes the unprefixed en href', async () => {
    await renderNav('ru', '/careers')
    expect(switcherHrefs()).toContain('/careers/')
  })

  it('explicit prefixed-locale -> en-root transition on a vacancy page: /uk/careers/<slug>/ switcher includes the unprefixed en href', async () => {
    await renderNav('uk', '/careers/senior-ml-engineer')
    expect(switcherHrefs()).toContain('/careers/senior-ml-engineer/')
  })

  it('regression guard — path="/careers/my-slug" switcher NEVER just links every locale to that locale bare home', async () => {
    await renderNav('en', '/careers/my-slug')
    const hrefs = switcherHrefs()
    // The bug: every option resolved to `/`, `/ru/`, `/uk/`, `/es/`, `/pt/`
    // regardless of the real page. None of those bare-home hrefs should be
    // present when the real page is a vacancy detail page.
    for (const bareHome of ['/', '/ru/', '/uk/', '/es/', '/pt/']) {
      expect(hrefs).not.toContain(bareHome)
    }
  })
})

describe('MarketingFooter language switcher — path matrix (review round 1 HIGH-3)', () => {
  it('/careers/ footer switcher links to /ru/careers/, not /ru/', async () => {
    await renderFooter('en', '/careers')
    expect(switcherHrefs()).toContain('/ru/careers/')
    expect(switcherHrefs()).not.toContain('/ru/')
  })
})
