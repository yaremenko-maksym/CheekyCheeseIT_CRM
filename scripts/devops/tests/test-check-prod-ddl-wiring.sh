#!/usr/bin/env bash
# test-check-prod-ddl-wiring.sh — proves scripts/devops/check-prod-ddl-wiring.py
# goes RED when a manual DDL file is not really wired into deploy.yml.
#
# The headline case is `comment-only`: the filename appears in deploy.yml prose
# and nowhere else. That is precisely how the guard behaved for its entire life
# before 2026-08-07 (`wired = {f for f in all_files if f in deploy_yml_content}`),
# which means the guard created in response to the #422 prod outage would have
# stayed green through #422 itself.
#
# Every case runs the REAL, unmodified guard — copied into a fabricated repo root
# so that its `<script>/../..` path resolution points at fixtures instead of this
# repo.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="check-prod-ddl-wiring.py"
DDL="2099-01-01_fake_guard_fixture.sql"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# Builds a fake repo containing ONE manual DDL file plus the given deploy.yml
# body, and echoes its root.
# $1 = case name, $2 = deploy.yml content, $3 = (optional) DDL filename
make_case() {
  local name="$1" deploy_yml="$2" ddl="${3:-$DDL}"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/apps/api/drizzle/manual"
  printf 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;\n' >"$root/apps/api/drizzle/manual/$ddl"
  printf '%s' "$deploy_yml" >"$root/.github/workflows/deploy.yml"
  printf '%s' "$root"
}

run_guard() { python3 "$1/scripts/devops/$GUARD"; }

# ── manual-private reverse-invariant fixtures ───────────────────────────────────
# apps/api/drizzle/manual-private/ (task-guard-manual-private-ddl, 2026-08-12,
# PR #517 security review): the reverse of everything above — these files must
# NOT be wired anywhere in .github/workflows/**, since they print row-level
# financial detail into what would be a public CI log.
PRIVATE_DDL="2099-01-01_fake_private_fixture.sql"

# Builds a fake repo with NO apps/api/drizzle/manual/ file (the reverse
# invariant is independent of it) and, unless $3="absent", a
# manual-private/$PRIVATE_DDL fixture. $2's content becomes deploy.yml.
# $1 = case name, $2 = deploy.yml content, $3 = "absent" to omit the
#      manual-private directory entirely (proves the silent-skip case)
make_private_case() {
  local name="$1" deploy_yml="$2" mode="${3:-present}"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  if [ "$mode" != "absent" ]; then
    mkdir -p "$root/apps/api/drizzle/manual-private"
    printf -- '-- fixture, must never be wired\nSELECT 1;\n' \
      >"$root/apps/api/drizzle/manual-private/$PRIVATE_DDL"
  fi
  printf '%s' "$deploy_yml" >"$root/.github/workflows/deploy.yml"
  printf '%s' "$root"
}

# Same fixture file, but the leak lives in a SECOND workflow file, not
# deploy.yml — proves the scan is over .github/workflows/**, not one file.
make_private_other_workflow_case() {
  local name="$1"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/apps/api/drizzle/manual-private"
  printf -- '-- fixture, must never be wired\nSELECT 1;\n' \
    >"$root/apps/api/drizzle/manual-private/$PRIVATE_DDL"
  printf 'name: Deploy\non: {push: {branches: [main]}}\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo restart\n' \
    >"$root/.github/workflows/deploy.yml"
  printf 'name: Debug Dump\non: workflow_dispatch\njobs:\n  dump:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cat apps/api/drizzle/manual-private/%s\n' \
    "$PRIVATE_DDL" >"$root/.github/workflows/debug-dump.yml"
  printf '%s' "$root"
}

# ── fixtures ───────────────────────────────────────────────────────────────────
read -r -d '' WIRED_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            if [ ! -f "\$FIXTURE_FILE" ]; then
              echo "ERROR: DDL file not found at \$FIXTURE_FILE"
              exit 1
            fi
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# The cheat. Filename present three times — a step name, a `with:` comment and a
# SOURCE comment in the apply script — and copied/applied exactly zero times.
read -r -d '' COMMENT_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      # Copies the compose files and $DDL to the VPS.
      - name: Copy compose + $DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          # apps/api/drizzle/manual/$DDL
          #   -> /opt/crm/apps/api/drizzle/manual/$DDL
          source: 'docker-compose.prod.yml'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            # Source: apps/api/drizzle/manual/$DDL
            # Applied below (idempotent, ADD COLUMN IF NOT EXISTS).
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -c 'select 1'
YML

read -r -d '' COPY_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -c 'select 1'
YML

read -r -d '' APPLY_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'docker-compose.prod.yml'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Review round 2, H1. Both zones carry the filename in a TRAILING comment and
# nowhere else. This was GREEN before the fix — the guard stripped whole comment
# lines but read `source:` to end-of-line and took apply lines whole, so prose to
# the RIGHT of code satisfied it while it printed "Comment-only mentions do NOT
# count".
read -r -d '' TRAILING_COMMENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'docker-compose.prod.yml'   # also ships $DDL
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            OTHER_FILE="/opt/crm/apps/api/drizzle/manual/2026-01-01_other.sql"   # supersedes $DDL
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$OTHER_FILE"
YML

