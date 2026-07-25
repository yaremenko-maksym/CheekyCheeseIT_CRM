# Locale routing runbook (task-infra-locale-edge)

Edge locale auto-detection for the landing site (`cheekycheese.tech`), plus the
IndexNow / Bing / Yandex indexing channels that ship in the same PR. Source of
truth for the detection RULES themselves: `.claude/tasks/plan-landing-i18n-seo.md`
§1 (URL scheme) and §2 (detection order + crawler-safety). This document is the
operational companion: how it's implemented, how to verify it, how to turn it
off in an emergency.

**Revision note:** this file was substantially updated after PR #423's
security-review round 1 (2 HIGH + 5 MED findings, all fixed in the same PR).
Sections 4 (guard), 5 (kill-switch), 10 (ReDoS hardening), 11 (HIGH-2 config-
injection fix), and 12 (hardening summary) reflect that round; read them even
if you're already familiar with the original design. A follow-up
security-review round 2 (1 additional MED + 4 LOW, 1 explicitly deferred) is
folded into the same sections — see §12 for the full list.

---

## 1. What ships where

| Concern                                                                   | File                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Cookie / CF-IPCountry priority, redirect-target composition, kill-switch  | `nginx/conf.d/locale-detect.conf` (plain nginx `map`)           |
| Accept-Language best-match (q-value sort + base-language fallback)        | `nginx/njs/locale.js` (njs — see §2 below for why)              |
| The actual `if`/`return 302` redirect + guard, on both `:80` and `:443`   | `nginx/conf.d/landing.conf` (`location /` in each server block) |
| `load_module` wiring for njs                                              | `nginx/nginx.conf` (top, main context)                          |
| IndexNow key file + Bing/Yandex verification files (build-time, optional) | `nginx/Dockerfile` (runtime stage — now static files, see §11)  |
| Docker log rotation (json-file cap on `api`/`nginx`)                      | `docker-compose.prod.yml`                                       |
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

**This module is on the hot path for the WHOLE edge, not just landing.** One
nginx process serves both `cheekycheese.tech` (landing) AND
`app.cheekycheese.tech` (CRM, including `/api` proxying) — a runaway or
crashing njs call here can degrade or take down BOTH, not just the marketing
site. Section 10 covers a real incident class this caused (fixed in the same
PR) and the hardening now in place.

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
- the merge-order guard (§4) confirms the SPECIFIC requested page (not just
  the locale root) actually has prerendered static content in this image.

The redirect is always **302** (not 301 — user preference is not permanent),
always carries `Vary: Accept-Language, Cookie, CF-IPCountry` (AC B4 + security-
review MED-2 — see §12) and always carries `Cache-Control: private, no-store`
(MED-2) and a relative `Location:` header (MED-1, `absolute_redirect off;` —
see §12) so caches never serve a cross-locale response to the wrong visitor
and a forged `Host` header can never appear in the redirect target.

## 4. Merge-order guard (safe regardless of merge order with `feature/landing-i18n`)

`feature/landing-i18n` (a separate, parallel Coder branch) adds the actual
prerendered `/uk/`, `/ru/`, `/es/`, `/pt/` static directories to
`apps/landing/dist`. This infra PR can land BEFORE or AFTER that branch — to
make that safe in either order, the redirect is gated on a real file-existence
check for the **exact page being requested**, not just the locale's root:

