# Flow Gate — one drift measurement, built from the two `compare` reads the workflow makes for a
# reviewed commit V:
#
#   $drift   compare V...HEAD     what moved since the verdict was given
#   $owned   compare BASE...V     the PR's own changed-file set as of V
#
# Lives in its own file, not inline in `.github/workflows/flow-gate.yml`, so the unit suite can
# feed it fixtures: `flow-gate.test.mjs`, section "the compare filter". It previously existed only
# as YAML, where two security properties had no test and would have regressed silently.
#
# PROPERTY 1 — a rename is judged by BOTH names. `previous_filename` is in `paths` on purpose:
# without it, approving `apps/api/src/finance/x.ts` and then renaming it to `docs/x.md` would show
# the gate only the new name, and the docs exemption would carry the verdict over a change to a
# critical-path file. Pinned by the "a rename is judged by both names" case.
#
# PROPERTY 2 — a response that SUCCEEDED but carried no file list is `unavailable`, never an empty
# measurement. `exit 0` without the artifact is still nothing measured, and an empty drift reads to
# the gate as "nothing moved since the verdict" — a positive claim from a read that never happened
# (SR-M-1 / CR-M-5). `.files` must be present AND an array; a 404 or a rate-limit is already
# handled by the workflow, which never calls this filter in those cases.
#
# The `>= 300` cap below must equal `MAX_COMPARE_FILES` in `flow-gate.mjs`, which re-checks it on
# the arrays themselves; a test asserts the two numbers agree.

def measured: (type == "object") and ((.files | type) == "array");
def paths: [.files[]? | .filename] + [.files[]? | .previous_filename // empty];

if ($drift[0] | measured) and ($owned[0] | measured)
then
  {
    base: $base,
    # `compare` returns at most 300 files and reports no total of its own, so a list AT the cap is
    # treated as truncated rather than as a complete answer.
    truncated: ((($drift[0].files | length) >= 300) or (($owned[0].files | length) >= 300)),
    paths: ($drift[0] | paths),
    ownedAt: ($owned[0] | paths),
  }
else
  { base: $base, unavailable: true }
end
