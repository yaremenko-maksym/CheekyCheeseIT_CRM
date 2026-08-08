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
COUNTRY_TO_LOCALE = {"UA": "uk", "RU": "ru", "BR": "pt", "MX": "es", "ES": "es", "PT": "pt"}
# Paths that exist in the prerendered output for every locale. Anything else
# must NOT be redirected into a language the page does not exist in (the
# partial-prerender guard check-locale-routing.sh asserts).
PRERENDERED = ("", "careers/", "careers/my-slug/")

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
        path = self.path
        accept_language = self.headers.get("Accept-Language", "")
        cookie = self.headers.get("Cookie", "")
        country = self.headers.get("CF-IPCountry", "")

        if ARGS.flaw == "redos" and len(accept_language) > 1024:
            # Simulates the pre-fix catastrophic-backtracking regex: a long
            # pathological header costs orders of magnitude more than a normal one.
            time.sleep(1.5)

        vary = "Accept-Language, Cookie, CF-IPCountry"
        if ARGS.flaw == "vary-partial":
            # Header present, but it omits a field that participates in the
            # decision — a cache would then serve one visitor's locale to another.
            vary = "Accept-Language"

        cache_control = "no-store"
        headers = [("Vary", vary), ("Cache-Control", cache_control)]

        # Already-prefixed URLs must NEVER redirect (crawler safety).
        first_segment = path.strip("/").split("/")[0] if path.strip("/") else ""
        if first_segment in SUPPORTED_LOCALES:
            if ARGS.flaw == "prefixed-redirects":
                target = "/" + first_segment + "/"
                self.send_body(302, "", headers + [("Location", target)])
                return
            self.send_body(200, "<html>prefixed</html>", headers)
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
        elif country:
            target = COUNTRY_TO_LOCALE.get(country.upper())

        if not target or target == "en" or target not in SUPPORTED_LOCALES:
            self.send_body(200, "<html>en</html>", headers)
            return

        # Partial-prerender guard: never redirect into a locale where the page
        # does not exist — that would be a silent language mismatch / 404.
        rel = path.lstrip("/")
        if rel not in PRERENDERED:
            self.send_body(200, "<html>en (no localized page)</html>", headers)
            return

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
        self.send_body(200, "<html>ok</html>", self.headers_for(host, self.path))

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
