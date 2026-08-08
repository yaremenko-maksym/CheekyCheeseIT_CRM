#!/usr/bin/env bash
# test-check-landing-seo-coverage.sh — proves
# scripts/devops/check-landing-seo-coverage.mjs goes RED when the prerendered
# landing output ships without real vacancy structured data.
#
# The guard reads `apps/landing/dist` RELATIVE TO CWD, so every case runs it from
# a fabricated CWD holding a fake dist tree. The guard file itself is the real one.
#
# The sharpest negative here is `empty-itemlist`: the JSON-LD script tag is
# present, parses fine, and has the right @type — and lists zero jobs. That is
# the shape of the actual 2026-07-27 outage (a prerender against 0 PUBLISHED
# vacancies produced a technically-valid, informationally-empty ItemList), and
# it is the exact analogue of "the header is there, its value gives you nothing".
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-landing-seo-coverage.mjs"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

ITEMLIST_FULL='{"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"ListItem","position":1,"url":"https://cheekycheese.tech/careers/senior-react/"}]}'
ITEMLIST_EMPTY='{"@context":"https://schema.org","@type":"ItemList","itemListElement":[]}'
JOBPOSTING='[{"@context":"https://schema.org","@type":"JobPosting","title":"Senior React Engineer","hiringOrganization":{"@type":"Organization","name":"CheekyCheese"}}]'
BREADCRUMB_ONLY='[{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}]'

# $1 = case dir name; writes an empty dist skeleton, echoes the CWD to run from.
new_dist() {
  local name="$1"
  local root="$WS/$name"
  mkdir -p "$root/apps/landing/dist/careers"
  printf '%s' "$root"
}

write_page() {
  local path="$1" json_ld="$2"
  mkdir -p "$(dirname "$path")"
  {
    printf '<!doctype html><html><head>'
    if [ -n "$json_ld" ]; then
      printf '<script id="seo-json-ld" type="application/ld+json">%s</script>' "$json_ld"
    fi
    printf '</head><body>careers</body></html>\n'
  } >"$path"
}

run_guard() { (cd "$1" && node "$GUARD"); }

# ── fixtures ───────────────────────────────────────────────────────────────────
GOOD="$(new_dist good)"
write_page "$GOOD/apps/landing/dist/careers/index.html" "$ITEMLIST_FULL"
write_page "$GOOD/apps/landing/dist/careers/senior-react/index.html" "$JOBPOSTING"

EMPTY_LIST="$(new_dist empty-itemlist)"
write_page "$EMPTY_LIST/apps/landing/dist/careers/index.html" "$ITEMLIST_EMPTY"
write_page "$EMPTY_LIST/apps/landing/dist/careers/senior-react/index.html" "$JOBPOSTING"

NO_JSONLD="$(new_dist no-jsonld)"
write_page "$NO_JSONLD/apps/landing/dist/careers/index.html" ""
write_page "$NO_JSONLD/apps/landing/dist/careers/senior-react/index.html" "$JOBPOSTING"

NO_JOBPOSTING="$(new_dist no-jobposting)"
write_page "$NO_JOBPOSTING/apps/landing/dist/careers/index.html" "$ITEMLIST_FULL"
write_page "$NO_JOBPOSTING/apps/landing/dist/careers/senior-react/index.html" "$BREADCRUMB_ONLY"

NO_DETAIL="$(new_dist no-detail-pages)"
write_page "$NO_DETAIL/apps/landing/dist/careers/index.html" "$ITEMLIST_FULL"

NO_DIST="$(guard_test_workspace)"

echo "== test-check-landing-seo-coverage.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "list page with a non-empty ItemList + a detail page with JobPosting passes" \
  --contains "OK — vacancy list + at least one detail page" \
  -- run_guard "$GOOD"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "THE CHEAT: ItemList present but EMPTY (valid markup, zero information) -> red" \
  --contains "no non-empty ItemList JSON-LD" \
  -- run_guard "$EMPTY_LIST"

assert_red "list page prerendered with no JSON-LD at all -> red" \
  --contains "no non-empty ItemList JSON-LD" \
  -- run_guard "$NO_JSONLD"

assert_red "detail page carries JSON-LD but no JobPosting -> red" \
  --contains "carry JobPosting JSON-LD" \
  -- run_guard "$NO_JOBPOSTING"

assert_red "no vacancy detail page prerendered at all -> red" \
  --contains "no vacancy detail subdirectories" \
  -- run_guard "$NO_DETAIL"

assert_red "dist/ missing entirely (build never ran) -> red" \
  --contains "does not exist" \
  -- run_guard "$NO_DIST"

guard_test_summary "test-check-landing-seo-coverage.sh"
