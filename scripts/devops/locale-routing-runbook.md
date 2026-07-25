# Locale routing runbook (task-infra-locale-edge)

Edge locale auto-detection for the landing site (`cheekycheese.tech`), plus the
IndexNow / Bing / Yandex indexing channels that ship in the same PR. Source of
truth for the detection RULES themselves: `.claude/tasks/plan-landing-i18n-seo.md`
§1 (URL scheme) and §2 (detection order + crawler-safety). This document is the
operational companion: how it's implemented, how to verify it, how to turn it
off in an emergency.

---

## 1. What ships where

| Concern                                                                   | File                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Cookie / CF-IPCountry priority, redirect-target composition, kill-switch  | `nginx/conf.d/locale-detect.conf` (plain nginx `map`)           |
| Accept-Language best-match (q-value sort + base-language fallback)        | `nginx/njs/locale.js` (njs — see §2 below for why)              |
| The actual `if`/`return 302` redirect + guard, on both `:80` and `:443`   | `nginx/conf.d/landing.conf` (`location /` in each server block) |
| `load_module` wiring for njs                                              | `nginx/nginx.conf` (top, main context)                          |
| IndexNow key file + Bing/Yandex verification files (build-time, optional) | `nginx/Dockerfile` (runtime stage, after `COPY nginx/conf.d/`)  |
| curl proof suite (dev harness AND prod smoke check)                       | `scripts/devops/check-locale-routing.sh`                        |
| IndexNow ping (deploy-time)                                               | `scripts/devops/indexnow-ping.sh`                               |
| Deploy wiring (build-args, post-deploy IndexNow ping step)                | `.github/workflows/deploy.yml`                                  |

## 2. Why njs, not pure nginx `map`, for Accept-Language

`plan-landing-i18n-seo.md` §2 requires genuine RFC 9110 §12.5.4 behaviour:
parse every `Accept-Language` tag's `q` value, sort DESCENDING (not left-to-right
header order — a client CAN legally list a higher-q tag second), and for each
tag (in that q-order) try an exact match against the 5 supported locales, then
its base language (`pt-BR` → `pt`, `es-MX` → `es`, `en-GB` → `en`, `ru-UA` →
`ru`) before moving to the next tag. This needs real sorting/arithmetic across
an arbitrary number of comma-separated tags — not expressible in nginx `map`
(pattern-match only, no loops, no numeric comparison).

njs (`ngx_http_js_module`) is a **dynamic module already bundled in the stock
`nginx:1.27-alpine` base image** — verified: `/usr/lib/nginx/modules/ngx_http_js_module.so`
ships out of the box, njs 0.8.10, no extra install/compile/image-size cost.
`nginx/njs/locale.js` exports one function, `targetLocale(r)`, that returns one
of `"en" | "uk" | "ru" | "es" | "pt"` — the FULL priority chain (cookie >
Accept-Language > CF-IPCountry > `en`) lives there for the Accept-Language tier
specifically; cookie validation, CF-IPCountry lookup, and the redirect-target
composition stay plain nginx `map`/`if` (see `nginx/conf.d/locale-detect.conf`
and `landing.conf`) — njs is used ONLY where `map` genuinely cannot express the
logic, not as a wholesale rewrite of the redirect pipeline.

If njs ever becomes unavailable/undesirable, the fallback is a large ordered
`map` block doing first-tag-only matching (no numeric q-sort) — strictly less
correct per the plan, acceptable only as a degraded/emergency substitute; flag
that trade-off explicitly if you ever have to make that swap.

## 3. Detection order (implementation mirror of plan §2)

1. **Cookie `pref_locale`** (`en|uk|ru|es|pt`) — always wins if present and
   valid. Read via nginx's built-in `$cookie_pref_locale` variable inside
   `nginx/njs/locale.js` (no custom cookie-parsing regex — nginx already
   extracts the named cookie for us).
