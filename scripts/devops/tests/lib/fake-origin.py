#!/usr/bin/env python3
"""
fake-origin.py — a controllable stand-in for the nginx edge, used to prove that
scripts/devops/check-security-headers.sh, check-nginx-perimeter.sh and
check-locale-routing.sh can actually go RED (task-guards-teeth, 2026-08-07).

WHY A STUB AND NOT REAL NGINX:
  Those three guards are pure curl suites — they assert things about the HTTP
  responses an origin produces. What needs proving here is that the GUARD
  notices a broken origin, not that nginx is configured correctly (deploy.yml
  already runs all three against the real nginx, locally and on the VPS, and
  that is where the config itself is verified). Standing up real nginx here
  would need docker in the test path, the njs module, and the whole conf tree —
  and would still not let us produce the deliberately-broken responses that the
  negative cases require, because a broken nginx config mostly fails to start
  rather than serving subtly-wrong headers.

  So: this file serves responses that are CORRECT by default and BROKEN in one
  specific, named way per `--flaw`. The header values in the `good` path are
  copied verbatim from nginx/conf.d/csp-map.conf + security-headers.conf, so the
  positive case is not a tautology — if someone edits the real CSP such that the
  guard's assertions no longer match it, this fixture keeps the OLD value and
  the positive case stays green while prod diverges. That is a real limitation,
  stated plainly: this proves the GUARD's logic, not the nginx config. The
  config side is proven by deploy.yml's own FATAL smoke steps against real nginx.

Usage:
  fake-origin.py --suite headers|perimeter|locale [--flaw NAME] --port-file PATH

The port is chosen by the OS (bind :0) and written to --port-file once the
socket is listening, so tests never race on a hardcoded port and parallel test
files cannot collide.
"""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LANDING_HOST = "cheekycheese.tech"
CRM_HOST = "app.cheekycheese.tech"

# ── Verbatim from nginx/conf.d/csp-map.conf (see module docstring) ─────────────
LANDING_CSP = (
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; "
    "font-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; "
    "frame-src 'self' blob: https://challenges.cloudflare.com; object-src 'self' blob:; "
    "base-uri 'self'; frame-ancestors 'none'; form-action 'self';"
)
CRM_CSP = (
    "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; "
    "connect-src 'self' https://*.r2.cloudflarestorage.com; "
    "frame-src 'self' blob: https://*.r2.cloudflarestorage.com; "
    "object-src 'self' blob: https://*.r2.cloudflarestorage.com; "
    "base-uri 'self'; frame-ancestors 'none'; form-action 'self'; "
    "report-uri /api/public/csp-report; report-to csp-endpoint;"
)
CRM_REPORTING_ENDPOINTS = 'csp-endpoint="https://app.cheekycheese.tech/api/public/csp-report"'