# Review round 2, MED. The realistic shape of "copied but never applied": the scp
# entry is real, and the only trace in the deploy job is deploy.yml's OWN
# house-style comment block, copied verbatim from the real workflow. Pins the
# whole-line comment stripping that the H1 fix sits on top of.
read -r -d '' COPY_PLUS_HOUSE_COMMENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
          # scp-action preserves the source directory tree under target:
          # apps/api/drizzle/manual/$DDL
          #   → /opt/crm/apps/api/drizzle/manual/$DDL
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            # ── Step 2z: fixture columns (idempotent) ────────────────────────
            # Source: apps/api/drizzle/manual/$DDL
            #   → /opt/crm/apps/api/drizzle/manual/$DDL
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -c 'select 1'
YML

# Review round 2, MED. A `::notice::` line saying the file is ABSENT is the
# opposite of wiring, yet it lived on an executable line inside the step that
# builds the scp source list, so it counted as a copy.
read -r -d '' NOTICE_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Check for DDL file
        id: ddl-check
        run: |
          if [ -f apps/api/drizzle/manual/other.sql ]; then
            echo "source_list=apps/api/drizzle/manual/other.sql" >> "\$GITHUB_OUTPUT"
            echo "any_exist=true" >> "\$GITHUB_OUTPUT"
          else
            echo "::notice::apps/api/drizzle/manual/$DDL not found in checkout — skipping copy."
            echo "any_exist=false" >> "\$GITHUB_OUTPUT"
          fi
      - name: Copy DDL via SCP (only files present)
        uses: appleboy/scp-action@v0.1.7
        with:
          source: '\${{ steps.ddl-check.outputs.source_list }}'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Review round 2, MED. The "apply" step only PRINTS a psql command line — it
# runs nothing. Merely containing the string `psql` used to qualify a step as an
# apply step.
read -r -d '' PSQL_ECHOED_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Print the manual apply instructions
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            echo "To apply by hand: psql -U \$PGUSER -d \$PGDB -f \$FIXTURE_FILE"
YML

# Review round 2, MED. A legitimately-wired file listed via a `|` block scalar —
# reading only the text on the `source:` line saw nothing and reported a FALSE
# RED, the failure mode that gets a guard switched off rather than fixed.
read -r -d '' BLOCK_SCALAR_SOURCE_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: |
            docker-compose.prod.yml
            apps/api/drizzle/manual/$DDL
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Review round 2 follow-up. Whole-line comment handling is NOT subsumed by the
# trailing-comment fix: a comment sitting at (or left of) the step marker's own
# indent would end the step early if comment lines were not skipped outright, so
# the real `source:` below it would never be seen — a FALSE RED on a genuinely
# wired file. deploy.yml is full of `# ── section ──` banners at exactly that
# indent, which is what makes this shape worth pinning rather than hypothetical.
read -r -d '' COMMENT_AT_STEP_INDENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
      # ── the guarded DDL block — see the runbook for the merge-order note ──
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Review round 3. The quote-tracking half of strip_trailing_comment was the last
# surviving mutant: deleting it left all 13 cases green, because every fixture
# happened to keep its `#` outside quotes, where the whitespace rule alone
# already saves it. Here the `#` is INSIDE a quoted psql argument and the
# server-side path comes AFTER it on the same line — so a comment-stripper that
# ignores quotes truncates the path away and reports a genuinely-wired file as
# never applied. A FALSE RED, which is the failure mode that gets a guard
# switched off rather than fixed.
read -r -d '' HASH_INSIDE_QUOTES_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -c "SET application_name = 'deploy #1'" -f /opt/crm/apps/api/drizzle/manual/$DDL
YML

read -r -d '' ABSENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'docker-compose.prod.yml'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Restart
        run: echo restart
YML

# The guarded/conditional copy pattern the real deploy.yml uses for DDL that has
# not merged yet: scp's `source:` is an expression, and the file list is built by
# an earlier step. Must be recognised as a real copy, or the guard would go red
# on legitimately-wired files (and get "fixed" by weakening it back to substring).
read -r -d '' EXPR_SOURCE_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Check for DDL file
        id: ddl-check
        run: |
          FILES="apps/api/drizzle/manual/$DDL"
          PRESENT=""
          for f in \$FILES; do
            if [ -f "\$f" ]; then PRESENT="\$f"; fi
          done
          echo "source_list=\$PRESENT" >> "\$GITHUB_OUTPUT"
      - name: Copy DDL via SCP (only files present)
        uses: appleboy/scp-action@v0.1.7
        with:
          source: '\${{ steps.ddl-check.outputs.source_list }}'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