2. **`Accept-Language`** — best-match via njs (see §2). A tag that doesn't
   resolve to any of the 5 supported locales is skipped, NOT treated as a
   hard "give up" — the next tag (by q-order) is tried. No tag resolves at
   all → falls through to step 3.
3. **`CF-IPCountry`** (Cloudflare) — ONLY consulted when Accept-Language is
   absent or fully unresolved. Table: `UA`→uk · `RU|BY|KZ|KG|AM`→ru ·
   `BR|PT|AO|MZ`→pt · `ES|MX|AR|CO|CL|PE|VE|EC|GT|CU|BO|DO|HN|PY|SV|NI|CR|PA|UY`→es.
4. **Default**: `en`.

The redirect itself (`nginx/conf.d/landing.conf` `location /`) only fires when
ALL of these hold:

- the resolved locale is NOT `en` (an "en" decision never redirects — the
  root `/` already serves EN), AND
- the request URI is NOT already locale-prefixed (`/uk/…`, `/ru/…`, `/es/…`,
  `/pt/…` — crawler-safety, AC B3), AND
- the emergency kill-switch (§5) is off, AND
- the merge-order guard (§4) confirms the target locale's static index
  actually exists in this image.

The redirect is always **302** (not 301 — user preference is not permanent)
and always carries `Vary: Accept-Language, Cookie` (AC B4) so caches never
serve a cross-locale response to the wrong visitor.

## 4. Merge-order guard (safe regardless of merge order with `feature/landing-i18n`)

`feature/landing-i18n` (a separate, parallel Coder branch) adds the actual
prerendered `/uk/`, `/ru/`, `/es/`, `/pt/` static directories to
`apps/landing/dist`. This infra PR can land BEFORE or AFTER that branch — to
make that safe in either order, the redirect is gated on a real file-existence
check:

```nginx
set $locale_guard_path "";
if ($locale_prefix != "") {
    set $locale_guard_path $document_root$locale_prefix/index.html;
}
if (-f $locale_guard_path) {
    return 302 $locale_prefix$request_uri;
}
```

If `feature/landing-i18n` hasn't merged yet (or its dist output isn't in the
current image for any other reason), `$locale_guard_path` resolves to a file
that doesn't exist on disk → the `-f` test fails → **no redirect fires,
ever, for any request** → every request behaves EXACTLY as it did before
this PR (EN-only, no redirect, no 404). This is fully self-activating: the
moment a deploy ships an image that DOES contain the locale directories, the
guard starts passing and redirects begin — no manual flag flip, no
coordination needed between the two PRs' merge order.

Verified empirically (not just reasoned about) during development: a local
nginx container with the `ru`/`uk` directories removed from its mounted dist
returned a plain 200 EN for every locale-triggering request; putting them
back immediately resumed 302 redirects on the next request, no reload
needed (this is a live filesystem `-f` check per request, not a config-load-time
decision).

## 5. Emergency kill-switch

`nginx/conf.d/locale-detect.conf`:

```nginx
map "" $locale_redirect_kill_switch {
    default 0;
}
```

