# Legal — Agent Notes

## Repo

Repo: `yaremenko-maksym/CheekyCheeseIT_CRM`
Main branch: `main`

## Typical durations

| Request type                                             | Expected time |
| -------------------------------------------------------- | ------------- |
| Mode A consult (question covered by the static base)     | 5-8 min       |
| Mode A consult (WebSearch needed)                        | 10-15 min     |
| Mode B pr-review (small PR, ≤ 3 files in critical zones) | 8-12 min      |
| Mode B pr-review (large PR, finance/auth + S3)           | 15-25 min     |
| Mode C brief-check                                       | 8-12 min      |
| Mode D strategic (deep question)                         | 10-20 min     |

## Knowledge base structure

```
.claude/knowledge/legal/
  README.md                               # master index, update rules
  ua-fop/                                 # FOP regimes, single tax, currency operations
    (Phase 1 seeding pending)
  crypto-usdt/                            # UA law on virtual assets, USDT, AML
    (Phase 1 seeding pending)
  gdpr/                                   # personal data, processor/controller, breach
    (Phase 1 seeding pending)
  it-contracts/                           # NDA, services agreement, IP rights
    (Phase 1 seeding pending)
  cross-cutting/
    escalation-zones.md                   # ✓ Phase 0 — when mandatory to a human
    citation-rules.md                     # ✓ Phase 0 — citation format
```

**Phase 0 (current):** only cross-cutting/ + README. Topic folders empty. WebSearch — primary source.

**Phase 1 (future):** User will fill topic folders as questions accumulate.

## Write zones

| Allowed                                                    | Forbidden                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.claude/tasks/task-legal-*.md` (append `## Lawyer answer`) | `.claude/knowledge/legal/**` (knowledge base — User/Master maintenance) |
| `.claude/knowledge/legal-consultations/*.md`               | `apps/**`, `packages/**`, `scripts/**`, `.github/**`                    |
| `.claude/briefs/brief-legal-check.md`                      | `.claude/agents/**`                                                     |
| `/tmp/legal-output/pr-*.md`                                | `docs/business/**`                                                      |
| PR review (via MCP, event=COMMENT only)                    | Any labels except `legal-noted`                                         |

## Master report on the result

The Master who launched Legal records the result in the task file / notes (there is no separate
event stream — `pm-state.json` was removed together with the PM agent 2026-10-05):

| Result                     | What to record                | When                                                                            |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `legal_dispatched`         | mode, target                  | Master launched Legal. `target` = task-file / pr-number / brief / consultation |
| `legal_review_posted`      | pr, confidence (HIGH/MED/LOW) | Mode B: review posted on the PR                                                 |
| `legal_pre_feature_done`   | brief, recommendations_count  | Mode C: Legal returned recommendations                                          |
| `legal_escalated_to_human` | reason                        | Mode B/A: Confidence: LOW + hard zone → User informed to escalate               |

## Label workflow

- **`legal-noted`** (info-blue, does not block merge) — Legal review posted on a PR in Mode B. A visible signal that the legal angle is checked.
- No `legal-blocked` / `legal-approved` — Legal is not a gate.

## MCP/Bash specifics

### Write-then-post pattern for Mode B

```bash
mkdir -p /tmp/legal-output
REVIEW_FILE="/tmp/legal-output/pr-${PR}-$(date -u +%Y%m%dT%H%M%S).md"
cat > "$REVIEW_FILE" <<'EOF'
# Legal Review for PR #<N>

Legal Review: <CONFIDENCE>

<full body per the "Output format" structure in legal.md>
EOF
echo "Body saved: $REVIEW_FILE"
```

Then `mcp__github__create_pull_request_review` with the same body. If MCP hangs → the body survives.

### Post via gh CLI fallback

If MCP does not respond for > 60 sec:

```bash
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/reviews \
  --method POST \
  --field event=COMMENT \
  --field body="$(cat $REVIEW_FILE | tail -n +4)"  # skip header lines
```

### WebSearch sources

Prefer in this order:

1. `zakon.rada.gov.ua` — UA legislation (primary)
2. `gdpr-info.eu` or `eur-lex.europa.eu` — GDPR / EU
3. Official DPS clarifications (`tax.gov.ua`)
4. Reputable legal blogs / VRU bills — secondary, mark as "commentary"

Do not cite: random forums, Wikipedia as a primary source (only background), AI-generated articles.

## Lessons (format)

`.claude/agents/memory/legal/lessons.md` — the format is the same as for other agents:

```
YYYY-MM-DD [P0|P1|P2] [<task-id>] #topic-tag <a concrete lesson>
```

Topic-tags for Legal:

- `#ua-fop`, `#gdpr`, `#usdt`, `#it-contract`, `#aml`, `#tax`, `#personal-data`
- `#citation` (when the source was missed)
- `#confidence` (when Confidence did not match reality)
- `#escalation` (when escalation was right/wrong)

## Recovery after a hang

Since Legal appends to files by sections — even if it breaks off midway, the sections before the break are already on disk. Master on recovery:

```bash
# Mode A — check the task file
ls -la .claude/tasks/task-legal-<slug>.md
grep -c "^### " .claude/tasks/task-legal-<slug>.md  # how many sections it managed

# Mode B — check /tmp/legal-output/
ls -la /tmp/legal-output/pr-<N>-*.md
# if the file exists → review body ready, only post remains → restart Legal with an explicit "post existing body only"
```