# ── Verbatim from nginx/conf.d/security-headers.conf ───────────────────────────
COMMON_SECURITY_HEADERS = [
    ("Strict-Transport-Security", "max-age=31536000; includeSubDomains"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
]

# nginx's stock error-page template — check-nginx-perimeter.sh keys on the
# constant `<center>nginx</center>` footer, so the fixture must carry it.
NGINX_ERROR_PAGE = (
    "<html>\r\n<head><title>{code} {reason}</title></head>\r\n"
    "<body>\r\n<center><h1>{code} {reason}</h1></center>\r\n"
    "<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n"
)

# nginx client_max_body_size per vhost (nginx/conf.d/crm.conf: 12m,
# landing.conf: 7m).
BODY_LIMITS = {CRM_HOST: 12 * 1024 * 1024, LANDING_HOST: 7 * 1024 * 1024}

SUPPORTED_LOCALES = ("uk", "ru", "es", "pt")
# All five locales, in the order apps/landing/app/i18n/locale.ts lists them.
# `en` is the default and is published WITHOUT a prefix.
LOCALES = ("en",) + SUPPORTED_LOCALES
COUNTRY_TO_LOCALE = {"UA": "uk", "RU": "ru", "BR": "pt", "MX": "es", "ES": "es", "PT": "pt"}
# Paths that exist in the prerendered output for every locale. Anything else
# must NOT be redirected into a language the page does not exist in (the
# partial-prerender guard check-locale-routing.sh asserts). The same list is
# what sitemap.xml advertises — in the real app both come from one prerender
# pass, so keeping one list here preserves that property instead of letting
# the fixture drift into a shape production cannot produce.
PRERENDERED = ("", "careers/", "careers/my-slug/")
# Production-absolute origin, as it appears in sitemap.xml and in every
# canonical/hreflang href — apps/landing/app/lib/seo.ts SITE_ORIGIN. Those
# URLs stay production-absolute even when the site is served from a local
# container, which is why check-locale-routing.sh re-points them at $ORIGIN
# before fetching.
SITE = "https://cheekycheese.tech"


def locale_path(locale, page):
    """`/careers/` for en, `/uk/careers/` for uk — mirrors localizedPath()."""
    prefix = "" if locale == "en" else locale + "/"
    return "/" + prefix + page


def split_locale_path(path):
    """(locale, page) for a request path. Unprefixed paths are `en`."""
    rel = path.lstrip("/")
    first = rel.split("/")[0] if rel else ""
    if first in SUPPORTED_LOCALES:
        return first, rel[len(first) + 1 :]
    return "en", rel


def sitemap_xml():
    """5 locales × PRERENDERED pages, each with a reciprocal alternate cluster."""
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        'xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ]
    for locale in LOCALES:
        for page in PRERENDERED:
            out.append("<url>")
            out.append("<loc>%s%s</loc>" % (SITE, locale_path(locale, page)))
            for alt in LOCALES:
                out.append(
                    '<xhtml:link rel="alternate" hreflang="%s" href="%s%s"/>'
                    % (alt, SITE, locale_path(alt, page))
                )
            out.append(
                '<xhtml:link rel="alternate" hreflang="x-default" href="%s%s"/>'
                % (SITE, locale_path("en", page))
            )
            out.append("</url>")
    out.append("</urlset>")
    return "".join(out)


def page_html(locale, page):
    """A page's <head> as the prerenderer writes it: self-canonical + cluster."""
    canonical = SITE + locale_path(locale, page)
    if ARGS.flaw == "canonical-cross-points" and locale != "en":
        # The page defers to a DIFFERENT URL — i.e. asks to be dropped from
        # the index. This is the shape the English pages ended up in when
        # Google followed the geo 302 and read the Ukrainian markup instead.
        canonical = SITE + locale_path("en", page)

    def alternate_href(target_locale):
        if ARGS.flaw == "hreflang-points-at-redirect" and target_locale == "en":
            # Advertises the `/en/` alias — an address that answers 301, not
            # 200. Points a crawler at a hop instead of a page.
            return SITE + "/en" + locale_path("en", page)
        return SITE + locale_path(target_locale, page)

    links = ['<link rel="canonical" href="%s">' % canonical]
    for alt in LOCALES:
        links.append(
            '<link rel="alternate" hreflang="%s" href="%s" data-hreflang-alternate="true">'
            % (alt, alternate_href(alt))
        )
    links.append(
        '<link rel="alternate" hreflang="x-default" href="%s" data-hreflang-alternate="true">'
        % alternate_href("en")
    )
    return '<html lang="%s"><head>%s</head><body>%s</body></html>' % (
        locale,
        "".join(links),
        locale + ":" + (page or "home"),
    )

ARGS = None


def parse_accept_language(raw):
    """Best match against SUPPORTED_LOCALES + en, honouring q-values.

    Mirrors nginx/njs's documented detection order closely enough to satisfy
    check-locale-routing.sh's cases; it is a fixture, not a reimplementation
    anyone should depend on.
    """
    best = (None, -1.0)
    for i, part in enumerate(raw.split(",")):
        part = part.strip()
        if not part:
            continue
        bits = part.split(";")
        tag = bits[0].strip().lower()
        q = 1.0
        for extra in bits[1:]:
            extra = extra.strip()
            if extra.startswith("q="):
                try:
                    q = float(extra[2:])
                except ValueError:
                    q = 0.0
        base = tag.split("-")[0]
        if base != "en" and base not in SUPPORTED_LOCALES:
            continue
        # Left-to-right tiebreak on equal q, matching the header's own ordering.
        if q > best[1]:
            best = (base, q)
    return best[0]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Silence the default per-request stderr logging (noise in test output).
    def log_message(self, fmt, *args):
        pass

    # ── helpers ───────────────────────────────────────────────────────────────
    @property
    def host(self):
        raw = self.headers.get("Host", "")
        return raw.split(":")[0]

    def resolved_host(self):
        """Which vhost this request lands on.

        A Host matching neither vhost is the default_server case. `--default-host`
        decides what an unrecognised/absent Host means for this run, because the
        two suites legitimately disagree: check-locale-routing.sh sends NO Host
        override at all (it relies on the origin URL's own host) and expects the
        landing vhost, while check-nginx-perimeter.sh sends no Host precisely to
        assert the catch-all closes the connection.
        """
        h = self.host
        if h in (LANDING_HOST, CRM_HOST):
            return h
        return ARGS.default_host  # "landing" | "reject"

    def send_body(self, code, body, headers, content_type="text/html; charset=utf-8"):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    def close_without_response(self):
        """nginx `return 444;` — connection closed, no response line at all.

        curl reports this as exit 52 / http_code 000, which is exactly what
        check-nginx-perimeter.sh's check_connection_closed asserts.
        """
        self.close_connection = True
        try:
            self.connection.close()
        except OSError:
            pass

    # ── security-headers suite ────────────────────────────────────────────────
    def headers_for(self, host, path):
        out = list(COMMON_SECURITY_HEADERS)
        is_asset = path.endswith(".js") or path.endswith(".css")

        if ARGS.flaw == "assets-lose-headers" and host == CRM_HOST and is_asset:
            # The real #429 regression: a location with its own add_header drops
            # ALL server-level add_header inheritance, so asset responses shipped
            # with zero security headers.
            return [("Cache-Control", "public, max-age=31536000, immutable")]

        if host == CRM_HOST:
            csp = CRM_CSP
            if ARGS.flaw == "csp-says-nothing":
                # The header is PRESENT — and grants everything. This is the
                # "green because a header exists" cheat in its purest form.
                csp = "default-src *;"
            elif ARGS.flaw == "csp-unsafe-inline":
                csp = CRM_CSP.replace(
                    "script-src 'self' https://static.cloudflareinsights.com",
                    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
                )
            elif ARGS.flaw == "csp-drops-r2":
                csp = CRM_CSP.replace(" https://*.r2.cloudflarestorage.com", "")

            header_name = (
                "Content-Security-Policy"
                if ARGS.crm_csp_mode == "enforcing"
                else "Content-Security-Policy-Report-Only"
            )
            if ARGS.flaw == "csp-premature-enforcing":
                header_name = "Content-Security-Policy"
            out.append((header_name, csp))
            out.append(("Reporting-Endpoints", CRM_REPORTING_ENDPOINTS))
        else:
            csp = LANDING_CSP
            if ARGS.flaw == "landing-drops-turnstile":
                # The original PR #429 incident: Turnstile missing from the
                # directives that matter, silently breaking the apply form.
                csp = LANDING_CSP.replace(" https://challenges.cloudflare.com", "")
            out.append(("Content-Security-Policy", csp))
        return out

    # ── locale suite ──────────────────────────────────────────────────────────
    def locale_response(self):
        path = self.path.split("?")[0]
        # Everything from "?" on, "" when absent — nginx's $is_args$args.
        raw_query = self.path[len(path) :]
        accept_language = self.headers.get("Accept-Language", "")
        cookie = self.headers.get("Cookie", "")
        country = self.headers.get("CF-IPCountry", "")

        if ARGS.flaw == "redos" and len(accept_language) > 1024:
            # Simulates the pre-fix catastrophic-backtracking regex: a long
            # pathological header costs orders of magnitude more than a normal one.
            time.sleep(1.5)

        # Exactly the request headers the locale decision reads. `CF-IPCountry`
        # belonged here while geolocation was a tier; the 2026-08-08
        # indexability fix removed that tier, so claiming it now would be a
        # cache split on a value that differs per visitor.
        vary = "Accept-Language, Cookie"
        if ARGS.flaw == "vary-partial":
            # Header present, but it omits a field that participates in the
            # decision — a cache would then serve one visitor's locale to another.
            vary = "Accept-Language"
        elif ARGS.flaw == "vary-claims-geo":
            # The opposite dishonesty: Vary advertises a header nothing reads.
            vary = "Accept-Language, Cookie, CF-IPCountry"

        headers = [("Vary", vary)]
        if ARGS.flaw != "no-cache-control":
            # A 302 that a shared cache may store hands one visitor's locale to
            # the next visitor behind the same cache key.
            headers.append(("Cache-Control", "no-store"))

        if path == "/sitemap.xml":
            body = sitemap_xml()
            if ARGS.flaw == "empty-sitemap":
                # Well-formed and utterly empty — the shape a build that ran
                # against zero data produces. Every INDEX-* sweep then has
                # nothing to iterate and must NOT report a vacuous success.
                body = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
                )
            self.send_body(200, body, headers, content_type="application/xml")
            return

        # `/en/…` is not a route (English is unprefixed) — it exists only as a
        # duplicate the SPA fallback used to answer 200. Permanently collapsed
        # onto the canonical URL.
        if path == "/en" or path.startswith("/en/"):
            if ARGS.flaw == "en-alias-200":
                self.send_body(200, page_html("en", ""), headers)
                return
            rest = path[len("/en/") :] if path.startswith("/en/") else ""
            # nginx's `rewrite` re-appends the query string for free, its
            # `return` does not — the slashless `/en` branch shipped without
            # an explicit `$is_args$args` in review round 1, silently dropping
            # UTM parameters. Modelled here so the guard case has teeth.
            query = "" if ARGS.flaw == "en-alias-drops-query" else raw_query
            self.send_body(301, "", headers + [("Location", "/" + rest + query)])
            return

        # Already-prefixed URLs must NEVER redirect (crawler safety).
        first_segment = path.strip("/").split("/")[0] if path.strip("/") else ""
        if first_segment in SUPPORTED_LOCALES:
            locale, page = split_locale_path(path)
            if ARGS.flaw == "prefixed-redirects":
                target = "/" + first_segment + "/"
                self.send_body(302, "", headers + [("Location", target)])
                return
            self.send_body(200, page_html(locale, page if page in PRERENDERED else ""), headers)
            return

        target = None
        cookie_locale = None
        for chunk in cookie.split(";"):
            chunk = chunk.strip()
            if chunk.startswith("pref_locale="):
                cookie_locale = chunk.split("=", 1)[1]
        if cookie_locale and ARGS.flaw != "cookie-ignored":
            target = cookie_locale
        elif accept_language:
            target = parse_accept_language(accept_language)

        if target is None and ARGS.flaw == "geo-redirects-no-preference":
            # THE PRODUCTION DEFECT, reproduced. Cloudflare injects
            # CF-IPCountry on every request, so with a geo tier in place a
            # client that expressed NO language preference gets redirected by
            # its IP address — and the clients that express none are almost
            # exclusively crawlers. The header is defaulted here rather than
            # required, because that is what the origin actually sees behind
            # the CDN: absent from curl, present by the time nginx reads it.
            target = COUNTRY_TO_LOCALE.get((country or "UA").upper())

        if not target or target == "en" or target not in SUPPORTED_LOCALES:
            page = path.lstrip("/")
            if ARGS.flaw == "sitemap-url-redirects" and page == "careers/my-slug/":
                # ONE advertised URL bounces a preference-less client. Every
                # per-header case in the guard still passes — the header cases
                # never look at an advertised URL without a preference set.
                self.send_body(302, "", headers + [("Location", "/uk/" + page)])
                return
            self.send_body(200, page_html("en", page if page in PRERENDERED else ""), headers)
            return

        # Partial-prerender guard: never redirect into a locale where the page
        # does not exist — that would be a silent language mismatch.
        #
        # task-guards-that-do-not-guard (2026-08-17): this used to answer 200
        # with EN placeholder markup here — correct until PR #539 ("stop
        # answering 200 with the homepage for pages that do not exist"),
        # which retired that catch-all. A path outside PRERENDERED is, by
        # this fixture's own definition, one that exists in NO locale at
        # all (not "exists in EN, missing in this locale" — this file has
        # no such third category), so post-#539 the honest, and now correct,
        # simulated answer is 404 — verified against the real origin in
        # check-locale-routing.sh's own "partial-prerender" case comment.
        rel = path.lstrip("/")
        if rel not in PRERENDERED and ARGS.flaw != "redirect-into-missing-page":
            self.send_body(404, "<html>404 not found</html>", headers)
            return

        if ARGS.flaw == "wrong-locale-redirect":
            # Redirect happens, status is right, Vary and Cache-Control are
            # right — only the LANGUAGE is wrong. Nothing about the response
            # looks broken except the one field that carries the whole point.
            target = "es" if target != "es" else "pt"

        self.send_body(302, "", headers + [("Location", "/" + target + "/" + rel)])

    # ── verb handlers ─────────────────────────────────────────────────────────
    def do_GET(self):
        host = self.resolved_host()
        if host == "reject":
            self.close_without_response()
            return

        if ARGS.suite == "locale":
            self.locale_response()
            return

        if ARGS.suite == "perimeter":
            if self.path.startswith("/api/health"):
                if ARGS.flaw == "gate-blocks-visitor" and self.headers.get("CF-Connecting-IP"):
                    # The reverted PR #437 bug: the gate filters on the
                    # post-realip $remote_addr, i.e. on a client-supplied header,
                    # so a genuine Cloudflare-forwarded visitor gets 403.
                    self.send_body(403, NGINX_ERROR_PAGE.format(code=403, reason="Forbidden"), [])
                    return
                self.send_body(200, '{"status":"ok"}', [], content_type="application/json")
                return
            self.send_body(200, "<html>ok</html>", [])
            return

        # headers suite
        if self.path == "/site.webmanifest":
            self.webmanifest_response(host)
            return
        self.send_body(200, "<html>ok</html>", self.headers_for(host, self.path))

    def webmanifest_response(self, host):
        """task-infra-webmanifest-mime: the two nginx defects
        check-security-headers.sh's webmanifest checks exist to catch (see
        nginx/nginx.conf's `types {}` block + nginx/conf.d/landing.conf's
        `location = /site.webmanifest`). Default (`--flaw none`) reproduces
        the FIXED behaviour, so the guard's positive cases
        (`run_case none ...`) stay green — this fixture would otherwise know
        nothing about `.webmanifest` at all and fail both new checks
        unconditionally, which is exactly the gap that made this file's own
        positive cases go red the first time these checks were added to the
        guard (they were proven against REAL nginx, not this fixture).
        `--flaw webmanifest-wrong-type` / `--flaw webmanifest-landing-
        fallback` reproduce the two PRE-fix production bugs one at a time,
        so the guard's negative cases have real teeth on this class too —
        same "both directions" discipline as every other case in this file.
        """
        headers = self.headers_for(host, self.path)
        if host == CRM_HOST:
            content_type = "application/manifest+json"
            if ARGS.flaw == "webmanifest-wrong-type":
                # THE BUG (production, before this fix): nginx's stock
                # mime.types has no `.webmanifest` entry -> falls through to
                # `default_type application/octet-stream`.
                content_type = "application/octet-stream"
            self.send_body(200, '{"name":"fixture"}', headers, content_type=content_type)
            return
        # landing
        if ARGS.flaw == "webmanifest-landing-fallback":
            # THE BUG (production, before this fix): landing has no
            # `<link rel="manifest">` and no `site.webmanifest` file, so the
            # request fell through the SPA `try_files` fallback and was
            # served the HOME PAGE — 200 OK, HTML, under a path a client
            # asked for as JSON.
            self.send_body(200, "<html>ok</html>", headers)
            return
        self.send_body(404, NGINX_ERROR_PAGE.format(code=404, reason="Not Found"), headers)

    def handle_expect_100(self):
        """Reject oversized bodies before reading them, exactly like nginx does.

        curl sends `Expect: 100-continue` for bodies over 1KB, so this is the
        branch every check-nginx-perimeter.sh body-size case actually takes.
        """
        host = self.resolved_host()
        if host == "reject":
            self.close_without_response()
            return False
        limit = BODY_LIMITS.get(host, 1024 * 1024)
        if ARGS.flaw == "no-body-limit":
            limit = float("inf")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > limit:
            self.send_body(
                413,
                NGINX_ERROR_PAGE.format(code=413, reason="Request Entity Too Large"),
                [],
            )
            self.close_connection = True
            return False
        return super().handle_expect_100()

    def do_POST(self):
        host = self.resolved_host()
        if host == "reject":
            self.close_without_response()
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        limit = BODY_LIMITS.get(host, 1024 * 1024)
        if ARGS.flaw == "no-body-limit":
            limit = float("inf")
        if length > limit:
            self.send_body(
                413, NGINX_ERROR_PAGE.format(code=413, reason="Request Entity Too Large"), []
            )
            self.close_connection = True
            return
        # Drain the body so the connection stays sane, then answer as the
        # upstream would (never nginx's own error-page template).
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            remaining -= len(chunk)
        self.send_body(200, '{"status":"ok"}', [], content_type="application/json")


def main():
    global ARGS
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", required=True, choices=["headers", "perimeter", "locale"])
    parser.add_argument("--flaw", default="none")
    parser.add_argument("--port-file", required=True)
    parser.add_argument("--crm-csp-mode", default="report-only")
    parser.add_argument(
        "--default-host",
        default=None,
        help="what an unrecognised/absent Host means: 'landing' or 'reject' (default: "
        "reject for the perimeter suite, landing otherwise)",
    )
    ARGS = parser.parse_args()
    if ARGS.default_host is None:
        ARGS.default_host = "reject" if ARGS.suite == "perimeter" else LANDING_HOST
    elif ARGS.default_host == "landing":
        ARGS.default_host = LANDING_HOST

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    with open(ARGS.port_file, "w") as f:
        f.write(str(server.server_address[1]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
