import type { ParsedLocation } from '@tanstack/react-router'

/** The context every route's `beforeLoad` receives (`createRootRouteWithContext` in `__root.tsx`). */
export interface RouterContext {
  /**
   * True only for the location of a real load (first load, link click, `navigate`, back/forward):
   * the router loads exactly its own `latestLocation` object then. A hover preload loads a location
   * it built for the hovered link, never that object (PR #1330 CR-M-2). An identity test, not a
   * path comparison, so no spelling of a real URL (case, trailing slash, characters a rebuilt path
   * would encode) can pass for a preload (SR-M-1, CR-M-3).
   */
  isNavigation: (location: ParsedLocation) => boolean
}

export function navigationContext(router: () => { latestLocation: ParsedLocation }): RouterContext {
  return { isNavigation: (location) => location === router().latestLocation }
}