read -r -d '' PRIVATE_UNREFERENCED_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Restart
        run: echo restart
YML

read -r -d '' PRIVATE_LEAKED_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual-private/$PRIVATE_DDL'
          target: '/opt/crm'
YML

echo "== test-check-prod-ddl-wiring.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "properly wired DDL (scp source: + psql apply step) passes" \
  --contains "Copied AND applied:      1" \
  --contains "OK: every manual DDL file" \
  -- run_guard "$(make_case wired "$WIRED_YML")"

assert_green "guarded copy via \${{ steps.X.outputs.source_list }} counts as copied" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case expr-source "$EXPR_SOURCE_YML")"

assert_green "a KNOWN_NOT_WIRED file stays green with no deploy.yml wiring at all" \
  --contains "OK: every manual DDL file" \
  -- run_guard "$(make_case allowlisted "$ABSENT_YML" "2026-07-15_settle_phantom_cleanup.sql")"

assert_green "source: | block scalar counts as a real copy (no false red)" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case block-scalar "$BLOCK_SCALAR_SOURCE_YML")"

assert_green "a comment banner at step indent does not truncate the step (no false red)" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case comment-at-step-indent "$COMMENT_AT_STEP_INDENT_YML")"

assert_green "a '#' inside a quoted psql argument is not a comment (no false red)" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case hash-inside-quotes "$HASH_INSIDE_QUOTES_YML")"

# ── negative — the case this whole task exists for ─────────────────────────────
assert_red "THE CHEAT: filename only in comments/step names -> red" \
  --contains "NEVER COPIED, NEVER APPLIED" \
  --contains "$DDL" \
  -- run_guard "$(make_case comment-only "$COMMENT_ONLY_YML")"

assert_red "copied to the VPS but never applied -> red" \
  --contains "COPIED BUT NEVER APPLIED" \
  -- run_guard "$(make_case copy-only "$COPY_ONLY_YML")"

assert_red "applied but never copied (apply step would 'file not found') -> red" \
  --contains "APPLIED BUT NEVER COPIED" \
  -- run_guard "$(make_case apply-only "$APPLY_ONLY_YML")"

assert_red "DDL absent from deploy.yml entirely -> red" \
  --contains "NEVER COPIED, NEVER APPLIED" \
  -- run_guard "$(make_case absent "$ABSENT_YML")"

# ── review round 2 ─────────────────────────────────────────────────────────────
assert_red "H1: filename only in TRAILING comments beside real code -> red" \
  --contains "NEVER COPIED, NEVER APPLIED" \
  --contains "$DDL" \
  -- run_guard "$(make_case trailing-comment "$TRAILING_COMMENT_YML")"

assert_red "copied, but the apply step names it only in deploy.yml's house-style comment -> red" \
  --contains "COPIED BUT NEVER APPLIED" \
  -- run_guard "$(make_case copy-plus-house-comment "$COPY_PLUS_HOUSE_COMMENT_YML")"

assert_red "a ::notice:: saying the file is ABSENT is not evidence it was copied -> red" \
  --contains "APPLIED BUT NEVER COPIED" \
  -- run_guard "$(make_case notice-only "$NOTICE_ONLY_YML")"

assert_red "a step that only ECHOES a psql command has applied nothing -> red" \
  --contains "COPIED BUT NEVER APPLIED" \
  -- run_guard "$(make_case psql-echoed-only "$PSQL_ECHOED_ONLY_YML")"


# ── manual-private reverse invariant ────────────────────────────────────────────
assert_green "manual-private/ file present but unreferenced anywhere -> green, inventoried" \
  --contains "Manual-private files:    1" \
  --contains "$PRIVATE_DDL" \
  --contains "OK: every manual DDL file" \
  -- run_guard "$(make_private_case private-unreferenced "$PRIVATE_UNREFERENCED_YML")"

assert_green "manual-private/ directory absent entirely -> silently skipped, still green" \
  --contains "Manual-private files:    0" \
  --not-contains "FAIL: the following apps/api/drizzle/manual-private" \
  -- run_guard "$(make_private_case private-dir-absent "$PRIVATE_UNREFERENCED_YML" absent)"

assert_red "manual-private/ file wired into deploy.yml's scp source: -> red" \
  --contains "Manual-private LEAKED:   1" \
  --contains "FAIL: the following apps/api/drizzle/manual-private" \
  --contains "$PRIVATE_DDL referenced in .github/workflows/deploy.yml" \
  -- run_guard "$(make_private_case private-leaked-deploy "$PRIVATE_LEAKED_YML")"

assert_red "manual-private/ file referenced in a DIFFERENT workflow file (not deploy.yml) -> red" \
  --contains "FAIL: the following apps/api/drizzle/manual-private" \
  --contains "referenced in .github/workflows/debug-dump.yml" \
  -- run_guard "$(make_private_other_workflow_case private-leaked-other-workflow)"

guard_test_summary "test-check-prod-ddl-wiring.sh"