```nginx
set $locale_guard_path "";
if ($locale_prefix != "") {
    set $locale_guard_path $document_root$locale_prefix${uri}index.html;
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

**Per-path, not per-locale-root (code-review fix).** An earlier version of
this guard checked ONLY `$locale_prefix/index.html` (the locale's root page).
Under a PARTIAL prerender — e.g. `/ru/` exists but `/ru/careers/some-slug/`
does not yet — that version would still redirect, landing the visitor on a
`/ru/`-prefixed URL that silently served EN content: no 404, no loop, just a
language mismatch nobody would notice from the HTTP status alone. Checking
the exact requested path (`${uri}index.html`, where `$uri` already carries
the plan §1 `trailingSlash: 'always'`-normalised path) closes this precisely.
It turned out to cost nothing extra in complexity over the root-only version,
so there was no reason to settle for "document a 1:1 parity assumption"
instead. Regression-guarded permanently in
`scripts/devops/check-locale-routing.sh` (the "partial-prerender" case, safe
to run against real production since it uses a slug guaranteed not to exist).

**A confirmed nginx landmine, found and fixed while building this guard:**
`try_files` living in the SAME `location` as an `if` block whose condition
evaluates true (i.e. it actually runs a `set`) loses correct
directory-index fallback resolution for any NON-root URI. Verified with an
isolated minimal repro: `/` correctly falls back to `/index.html`, but
`/careers/` or any deeper path returns a bare 404 instead of ever reaching
`try_files`'s own literal `/index.html` fallback parameter — even though the
exact same `if` body ran successfully moments earlier for `/`. This is a
long-documented "if is evil" interaction (see gixy.org's "if is evil" guide),
not specific to this file. Fixed via the standard workaround: `try_files`
was moved OUT of `location /` into a named location (`@locale_fallback`),
reached via `error_page 418 = @locale_fallback; return 418;` (418 is an
arbitrary internal-only status, never sent to a client — recognised and
intercepted by `error_page` before it would be).
**`recursive_error_pages on;` is REQUIRED** for this to work — without it,
the internal redirect silently does not re-enter location matching and every
request 404s. Named locations do not inherit `add_header`/`include` from
sibling locations, so `security-headers.conf` + the `Vary` header are
repeated explicitly inside `@locale_fallback` too.

A SEPARATE, smaller inheritance gotcha in the same area: an `add_header`
declared INSIDE the `if (-f $locale_guard_path) { ... }` block (the
`Cache-Control: private, no-store` from MED-2) drops the OUTER
`add_header Vary` declared earlier in `location /` — verified empirically
(curl showed the 302 missing `Vary` entirely once Cache-Control was added
inside the `if` without also repeating Vary there). Same general nginx rule
as location-vs-server inheritance (see `nginx/conf.d/crm.conf`'s writeup),
just applying to `if`-vs-location instead. Fixed by repeating
`security-headers.conf` + `Vary` explicitly inside that `if` block too.

Verified empirically (not just reasoned about) throughout development: a
local nginx container with the `ru`/`uk` directories removed from its
mounted dist returned a plain 200 EN for every locale-triggering request;
putting them back immediately resumed 302 redirects on the next request, no
reload needed (this is a live filesystem `-f` check per request, not a
config-load-time decision).

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
for B1-B9 — but would be a reasonable follow-up task if response time faster
than a redeploy is ever needed for this specific incident class.

**Note (security-review round 1):** the kill-switch stops REDIRECTS, but
`$target_locale` is still computed for every request even with the switch on
— the map that folds the kill-switch into `$locale_prefix` still needs this
variable's value to build its lookup key. Before the ReDoS fix in §10, this
meant the kill-switch did NOT protect against a pathological
`Accept-Language` header (confirmed: the vulnerable code still took ~150ms
and logged an exception with the switch flipped on). After the §10 fix, njs
execution is cheap and safe regardless of the switch's state, so this is no
longer a live concern — noted here so a future reader doesn't assume the
kill-switch was ever meant to bypass njs execution entirely (it isn't, and
doesn't need to be, now).

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

This runs the full B1–B9 curl matrix (28 cases as of security-review round 1
— accept-language best-match, cookie priority, all 4 locale-prefixed URLs,
CF-IPCountry, Vary/Cache-Control headers, deep-path/trailing-slash
preservation, partial-prerender guard correctness, ReDoS-hardening timing)
and prints `PASS`/`FAIL` per case, exiting non-zero on any failure. Safe to
run repeatedly against production (read-only GET requests, no state
mutated).

### Local dry-run before any nginx/\*\* change

**Fast, config-only loop (recommended for iterating on `nginx/conf.d/**`,
`nginx/njs/**`, `nginx/nginx.conf`):** mount those files directly into a
stock `nginx:1.27-alpine` container against a small fixture `dist` —
this is the loop used throughout this PR's development (seconds per
iteration, no app build). Sketch:

```bash
docker network create locale-test-net
docker run -d --name api-stub --network locale-test-net --network-alias api nginx:1.27-alpine
docker run -d --name nginx-locale-test --network locale-test-net \
  -p 8080:80 \
  -v "$PWD/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/nginx/conf.d:/etc/nginx/conf.d:ro" \
  -v "$PWD/nginx/njs:/etc/nginx/njs:ro" \
  -v /path/to/a/fixture/landing/dist:/usr/share/nginx/html/landing:ro \
  nginx:1.27-alpine
scripts/devops/check-locale-routing.sh http://localhost:8080
```

(`api-stub` only needs to exist so the `api_upstream` hostname resolves —
nginx never actually needs to reach it for a config/routing smoke test.
Docker Desktop's bind-mount propagation can lag a couple of seconds after
editing a mounted file — if `nginx -t`/curl output looks stale right after
an edit, recreate the container (`docker rm -f` + `docker run`) rather than
just `nginx -s reload`, or just wait ~2s and retry.)

**Full build (slower, needed for `nginx/Dockerfile` changes — build-args,
the verification-file generation logic, the `RUN nginx -t` gate):**

```bash
docker build -f nginx/Dockerfile -t crm-nginx-test --build-arg VITE_API_URL=/api .
docker run -d --name crm-nginx-test -p 8080:80 crm-nginx-test
scripts/devops/check-locale-routing.sh http://localhost:8080
docker rm -f crm-nginx-test
```

(Requires the full monorepo build context — this builds `apps/landing` +
`apps/web` from scratch.)

## 7. IndexNow (AC B6)

[IndexNow](https://www.indexnow.org/) is a SHARED protocol — **one** POST to
`https://api.indexnow.org/indexnow` relays the notification to every
participating engine, which today includes both Bing and Yandex (the two
named in AC B6). This is why `scripts/devops/indexnow-ping.sh` only ever
calls the one shared endpoint, not separate Bing/Yandex calls. The script
builds its JSON body with `jq` (fails loudly if `jq` is missing rather than
falling back to unsafe string concatenation) — see §12 for why that matters
even though today's only call site (deploy.yml) never passes untrusted text.

### Key file

`INDEXNOW_KEY` build-arg (optional, unset = disabled/no-op) is written as a
plain static file into the landing dist at image build time — see
`nginx/Dockerfile`'s runtime stage (§11 for why it's a FILE, not a generated
nginx directive). When set, it serves the key verbatim at
`https://cheekycheese.tech/<key>.txt`, which IndexNow/Bing/Yandex fetch to
confirm domain ownership before accepting submissions. Deliberately NOT
hardcoded in the repo (see the Dockerfile comment for the rotation-cost
rationale) — set as a GitHub Actions secret (`INDEXNOW_KEY`), same channel as
`VITE_TURNSTILE_SITE_KEY` / `GOOGLE_INDEXING_SA_EMAIL` (Settings → Secrets
and variables → Actions → Secrets, environment `production`).

**Owner action to generate a key**: any sufficiently random string works (the
IndexNow spec recommends a UUID/hex string, 8-128 chars). Generate one with
`openssl rand -hex 16` (or use https://www.bing.com/indexnow to have Bing
generate one for you) and store it as the `INDEXNOW_KEY` secret. The value
must match `[A-Za-z0-9._-]+` — this is enforced at build time (fails the
build loudly, see §11) since it becomes part of a served file's path.

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
NestJS (same JSON shape this script builds, via `jq` — see §12) or shell out
to this script, passing the one vacancy URL that changed, right after the
publish/close transaction commits. Flagging this explicitly so it isn't
lost: **this PR delivers the key-file endpoint + the deploy-time ping + the
reusable ping primitive (already hardened for this exact reuse, see §12);
the publish/close hook itself is a separate, small Coder task.**

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
   `production`) — must match `[A-Za-z0-9._-]+` (enforced at build time, see
   §11; a real Bing GUID already only uses those characters, so this should
   never be a practical obstacle) — the Dockerfile wraps it in the required
   XML envelope and writes it as a static file, served at
   `https://cheekycheese.tech/BingSiteAuth.xml` on the next deploy. Verify in
   the Bing Webmaster UI once the deploy is live.

### Yandex.Webmaster

1. Go to https://webmaster.yandex.com, sign in, add the site
   `https://cheekycheese.tech`.
2. Choose the **"HTML file" verification method** (not the meta-tag method —
   a meta tag would require an `apps/landing` code change, outside this
   task's zone). Yandex gives you an exact filename (e.g.
   `yandex_0123456789abcdef.html`) and the exact content to put in it.
3. Set the filename as the `YANDEX_VERIFICATION_FILENAME` secret (must match
   `[A-Za-z0-9._-]+` — enforced at build time, see §11) and the content as
   the `YANDEX_VERIFICATION_CONTENT` secret (copy-pasted exactly as Yandex
   shows it — no charset restriction on the CONTENT value, since it is now
   written to a plain file, never interpolated into nginx config grammar;
   see §11 for why that distinction matters). Deploy, then confirm in the
   Yandex Webmaster UI.

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

## 10. ReDoS hardening (security-review round 1, HIGH-1, AC B9)

**What was wrong.** The original `Accept-Language` q-value regex,
`/^q=([0-9]*\.?[0-9]+)$/`, has two adjacent quantifiers (`[0-9]*` and
`[0-9]+`) that can both match the same digit run. A crafted, non-matching
input (a long digit run followed by a non-digit, e.g.
`Accept-Language: zz;q=999...9x` with ~7800 nines) forces the regex engine
to retry every possible split between the two quantifiers before giving up —
classic CWE-1333 catastrophic backtracking. There was also NO length or tag-
count cap, and `nginx/nginx.conf` doesn't override
`large_client_header_buffers`, so nginx itself will pass up to ~8 KB in a
single header line through to njs.

**Measured impact (before the fix, reproduced in an isolated container):**

| Request                                            | Response time                                |
| -------------------------------------------------- | -------------------------------------------- |
| `Accept-Language: en-US,en;q=0.9` (baseline)       | ~3 ms                                        |
| `Accept-Language: zz;q=<7800×'9'>x` (pathological) | **~142 ms** (≈40-100× depending on hardware) |

Each pathological request ALSO threw an unhandled njs exception, logged to
the nginx error log:

```
js exception: InternalError: pcre2_match() failed: match limit exceeded
    at String.prototype.match (native) at parseAcceptLanguage (locale.js:...) at targetLocale (locale.js:...)
```

No 500 was returned to the client (nginx degrades a failed variable
evaluation to the map's `default ""`, i.e. a plain 200 EN) — the DoS is
purely a CPU/latency/log-volume problem, not a correctness one. But: this
runs on the SAME nginx process that serves `app.cheekycheese.tech`/CRM
`/api` (see §2), the kill-switch does not stop it (§5), and `limit_req`
would not help either even if one existed on landing today (it doesn't) —
`if`/`return` in `location /` executes in the REWRITE phase, which runs
BEFORE `limit_req`'s PREACCESS phase.

**Fix (`nginx/njs/locale.js`), verified by benchmark:**

1. `MAX_HEADER_LEN = 512` — the header is truncated before any parsing.
2. `MAX_TAGS = 20` — at most this many comma-separated tags are processed.
3. The q-value regex was replaced with the RFC 9110 §12.4.2 qvalue grammar,
   `/^q=(?:0(?:\.[0-9]{1,3})?|1(?:\.0{1,3})?)$/` — no overlapping
   quantifiers, fixed `{1,3}` bound, cannot backtrack more than a constant
   amount regardless of input length.
4. The entire exported `targetLocale(r)` function is wrapped in try/catch,
   returning `"en"` on ANY exception — defense-in-depth so a future,
   currently-unknown edge case degrades safely instead of throwing on the
   hot path again.

**Measured impact (after the fix, same pathological payload, same
container):** baseline and pathological-payload timings became
indistinguishable (both ~2-4 ms) — no meaningful overhead, and the error log
stayed clean (verified via `docker logs`, no `pcre2_match` line appears).

**Regression guard:** `scripts/devops/check-locale-routing.sh`'s "B9" case
sends the same ~7.8 KB pathological header and asserts the response time
does not exceed `min(500ms, 10× baseline)` — generous enough to absorb real
network/TLS variance in production while still catching a multi-order-of-
magnitude regression. That script CANNOT check the error log for an
arbitrary HTTP origin (no log access over HTTP) — the "no exception logged"
half of this verification is a manual step for local dry-runs:

```bash
# after check-locale-routing.sh B9 passes against a local container:
docker logs <container> 2>&1 | grep -i pcre2
# should print nothing
```

## 11. Config-injection hardening (security-review round 1, HIGH-2)

**What was wrong.** The original `nginx/Dockerfile` interpolated the
IndexNow/Bing/Yandex build-arg VALUES directly into GENERATED nginx
`location { return 200 "..."; }` directives. A value containing `"`, `;`,
`{`, or a newline could break out of the intended string literal and inject
arbitrary nginx config. Proof-of-concept (reproduced against a real build +
live container):

```
YANDEX_VERIFICATION_CONTENT='a"; } location /pwn { alias /etc/; autoindex on; } location = /zz { return 200 "b'
```

The generated config PASSED `nginx -t` (there was no build-time syntax gate
at all before this fix) and, on a live container, `GET /pwn/passwd` returned
the container's `/etc/passwd`. The realistic trigger for this is not a
remote attacker (the values come from GitHub secrets the owner controls) but
an honest COPY-PASTE ACCIDENT: Yandex's "HTML file" verification content is
commonly multi-line HTML with quotes in it, and the runbook (this file, in
its previous revision) told the owner to paste it verbatim.

**Fix — three independent layers, all verified:**

1. **Static files, not generated directives.** IndexNow key / Bing XML /
   Yandex content are now written as plain files under the landing dist
   root (`printf '%s' "$VALUE" > "$LANDING_ROOT/$FILENAME"`) and served by
   the SAME SPA-fallback `location /` / `try_files` mechanism that already
   serves `robots.txt`/`sitemap.xml` (see the note at the top of
   `nginx/conf.d/landing.conf`). File BYTES are never interpolated into
   nginx config GRAMMAR anymore, so no CONTENT value can inject a directive
   regardless of what characters it contains. Verified: the exact PoC above,
   rebuilt against the fixed Dockerfile, produces a harmless static file
   (`cat`-able, containing the literal payload text) — `grep -r
'pwn\|autoindex' /etc/nginx/conf.d/` inside the built image finds
   nothing.
2. **Allow-list on path-bearing values.** `INDEXNOW_KEY`,
   `BING_SITE_VERIFICATION_ID`, and `YANDEX_VERIFICATION_FILENAME` all
   become part of a FILE PATH (so `/` or `..` could still attempt path
   traversal even with layer 1 in place) — each is validated against
   `[A-Za-z0-9._-]+` at build time; anything else FAILS THE BUILD LOUDLY.
   Verified: `YANDEX_VERIFICATION_FILENAME=../../etc/passwd` makes the build
   exit non-zero with an explicit `ERROR: ... contains characters outside
[A-Za-z0-9._-]` message, before any file is ever written.
   `YANDEX_VERIFICATION_CONTENT` deliberately carries NO charset
   restriction — it only ever becomes file bytes now, never config syntax,
   so restricting it would just be friction with no security benefit.
3. **`RUN nginx -t` gate in the image build.** Any config mistake (this
   class or any other) now fails the BUILD, not a later deploy. This needed
   two build-time-only substitutions on a COPY of the config (never the
   shipped files):
   - `upstream api_upstream { server api:3001; }` → `server 127.0.0.1:1;`
     (there is no `api` container/DNS during `docker build` — `-t` only
     validates syntax, it never connects, so a literal always-resolvable IP
     is sufficient).
   - `ssl_certificate`/`ssl_certificate_key` lines stripped and
     `listen 443 ssl;` → `listen 8443;` in a build-time-only copy of
     `conf.d/` (the real certs are mounted into the container at RUNTIME by
     `docker-compose.prod.yml`, never baked into the image — generating a
     throwaway cert wasn't viable either: `nginx:1.27-alpine` doesn't ship
     `openssl`, and committing a dummy private key to the repo is exactly
     the kind of thing secret-scanners flag regardless of it being inert).

   `nginx/conf.d/locale-detect.conf`'s `js_import` was also switched from a
   relative (`njs/locale.js`) to an absolute (`/etc/nginx/njs/locale.js`)
   path as part of getting this gate working — a relative path resolves
   against nginx's `-p` prefix, which the build-time `-c
/tmp/.../nginx.conf` test changes; absolute removes that ambiguity for
   good, for every invocation, not just this one.

**Deploy-time healthcheck (owner-requested addition, beyond the original
B1-B9 scope, closes the remaining gap between "build succeeds" and "the
public site is actually reachable"):** the previous external smoke-check in
`deploy.yml` (`curl .../api/health`) was non-fatal by design (documented as
tolerating "Cloudflare/TLS may not be configured yet" — true on day one, no
longer true for an already-live production site). Since this PR is what
adds a real class of "nginx never starts, deploy reports success" risk
(a broken config from ANY future edit, not just this PR's own values), a
NEW, FATAL check was added to the deploy job: `curl -f` against `/` AND
one locale URL (`/uk/`), both required to return 200 before the deploy step
can succeed. A failure here fails the whole deploy job (visible red X in
the Actions run) — no automatic rollback is implemented (out of scope for
this security-fix round; flagged as a reasonable follow-up if
faster-than-manual recovery is ever needed).

**round 2 (LOW-3):** the FIRST version of this check hit the public
hostname directly (`https://cheekycheese.tech/`) — since the check runs in
the SSH session ON the VPS itself, this meant the VPS made an OUTBOUND
request through Cloudflare and back to itself (a hairpin round-trip). A
transient Cloudflare blip or DNS hiccup — unrelated to nginx's own health —
would fail the deploy on a false positive. Fixed by hitting nginx's
PUBLISHED PORT directly on loopback instead:
`curl -sf -H 'Host: cheekycheese.tech' http://127.0.0.1/`. This still goes
THROUGH nginx — the real `landing.conf` server block, the locale-detect njs
module, the merge-order guard, everything this PR added — but never leaves
the VPS or depends on Cloudflare/DNS being reachable. Port 80 (not 443): no
TLS handshake/cert complexity needed, and the `:80` server block runs the
exact same locale-redirect logic as `:443` (the two blocks are kept in sync
deliberately throughout this file).

## 12. Hardening summary (security-review rounds 1 + 2)

| Finding                                                                                                                                                                                                                                                                                                                                                        | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MED-1: `Location:` built from client-controlled `Host`                                                                                                                                                                                                                                                                                                         | `absolute_redirect off;` in both landing server blocks — nginx now emits a relative `Location: /ru/...` instead of resolving it against `$host`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| MED-2: `CF-IPCountry` missing from `Vary`; no `Cache-Control` on 302                                                                                                                                                                                                                                                                                           | `Vary: Accept-Language, Cookie, CF-IPCountry` everywhere the decision is made; `Cache-Control: private, no-store` on the redirect branch specifically.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| MED-2 (documented, not "fixable" on the origin side): Cloudflare `Vary`                                                                                                                                                                                                                                                                                        | Cloudflare only honours `Vary: Accept-Encoding` for its cache KEY — if a CF cache rule is ever added for HTML on this zone, origin-side `Vary` will NOT stop CF from serving one locale to everyone. Today this is safe because CF does not cache HTML on this zone by default; if that ever changes, the zone-level fix is a CF cache-bypass rule for `/` and `/careers/*`, not another origin-side header.                                                                                                                                                                                  |
| MED-3: locale-prefixed HTML missing the `no-store` policy EN gets                                                                                                                                                                                                                                                                                              | `location = /index.html` broadened to `location ~ ^/(?:(?:uk\|ru\|es\|pt)/)?index\.html$` — covers `/uk/index.html` etc. too. **Superseded by MED-6 below** (that regex still only matched locale ROOTS).                                                                                                                                                                                                                                                                                                                                                                                     |
| MED-4: JS/CSS assets losing all 6 security headers (pre-existing, not a regression — fixed anyway since the file was already open)                                                                                                                                                                                                                             | `include /etc/nginx/conf.d/security-headers.conf;` added to the asset-extension `location` block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| MED-5: unbounded docker json-file logs                                                                                                                                                                                                                                                                                                                         | `logging: driver: json-file, options: {max-size: 10m, max-file: 5}` added to the `api` and `nginx` services in `docker-compose.prod.yml`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **MED-6** (round 2): MED-3's regex only matched locale ROOTS — `/careers/index.html`, `/uk/careers/index.html`, `/uk/careers/<slug>/index.html` (exactly what `feature/landing-i18n` prerenders) fell through to `@locale_fallback` with NO explicit Cache-Control. Latent on `main` today, would have gone live the moment that branch merges.                | `location ~ ^/(?:(?:uk\|ru\|es\|pt)/)?index\.html$` → `location ~ /index\.html$` — matches the SUFFIX only, any nesting depth. Verified against a real fixture tree with `index.html` at 0/1/2/3 nesting levels (root, `/careers/`, `/uk/careers/`, `/uk/careers/my-slug/`) — all four now carry `Cache-Control: no-cache, no-store, must-revalidate` + all 6 security headers + `Vary`. Permanent regression guard in `check-locale-routing.sh` (`/careers/` — exists on `main` today independent of `feature/landing-i18n`, so this case is safe to run against real production right now). |
| **LOW-1** (round 2): an out-of-grammar `q=` value (`q=abc`, `q=-1`, `q=2`, `q=0.0000` — RFC 9110 allows at most 3 fractional digits) silently fell back to the DEFAULT `q=1`, so e.g. `Accept-Language: ru;q=0.0000` incorrectly won outright. Not a security hole (the SUPPORTED allow-list still constrains the final locale either way), but wrong ranking. | `nginx/njs/locale.js`: a `q=` parameter present but failing `Q_RE` now marks the WHOLE TAG invalid (forced to `q=0`), reusing the existing `entry.q > 0` filter — same mechanism RFC 9110 already uses for an explicit `q=0`. Verified: `ru;q=0.0000`/`q=abc`/`q=-1`/`q=2` now all correctly get excluded (no redirect); `ru;q=0.9` (valid) still redirects; a multi-tag header with an invalid FIRST tag correctly falls through to the next valid one.                                                                                                                                      |
| **LOW-3** (round 2): the new fatal deploy healthcheck (§11) hit the public hostname through Cloudflare — a hairpin round-trip that could false-fail the deploy on an unrelated CF/DNS blip.                                                                                                                                                                    | Now hits nginx's published port directly on loopback with an explicit `Host` header (`curl -H 'Host: cheekycheese.tech' http://127.0.0.1/`) — still exercises the real nginx config, no longer depends on the public network. See §11 for the full before/after.                                                                                                                                                                                                                                                                                                                              |
| **LOW-4** (round 2): an allow-list-clean value could still silently overwrite an existing landing asset — e.g. `YANDEX_VERIFICATION_FILENAME=index.html` (overwrites the homepage) or `INDEXNOW_KEY=robots` (overwrites `robots.txt`).                                                                                                                         | `nginx/Dockerfile`: a `check_no_collision` guard runs before every file write — if the target path already exists in the landing dist (populated by the `COPY --from=landing-builder` step earlier in the same stage), the build fails loudly instead of overwriting. Verified: both `INDEXNOW_KEY=robots` (against a fixture with `robots.txt`) and `YANDEX_VERIFICATION_FILENAME=index.html` correctly fail the build with an explicit `ERROR: ... already exists` message, before any file is touched.                                                                                     |
| **LOW-2** (round 2, deliberately NOT fixed — see below)                                                                                                                                                                                                                                                                                                        | See "Known limitation" note directly below this table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| LOW: `indexnow-ping.sh` string-concatenated JSON, fixed temp-file path                                                                                                                                                                                                                                                                                         | Rewritten to build the JSON body with `jq` (fails loudly if `jq` is missing), use `mktemp` for the response file, and `set -euo pipefail`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Known limitation (LOW-2, round 2 — intentionally left as-is):** the
`targetLocale(r)` try/catch added for HIGH-1 (§10) swallows ANY exception
and returns `"en"` with zero observability — no log line, no metric, no
way to tell from the outside that something unexpected happened inside
njs on a given request. This is a deliberate trade-off, not an oversight:
`targetLocale` runs on the hot path for the WHOLE edge (§2) on
unauthenticated traffic, and adding even a rate-limited log line there
reintroduces a shape of the exact same class of risk HIGH-1 just closed
(attacker-influenced logging volume on a hot path). If this ever needs
real observability, the safer place to add it is OUTSIDE the hot path —
e.g. a periodic synthetic-request check rather than logging from inside
the exception handler itself.

All of the above are verified the same way as everything else in this
runbook — real `nginx -t`, real containers, real `curl`, not just read
through — see this PR's description for the full command-by-command
evidence log.
