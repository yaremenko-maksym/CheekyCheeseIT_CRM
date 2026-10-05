# The "human only" registry and the conversion rule

**For:** any agent that hits a step it cannot perform. For the owner — as a list of
what is still required from them.
**Source:** `docs/architecture/2026-08-22-afk-pipeline-migration.md` item 18 (the inverted
`wizard` from `mattpocock/skills`).

---

## The conversion rule

The source's original trick is to generate an interactive bash wizard that walks a human through
the steps. It does not fit us literally: the owner is remote and often on a phone, and a terminal wizard
is useless there.

So the trick is inverted. You hit a "human only" step — **first try to kill it**:

1. **Automate it in the repository.** Idempotent and self-verifying, with a loud failure on a
   mismatch of expectations. The reference is prod DDL: agents have no SSH, so the SQL goes as a
   `deploy.yml` step, is applied idempotently, and after being applied the step is **removed** (de-wired), so it does
   not hang around dead. Steps forgotten in the removed state we later cleaned up with a separate PR — removal is
   part of the trick, not an optional continuation.
2. **If it cannot be automated** — reduce the human part to **one action line**,
   readable from a phone: what to open, what to click, what to send back. Not a screenful of instructions, but
   one line. Everything that can be prepared in advance (values, links, ready text to paste), the
   agent prepares itself.
3. **Record it here** — with a date, a reason, and what exactly is already automated.

**Observability:** the registry must **shrink**. An item that has stood for two months without a single
attempt at automation is debt, not the nature of things.

---

## The registry

### 1. Applying DDL in prod

**Why a human:** agents have no direct SSH to the VPS.
**Automated:** yes, fully. The SQL is placed in `apps/api/drizzle/manual/<date>_<what>.sql` and
wired in as a step in `.github/workflows/deploy.yml`; it is applied idempotently on deploy.
**Human remainder:** one decision — "we ship". After that — the merge, everything else by itself.
**Mandatory tail:** after it is applied, the step is removed from `deploy.yml` in a separate PR.

### 2. Cloudflare IP ranges in the Hetzner firewall

**Why a human:** agents have no access to the Hetzner Cloud API; the firewall rule is edited in the panel.
**Automated:** observation — `.github/workflows/cloudflare-ips-watch.yml` watches for a
change in the published list.
**Human remainder:** apply the changed list in the firewall rule.
**The cost of delay has grown:** after the perimeter was turned on (2026-08-17), a stale list **takes down
the site**, not just makes noise. This is A3 per `rules/common/autonomy-levels.md` — ask immediately.
**Where to move:** a Hetzner API token in the secrets + an apply step — then no human step
remains at all.

### 3. CI secrets and tokens

**Why a human:** entering credentials is forbidden for agents by policy, and this will never
be automated.
**Automated:** preparation — the agent names the exact secret name, its purpose, and where it is
obtained; verification — CI fails loudly if the secret is absent.
**Human remainder:** paste the value in the repository settings.
**Request format:** one line — "Settings → Secrets → New: `<NAME>`, the value is taken from `<where>`".

### 4. Switching the CSP from report-only to enforcing

**Why a human:** a live pass over the routes that nobody has opened is needed — telemetry for them
is empty, and "0 violations" means "nobody visited", not "the directives work".
**Automated:** collection of violations and the digest.
**Human remainder:** walk over the uncovered routes on report-only prod so that the data
appears.
**Where to move:** a synthetic Playwright pass over the list of routes instead of a human — then the item
closes entirely.

### 5. Merging a PR

**Why a human:** an intentional gate, not an automation gap. Not subject to conversion under any
conditions.
**Human remainder:** the word "we merge" in the chat. After that the label `merge-approved` and CI.

### 6. Generation in Claude Design (design-gate Tier 1)

**Why a human:** there is no headless API, the session is interactive.
**Automated:** a bridge via an artifact in the repository (`docs/design/<slug>.md` + `design.png`),
so the coder works without access to the design session.
**Human remainder:** the generation itself, when the orchestrator cannot drive it.
**Degradation:** a text spec from `ui-ux-designer` Mode A, marked in the PR body as
`design-gate: degraded` with a reason.

### 7. SPF and DMARC DNS records on the root domain

**Why a human:** the records live in DNS (Cloudflare), not in code; agents have no Cloudflare API
token. The spec says so directly (§12): "Both records live in DNS, not in code — the executor can prepare them,
only the owner can apply them".