To disable ALL locale auto-redirects instantly (incident / rollback lever,
e.g. a bad interaction discovered in production that the file-existence guard
above doesn't cover): change `default 0;` to `default 1;` in this one line,
commit, and redeploy. Every request will then resolve `$locale_prefix` to `""`
regardless of cookie/Accept-Language/CF-IPCountry — full stop, no other file
needs touching. This is a one-line-change-plus-redeploy lever (this stack has
no separate runtime config server, so a redeploy via the existing CI pipeline
— typically single-digit minutes — is the fastest lever this PR ships). A
sub-minute, no-redeploy circuit breaker (e.g. a Cloudflare Redirect Rule /
Worker intercepting before origin) is NOT built here — genuinely out of scope
for B1-B8 — but would be a reasonable follow-up task if response time faster
than a redeploy is ever needed for this specific incident class.

To re-enable: flip back to `default 0;`, commit, redeploy.

## 6. How to verify bots see 200 (crawler-safety)

Any request WITHOUT a resolvable `Accept-Language`/cookie/`CF-IPCountry`
signal gets a plain `200` EN response — this is what Googlebot, and any other
crawler that omits `Accept-Language` (most do), will see on `/`. Locale-
prefixed URLs (`/uk/`, `/ru/`, `/es/`, `/pt/`) are NEVER redirect targets or
redirect sources — a crawler that discovers them via `hreflang`/sitemap (see
`apps/landing`'s Block A work) always gets a direct `200`, never a 302 bounce.

To verify against a real (or locally running) origin:

```bash
scripts/devops/check-locale-routing.sh https://cheekycheese.tech
```

This runs the full B1–B5 curl matrix (25 cases as of this PR — accept-language
best-match, cookie priority, all 4 locale-prefixed URLs, CF-IPCountry, Vary
headers, deep-path/trailing-slash preservation) and prints `PASS`/`FAIL` per
case, exiting non-zero on any failure. Safe to run repeatedly against
production (read-only GET requests, no state mutated).

### Local dry-run before any nginx/\*\* change

```bash
# From the repo root, build just the runtime image (or reuse an existing one)
docker build -f nginx/Dockerfile -t crm-nginx-test --build-arg VITE_API_URL=/api .
docker run -d --name crm-nginx-test -p 8080:80 crm-nginx-test
scripts/devops/check-locale-routing.sh http://localhost:8080
docker rm -f crm-nginx-test
```

(Requires the full monorepo build context — this builds `apps/landing` +
`apps/web` from scratch, so it is slower than the config-only smoke test used
during development of this PR, which mounted `nginx.conf`/`conf.d`/`njs`
directly into a stock `nginx:1.27-alpine` container with a small fixture
`dist` — see this PR's description for that lighter-weight harness if you
need a fast config-only iteration loop.)

## 7. IndexNow (AC B6)

[IndexNow](https://www.indexnow.org/) is a SHARED protocol — **one** POST to
`https://api.indexnow.org/indexnow` relays the notification to every
participating engine, which today includes both Bing and Yandex (the two
named in AC B6). This is why `scripts/devops/indexnow-ping.sh` only ever
calls the one shared endpoint, not separate Bing/Yandex calls.

### Key file

`INDEXNOW_KEY` build-arg (optional, unset = disabled/no-op) is baked into the
nginx image at build time — see `nginx/Dockerfile`'s runtime stage. When set,
it serves the key verbatim at `https://cheekycheese.tech/<key>.txt`, which
IndexNow/Bing/Yandex fetch to confirm domain ownership before accepting
submissions. Deliberately NOT hardcoded in the repo (see the Dockerfile
comment for the rotation-cost rationale) — set as a GitHub Actions secret
(`INDEXNOW_KEY`), same channel as `VITE_TURNSTILE_SITE_KEY` /
`GOOGLE_INDEXING_SA_EMAIL` (Settings → Secrets and variables → Actions →
Secrets, environment `production`).

**Owner action to generate a key**: any sufficiently random string works (the
IndexNow spec recommends a UUID/hex string, 8-128 chars). Generate one with
`openssl rand -hex 16` (or use https://www.bing.com/indexnow to have Bing
generate one for you) and store it as the `INDEXNOW_KEY` secret.

### Ping trigger — at deploy (wired in this PR)

`.github/workflows/deploy.yml`'s `deploy` job pings a small, fixed set of
known static URLs (the locale home pages + `/careers/` indexes) after the
health-check passes — see the `Ping IndexNow (Bing + Yandex)` step. This
covers "freshness" for the pages that change on every content deploy.
Non-blocking (fail-soft) by design — a bad IndexNow response never fails the
deploy, mirroring the Google Indexing API convention already documented in
`docs/runbooks/deployment.md` "Google Indexing API".

### Ping trigger — on vacancy publish/close (NOT wired in this PR — follow-up)

AC B6 also asks for a ping "при публикации/закрытии вакансии" (on
publish/close). That hook belongs in `apps/api` (the vacancy publish/close
service, which knows the exact slug and has the live DB) — outside this
task's zone-of-write (`nginx/**`, `.github/workflows/**`, `scripts/devops/**`
only; `apps/api/**` is Coder/Block-C territory). The reusable primitive is
already here (`scripts/devops/indexnow-ping.sh <key> <host> <url...>`) — a
future Coder task just needs to call the IndexNow HTTP API directly from
NestJS (same JSON shape this script builds) or shell out to this script,
passing the one vacancy URL that changed, right after the publish/close
transaction commits. Flagging this explicitly so it isn't lost: **this PR
delivers the key-file endpoint + the deploy-time ping + the reusable ping
primitive; the publish/close hook itself is a separate, small Coder task.**

## 8. Bing Webmaster Tools + Yandex.Webmaster verification (AC B7)

This PR prepares the MECHANISM (static file endpoints, build-arg driven,
same no-op-when-unset pattern as everything else in this Dockerfile). The
actual verification (creating the properties, confirming ownership) is an
**owner action** — nothing here can do that part for you.

### Bing Webmaster Tools

1. Go to https://www.bing.com/webmasters, sign in, add the site
   `https://cheekycheese.tech`.
2. **Easiest path**: Bing Webmaster Tools supports importing verified sites
   directly from Google Search Console (the `cheekycheese.tech` property is
   already verified there — see `docs/runbooks/deployment.md` "Google
   Indexing API" step 6). If that import option is offered, use it — no file
   or secret needed at all, skip straight to done.
3. **If Bing asks for the "XML file" verification method instead**: it gives
   you a verification ID (a GUID) to embed in `BingSiteAuth.xml`. Set that ID
   as the `BING_SITE_VERIFICATION_ID` GitHub Actions secret (environment
   `production`) — the Dockerfile wraps it in the required XML envelope and
   serves it at `https://cheekycheese.tech/BingSiteAuth.xml` on the next
   deploy. Verify in the Bing Webmaster UI once the deploy is live.

### Yandex.Webmaster

1. Go to https://webmaster.yandex.com, sign in, add the site
   `https://cheekycheese.tech`.
2. Choose the **"HTML file" verification method** (not the meta-tag method —
   a meta tag would require an `apps/landing` code change, outside this
   task's zone). Yandex gives you an exact filename (e.g.
   `yandex_0123456789abcdef.html`) and the exact content to put in it.
3. Set the filename as the `YANDEX_VERIFICATION_FILENAME` secret and the
   content as the `YANDEX_VERIFICATION_CONTENT` secret (both plain single-line
   values, copy-pasted exactly as Yandex shows them — no guessing/derivation
   happens on this side, by design, to avoid getting Yandex's exact format
   wrong). Deploy, then confirm in the Yandex Webmaster UI.

All three secrets (`BING_SITE_VERIFICATION_ID`,
`YANDEX_VERIFICATION_FILENAME`, `YANDEX_VERIFICATION_CONTENT`) are OPTIONAL —
unset means that endpoint is simply absent (404), with a
`::warning::` build-log line calling it out, exactly like
`VITE_TURNSTILE_SITE_KEY` before PR #390 merged.

## 9. Manual end-to-end check after setting up the secrets

```bash
# 1. IndexNow key file live?
curl -s https://cheekycheese.tech/<your-key>.txt
# should echo the key verbatim

# 2. Bing verification file (if using the XML method)?
curl -s https://cheekycheese.tech/BingSiteAuth.xml

# 3. Yandex verification file?
curl -s https://cheekycheese.tech/<your-yandex-filename>.html

# 4. Full locale-routing regression:
scripts/devops/check-locale-routing.sh https://cheekycheese.tech
```
