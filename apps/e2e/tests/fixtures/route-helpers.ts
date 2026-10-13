import type { Route } from '@playwright/test'

// ---------------------------------------------------------------------------
// API route matching — origin-agnostic
// ---------------------------------------------------------------------------
//
// Playwright page.route() intercepts at the browser-fetch URL, NOT the
// final backend URL after any proxy rewrite.  The web app can run on
// different origins depending on the test environment:
//
//   CI / vite dev (:3000)    → browser fetches http://localhost:3001/api/*
//                               (axios VITE_API_URL=http://localhost:3001)
//   Local preview (:3010)    → browser fetches http://localhost:3010/api/*
//                               (same-origin, vite preview proxy rewrites)
//   Future: any other port   → origin varies
//
// Using a hardcoded origin (e.g. "http://localhost:3001") OR deriving it
// from PLAYWRIGHT_BASE_URL both break in at least one scenario.
//
// Fix: match on the URL *path* only, ignoring the origin.
//   • String routes  → use Playwright glob  `**/api/<path>` which matches
//     any host/port prefix followed by /api/<path>.
//   • RegExp routes  → replace `${API_RE}/path` with `/\\/api\\/path/`
//     which matches the path segment in the full URL string on any origin.
//
// NOTE: we deliberately do NOT match Vite page-navigation URLs (/...)
// because those never contain "/api/" as a path segment.
//
// API_GLOB — prefix for string-literal page.route() patterns.
//
// Exported (task-e2e-origin-agnostic) — this is the ONE canonical
// origin-agnostic prefix for the whole suite. Spec files that need to mock
// an endpoint via a plain-string `page.route()`/`page.unroute()` call MUST
// import this instead of declaring a local `const API = 'http://localhost:3001/api'`
// — a hardcoded origin only matches when the web app happens to be served
// from exactly that host:port (CI's baked-in `VITE_API_URL`), and silently
// never fires (no error, the route handler is simply never installed —
// `mockAuthAs`'s earlier, broader route wins instead) against a `vite preview`
// origin, a scratch port, or any other local setup.
export const API_GLOB = '**/api'
// API_RE — prefix for RegExp-based page.route() patterns.  A leading
// `\\/` anchors to the `/api/` path component without accidentally
// matching a hostname that contains "api" as a substring.
//
// Exported (task-e2e-origin-agnostic) — same rationale as API_GLOB above,
// for the `new RegExp(...)` call sites instead of plain-string ones.
export const API_RE = '\\/api'

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

export function jsonOk(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

export function noContent(route: Route) {
  return route.fulfill({ status: 204, body: '' })
}