**What was measured (2026-09-01, spec §12).** DKIM on the root is present. SPF is present on the sending
subdomain, but the sender address (`CONTACT_FROM_EMAIL` = `site@cheekycheese.tech`) lives on the **root**, where SPF
is **absent**. DMARC is absent entirely. The signature partially compensates for the mismatch, but
the alignment is fragile — and item 7a starts sending, with this sender, emails that a human
MUST see (a confirmation request, a signature request).

**Automated:** preparation — both records are ready to paste verbatim, below.

**Human remainder:** two lines in Cloudflare → DNS for the zone `cheekycheese.tech`.

```
Type: TXT   Name: @               Value: v=spf1 include:amazonses.com ~all
Type: TXT   Name: _dmarc          Value: v=DMARC1; p=none; rua=mailto:<address>; fo=1; adkim=r; aspf=r
```

**Step 0, mandatory before pasting — check the `include` against the Resend page.** Open in Resend
`Domains → cheekycheese.tech → DNS records` and take the `include:` mechanism FROM THERE, not from the line above.
This is not over-caution: `include:amazonses.com` expands into the SHARED outbound Amazon SES pool,
used by all its customers, meaning SPF for our domain will pass not only our sender
(SR-M-4). The value above is what Resend was publishing as of 2026-09-01; the provider changes the pool, and an SPF
pointing to the wrong place is worse than an absent one — it authoritatively allows strangers and forbids ours.
If it does not match — paste what is on the page, and fix the line in this file.

