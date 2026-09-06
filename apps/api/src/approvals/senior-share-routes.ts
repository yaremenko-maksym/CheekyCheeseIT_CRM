/**
 * task-648-fix-round-2 (SR-bm-2). The route suffixes of the senior-share
 * confirmation trio, declared ONCE and imported by everyone who names them.
 *
 * Why this file exists at all. `senior-share-guard-stack.controller.
 * integration.spec.ts` proves the real guard chain (JWT → onboarding →
 * roles) against sentinel controllers rather than the real ones — the real
 * `UsersController`/`ProjectsController` drag in a dependency graph far too
 * large to boot for a guard test (the same trade-off
 * `legends.controller.integration.spec.ts` documents for its own sentinel).
 * The price of that trade-off is that the sentinel restates the paths as
 * string literals: rename a real route and the spec keeps happily proving
 * the guard stack of a path that no longer exists, green the whole time.
 *
 * A constant both sides import removes the restating. It does NOT make the
 * sentinel equal to the real controller — the decorators, guards and pipes
 * are still declared twice — but it does mean the ONE thing the spec claims
 * about the real routes (their URLs) can no longer silently become false.
 *
 * Deliberately suffixes, not full paths: the `:id` segment and the
 * `@Controller('users' | 'projects')` prefix stay where Nest expects them.
 */
export const SENIOR_SHARE_ROUTES = {
  approve: ':id/senior-share/approve',
  reject: ':id/senior-share/reject',
  cancel: ':id/senior-share/cancel',
} as const

/**
 * The same three suffixes as request paths for a given resource collection —
 * what a test (or any HTTP caller) actually needs. `:id` is substituted, the
 * global `/api` prefix (`main.ts`) is included.
 */
export function seniorShareRoutePath(
  collection: 'users' | 'projects',
  action: keyof typeof SENIOR_SHARE_ROUTES,
  id: string,
): string {
  return `/api/${collection}/${SENIOR_SHARE_ROUTES[action].replace(':id', id)}`
}