**An option for the owner (their decision, not the executor's).** Instead of extending the root, the
sender (`CONTACT_FROM_EMAIL`) can be moved to the sending subdomain — for example `noreply@send.cheekycheese.tech`
— and a narrow SPF kept there, leaving the root without SPF at all. Then a stranger SES customer could not pass
the check in the name of the root domain from which we write. The cost: editing a constant in `deploy.yml`,
a new DKIM record for the subdomain in Resend, and that emails will go from a different address (for some recipients
this will reset the sender's accumulated reputation). The decision is irreversible within the reputation — that is why
it is here, not in code.

**Why exactly this:**

- `include:` — the mechanism that Resend publishes for its outbound pool (see step 0).
- `~all` (softfail), not `-all`: a hard refusal on the root would reject mail from any other sender
  of this domain that we currently do not know about. Tighten it — after the DMARC reports show
  who else sends in our name.
- `p=none` — observation. The `quarantine`/`reject` policy is set **after** the reports
  confirm that legitimate mail passes; set immediately, it would silently drop what we have not yet
  aligned. **The deadline and condition for tightening are item 7.1 below**, and it has a date: without it "still
  observing" becomes forever (like the report-only CSP in #467).
- `adkim=r; aspf=r` — non-strict alignment: the sending subdomain and the root are treated as one family.
  It is exactly the "sender on the root, SPF on the subdomain" mismatch that makes strict mode dangerous here.
- `fo=1` — a report on EVERY failure of either of the two checks, not only on the failure of both.

**The owner's decision (A2 per `rules/common/autonomy-levels.md`):** the `rua=` address. The recommendation is
to set up a separate mailbox (for example `dmarc@cheekycheese.tech`) and not send the reports to the work email:
they arrive daily, as machine XML, and in a shared mailbox people stop opening them after a week. Until
the address is named, the record cannot be pasted — `rua` without an address is invalid, and DMARC without `rua`
reports nothing and exists for no reason.

**Verification after pasting (the agent can do it itself, needs no access):**

```bash
dig +short TXT cheekycheese.tech    | grep spf1
dig +short TXT _dmarc.cheekycheese.tech
```

**Where to move:** a Cloudflare API token in the secrets + a record-check step in CI — then only
the first paste remains, and the mismatch starts being caught by itself (the same trick as
`cloudflare-ips-watch.yml` in item 2).

---

### 7.1. Tighten DMARC to `p=quarantine` — with a deadline, not "someday"

**Why a separate item.** `p=none` rejects nothing: on this policy neither SPF nor DMARC
stops a spoof from our domain, only the DKIM signature protects. Observation is a temporary state
by definition, but it is exactly here that the temporary turns into the permanent: the report-only CSP
lived like that for months and was never switched off (#467). That is why the step has a date, not a condition "when there is time".

**Date.** `the date of pasting the record from item 7` + 30 days. Fill in the actual one at pasting:
`pasted ______ → tighten no later than ______`. Thirty days is not a round number: aggregated
reports arrive once a day, and a month is enough to see in them both rare senders (a mailing
once a week) and monthly ones (an invoice from a contractor).

**The condition checked before the change** (one, and it is measurable): in the reports for the last
14 days there is NOT a single source that (a) sends from our domain, (b) fails both SPF and DKIM,
and (c) is at the same time ours. If there is such a one — first align it, then tighten: `quarantine` moves its
mail to spam silently.

**What to change:** in the record `_dmarc.cheekycheese.tech` replace `p=none` with `p=quarantine`; `rua`,
`fo`, `adkim`, `aspf` — unchanged. The next step (`p=reject`) — by the same trick and no sooner than
30 days after `quarantine`, as a separate record in this file.

---

### 7.2. A test email to the owner after deploying item 7a

**Why a human:** a real email goes out only with the prod key `RESEND_API_KEY`, and it exists only on
prod (on dev the sender intentionally makes no attempts at all — rows accumulate as `QUEUED` with one
`warn` at boot). Only someone who has the personal mailbox can verify that the email actually reaches it.

**When:** right after the first deploy with the email queue (`notification_emails` + the sender), BEFORE
putting anything else on it.

**How (five minutes, breaks nothing):**

1. Make sure your account in the CRM has a personal address: profile → addresses, type "personal".
   None — add one (confirmation is NOT required: emails go to it even without confirmation).
2. Trigger any event that sends an email TO YOU personally. The cheapest and most reversible — ask
   the second admin to propose a default-share change to you (type `SHARE_CONFIRM_REQUIRED`, the email
   "Default-share change request"). Withdraw the proposal — **only after the email
   has arrived**: the sender wakes up once every 15 seconds, and a proposal withdrawn before its tick
   does not go out as an email at all (`SKIPPED`, `skip_reason = STALE` — see the table below). The email received
   — the proposal can be withdrawn, it no longer affects the verification.
3. After 15–30 seconds, check the personal mailbox, including "Spam" and "Promotions". The subject — the same as in
   the reference (`notification-email-copy.spec.ts`), the email has ONE button, and it leads to `/pending`.
4. Check the trace in the database: the row of this notification in `notification_emails` must be `SENT`
   with a non-empty `sent_at` and `sent_to_email` = the personal address.

```sql
-- read-only; personal data is not printed, except your own address
SELECT status, skip_reason, attempts, sent_at IS NOT NULL AS stamped, last_error
  FROM notification_emails
 ORDER BY created_at DESC
 LIMIT 5;
```

**How to read the result:**

| What is seen             | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENT`, email in mailbox | the channel works end to end — done                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SENT`, no email         | deliverability, not code: look at item 7 (SPF/DMARC) and "Spam"                                                                                                                                                                                                                                                                                                                                                                                                             |
| `QUEUED`, `attempts = 0` | the `RESEND_API_KEY` key did not reach the container — check `.env.production`                                                                                                                                                                                                                                                                                                                                                                                              |
| `FAILED`                 | the email will no longer go out, there will be no retries. `Resend API HTTP <code>` — a provider refusal, investigate by code (the address is not in `last_error`, intentionally); a single word like `TypeError` — the network or the provider is unreachable, repeat the check later; repeated with the same word — not the network, bring the text to a developer; a phrase starting with `decideDelivery:` — a failure in our code, bring the text to a developer as is |
| `SKIPPED`, `skip_reason` | there should not have been an email: `NO_ADDRESS` — step 1 was skipped, `CHANNEL_OFF` — the type is turned off in settings, `USER_ARCHIVED` — the account is archived, `STALE` — there is nothing left to respond to: the approval was withdrawn, recreated, or decided, the contract was signed                                                                                                                                                                            |

**Where to move:** nowhere. This is a "once after enabling the channel" check, and automating it would
mean sending real emails from CI.

---

## What is NOT written here

- Steps that the agent **can** do but was too lazy to. The registry is not a place for delegating upward.
- The owner's decisions — they go to the decision brief (`rules/common/autonomy-levels.md`), not here.
  Here only **actions** that require access the agent does not have.

## Related

- `.claude/rules/common/autonomy-levels.md` — the owner's decisions (not actions).
- `docs/runbooks/deployment.md` — how the deploy works.
- `docs/runbooks/origin-mtls-and-firewall.md` — the perimeter and the firewall.
