# Runbook: close the origin for real — firewall + Authenticated Origin Pulls

**For:** the owner (the steps require the Cloudflare panel, the Hetzner console, and host access —
the assistant has none of these).
**Why:** the source filter (`nginx/snippets/origin-gate.conf`) in its own header
honestly states that it is **not** access control: it checks whether the request came from the
public Cloudflare ranges, not from **our** zone. It is passed by Cloudflare WARP users,
Cloudflare Workers, and the traffic of any other Cloudflare customer —
in any mode, including the blocking one.

**What these two steps actually close:**

| Threat                                                                      | Firewall | AOP (zone) | AOP (per host) |
| --------------------------------------------------------------------------- | -------- | ---------- | -------------- |
| Scanners and bots hit the server IP directly, bypassing Cloudflare          | ✅ yes   | ✅ yes     | ✅ yes         |
| Bypassing Cloudflare's WAF and rate limiters by hitting the origin directly | ✅ yes   | ✅ yes     | ✅ yes         |
| Spoofing `CF-Connecting-IP` **by another Cloudflare customer**              | ❌ no    | ❌ no      | ✅ yes         |

The third row is the one that concerns the data: this header feeds the IP on the contract signature
and the terms-of-service consent (we store it as legal evidence) and the key
of the request rate limiter.

**Order matters.** Step 1 (firewall) gives the most and cannot take down visitors.
Step 2 (mTLS) in the wrong order takes down the whole site — that is why there is
an observation phase there.

---

## Step 1 — Hetzner Cloud firewall (network, not host)

### Why not `ufw`

Docker publishes 80/443 with its own rules in the `nat`/`DOCKER` chains, which
run **before** the `INPUT` chain. So `ufw deny 443` on such a host
blocks nothing — the port stays open, while `ufw status` in the panel
says "deny". This is a classic trap, and we have exactly this configuration
(`docker-compose.prod.yml`: `ports: - '80:80'`, `- '443:443'`).

The Hetzner Cloud firewall filters **before** the packet reaches the machine, so Docker's
rules cannot bypass it.

### What to do

1. Take the current Cloudflare ranges — **from the first source**, not from our file:
   - https://www.cloudflare.com/ips-v4
   - https://www.cloudflare.com/ips-v6

   There are about 15 (IPv4) and 7 (IPv6) of them.

2. Hetzner Cloud console → **Firewalls** → **Create Firewall**.

3. Inbound rules — exactly three:

   | Protocol | Port | Source                      |
   | -------- | ---- | --------------------------- |
   | TCP      | 80   | all Cloudflare ranges v4+v6 |
   | TCP      | 443  | all Cloudflare ranges v4+v6 |
   | TCP      | 22   | **Any IPv4 + Any IPv6**     |

   **Keep port 22 open.** The deploy reaches the VPS over SSH from GitHub Actions
   (`.github/workflows/deploy.yml`, `appleboy/ssh-action`), and the runner addresses
   are dynamic. Restricting 22 will break the deploy. The protection there is the keys, not the address.

   Do not set outbound rules (Hetzner allows everything with an empty outbound list;
   if you set them — pulling images from GHCR and calls to NBU/Etherscan will break).

4. Apply the firewall to the server (Apply to → select the VPS).

5. **Verify with a pair of commands** — both are mandatory, one without the other proves nothing:

   ```bash
   # through Cloudflare — should work
   curl -sS -o /dev/null -w '%{http_code}\n' https://cheekycheese.tech/

   # directly by the server IP, bypassing Cloudflare — should HANG and fail on timeout
   curl -sS --max-time 10 --resolve cheekycheese.tech:443:<SERVER_IP> \
        -o /dev/null -w '%{http_code}\n' https://cheekycheese.tech/
   ```

   The first gives `200`. The second — `curl: (28) Connection timed out`. If the second
   returned a response code, the firewall was not applied.

6. Run the deploy once (any merge into `main` or `workflow_dispatch` for
   `deploy.yml`) and make sure it is green. This is the check that SSH is not affected.

### The cost of this step, which you need to know in advance

After turning on the firewall, **a staleness of the Cloudflare ranges starts taking down the site**,
not just making noise in the logs: if Cloudflare adds a range and it is not in the firewall,
some visitors will get a timeout. Before, such staleness was harmless.

Therefore: on every change of the Cloudflare list, the Hetzner rule is updated together
with `nginx/cloudflare-ips.txt`. A freshness check already exists —
`scripts/devops/check-cloudflare-ips-freshness.sh`. After this step it stops
being optional.

**Beyond that, this check did not remain "remember and run by hand".**
`.github/workflows/cloudflare-ips-watch.yml` runs it twice a day and on a
mismatch opens, by itself:

- a **PR** updating `nginx/cloudflare-ips.txt` — it edits only nginx
  (`set_real_ip_from` and origin-gate), auto-merge is not set on it, a
  human reviews it.
- an **Issue** assigned to the owner (the email arrives through the standard GitHub
  channel "assigned", without SMTP secrets) — with ready range lists to paste
  and steps for the Hetzner console (Firewalls → rules on 80 and 443 → add/
  remove, **both** ports, do not skip IPv6).

If a range was **added** — the issue title is marked as urgent (visitors
from this range are already timing out); if one only **disappeared** — as cleanup
(a redundant allowance, grants no access). If the source itself (`cloudflare.com/
ips-v4|v6`) is unreachable, the workflow fails loudly (a red run), rather than staying silent.
The details of the contract are in the header comment of `scripts/devops/
cloudflare-ips-watch.sh`.

**A red run without an issue/PR is not always "the guard is broken" (a trade-off you need to
remember in advance, security review PR #557, 2026-08-18).** The freshness
check refuses to trust "a range disappeared" without a tolerance: the live count by
family (v4/v6) cannot be LOWER than what `nginx/cloudflare-ips.txt` already
trusts — not by a percent, not "just in case", but without any
tolerance at all. The reason: a response truncated by one line (the network blinked,
a proxy returned an incomplete body) and a **real** revocation by Cloudflare of one
range give the SAME picture — the list is shorter by one valid CIDR,
and by content these two cases are indistinguishable. The trade-off was chosen deliberately:
an extra red run is cheaper (one email from GitHub about a failed scheduled
workflow) than advising to remove from the firewall a range that Cloudflare still
uses — and the flip side of exactly this trade-off is that
a **real** range revocation now ALSO looks like "the guard is broken":
the issue and PR are not opened, because the automation does not trust itself in this
situation.

What this means on the day Cloudflare actually removes a range:
there will be no PR/issue — there will only be a red scheduled run
(`::error::` in the log, an email from GitHub "your scheduled workflow failed").
**Do not read this as "the automation broke" and do not fix the workflow blindly.**
First check `nginx/cloudflare-ips.txt` BY EYE against
https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6:

- if every range from the file is still in both Cloudflare lists —
  the source really was unreachable or returned garbage, this is a real
  breakage, deal with the fetch;
- if some range from the file is no longer in the Cloudflare lists — this is a
  real (rare) cleanup: update `nginx/cloudflare-ips.txt` by hand and
  open a PR yourself. The automation in this case works as intended, not
  broken — its silence about the PR/issue here is its deliberate behavior,
  not a bug.

---

## Step 2 — Authenticated Origin Pulls (mTLS)

Cloudflare presents a client certificate to our nginx, nginx verifies it.
A direct connection without this certificate is rejected at the TLS level.

### 2a. Zone AOP (fast, closes direct access)

**The order is strictly this — the reverse takes down the site.**

1. Place Cloudflare's published CA on the host, next to our certificates
   (the directory is already mounted into the container as `/etc/nginx/certs`, a rebuild of the image
   is not needed):

   ```bash
   sudo curl -fsS -o /etc/nginx/certs/cloudflare-origin-pull-ca.pem \
     https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem
   sudo openssl x509 -in /etc/nginx/certs/cloudflare-origin-pull-ca.pem -noout -subject -dates
   ```

   The second command is mandatory: it proves that a certificate was downloaded, not an
   HTML error page. Expect to see a subject with `CloudFlare` and a validity period.

2. Cloudflare panel → zone `cheekycheese.tech` → **SSL/TLS** → **Origin Server** →
   turn on **Authenticated Origin Pulls** (the zone toggle).
   **At this step nothing changes for us** — nginx does not verify the certificate yet,
   and the site cannot be taken down by this. The same for the zone `app.cheekycheese.tech`, if it is
   a separate zone, not a record inside the same one.

3. Tell me — I make a PR adding to the `listen 443 ssl` blocks (`crm.conf`,
   `landing.conf`, `default-server.conf`):

   ```nginx
   ssl_client_certificate /etc/nginx/certs/cloudflare-origin-pull-ca.pem;
   ssl_verify_client optional;     # OBSERVATION: absence/valid certificate — does not reject
   ```

   plus `$ssl_client_verify` in the log format. This is exactly the same observation-phase trick
   that we already apply to the source filter and to the CSP.

   **Precision of the wording "does not reject" (done in PR #555, security review):**
   `optional` does not reject exactly TWO cases, which are the ones that matter in practice —
   absence of a certificate (`NONE`) and a valid certificate (`SUCCESS`), both get
   a normal response (verified by live runs). A certificate that is presented but NOT verifiable —
   is the exception: nginx answers with an automatic `400` before the request reaches
   any `location` — this is nginx's own behavior for
   `ssl_verify_client optional`, not a config bug. Behind the firewall (step 1) and the zone AOP
   this case is not expected on real traffic (the edge always presents its
   valid certificate) — for the full analysis and live runs, see the comment above
   `log_format main` in `nginx/nginx.conf`.

4. For a day we read the log: **all** real traffic should have `SUCCESS`.
   Not a single `NONE`/`FAILED` from live visitors.

   **The command (added in PR #555, security review AOP-5 — verified on a live
   container, not made up).** The naive `docker compose logs | grep client_verify=
| ... | sort | uniq -c` counts correctly, but misleads in three
   ways: it does not show WHAT exactly was `NONE` (the main question when
   deciding on the flip); `docker compose logs` sees only the CURRENT container, that
   is, any deploy silently zeroes the observation window; json-file rotation
   (`max-size: 10m` × `max-file: 5`, `docker-compose.prod.yml`) can truncate
   a day without warning. The command below honestly checks coverage BEFORE
   it prints the distribution, and prints example `NONE` lines, not just the
   counter:

   ```bash
   cd /opt/crm
   docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml \
     logs --since 24h --timestamps --no-log-prefix nginx > /tmp/nginx-24h.log 2>&1

   CONTAINER_ID=$(docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml \
     --env-file .env.production ps -q nginx)
   STARTED_AT=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER_ID")
   FIRST_LINE_TS=$(grep -a 'client_verify=' /tmp/nginx-24h.log | head -n1 | awk '{print $1}')

   echo "nginx container started at: $STARTED_AT"
   echo "earliest client_verify= log line retrieved: ${FIRST_LINE_TS:-<none>}"

   STARTED_EPOCH=$(date -u -d "$STARTED_AT" +%s)
   NOW_EPOCH=$(date -u +%s)
   CONTAINER_AGE_HOURS=$(( (NOW_EPOCH - STARTED_EPOCH) / 3600 ))

   if [ -z "$FIRST_LINE_TS" ]; then
     echo "WARNING: no client_verify= lines at all in the requested window."
   elif [ "$CONTAINER_AGE_HOURS" -lt 24 ]; then
     echo "WARNING: nginx container is only ~${CONTAINER_AGE_HOURS}h old (redeployed since) — observation window is AT MOST ${CONTAINER_AGE_HOURS}h, not the requested 24h. A container swap resets what 'docker compose logs' can see."
   else
     FIRST_EPOCH=$(date -u -d "$FIRST_LINE_TS" +%s)
     COVERAGE_HOURS=$(( (NOW_EPOCH - FIRST_EPOCH) / 3600 ))
     if [ "$COVERAGE_HOURS" -lt 23 ]; then
       echo "WARNING: container up >=24h, but earliest available line is only ~${COVERAGE_HOURS}h old — json-file rotation (max-size=10m x5) likely truncated older entries. Treat as PARTIAL window."
     else
       echo "Coverage OK: ~${COVERAGE_HOURS}h of log available."
     fi
   fi

   echo ""
   echo "--- client_verify= distribution ---"
   grep -a 'client_verify=' /tmp/nginx-24h.log \
     | sed -n 's/.*client_verify=\(.*\)$/\1/p' | cut -d: -f1 | sort | uniq -c | sort -rn

   echo ""
   echo "--- sample NONE lines (up to 5) — inspect these to see WHAT presented no cert ---"
   if MATCHES=$(grep -a 'client_verify=NONE' /tmp/nginx-24h.log); then
     echo "$MATCHES" | head -5
   else
     echo "(none)"
   fi

   echo ""
   echo "--- sample FAILED lines (up to 5, if any) — anomalous, see the caveat above ---"
   if MATCHES=$(grep -a 'client_verify=FAILED' /tmp/nginx-24h.log); then
     echo "$MATCHES" | head -5
   else
     echo "(none)"
   fi
   ```

   (LOW-1, security review round 2, PR #555: `grep ... | head -5 || echo
"(none)"` looks like it prints a fallback on zero matches, but does not —
   `$?` after a pipe is `head`'s exit code, and `head` exits `0` even after
   reading nothing from an empty/exhausted pipe. Verified: the old form
   silently prints NOTHING on zero matches, not `(none)` — the `if
MATCHES=$(...)` form above branches on `grep`'s own exit code, which IS
   `1` on zero matches, and was verified against both an empty-match and a
   matching case.)

   GNU `date`/coreutils (matches the VPS's Ubuntu host — this is NOT meant to
   run on macOS/BSD). `--no-log-prefix` matters: without it, `docker compose
logs` prepends `nginx-1  | ` to every line, which shifts `awk '{print $1}'`
   onto the wrong field — found by actually running the command, not by
   reading `docker compose logs --help`. A clean `Coverage OK: ~24h of log
available` plus zero `FAILED`/`NONE` samples from real visitor traffic
   (health-checks and internal probes are expected `-`/occasional `NONE` and
   are not "real traffic") is the precondition for step 5 below.

5. On a clean window I make a one-line PR `optional` → `on`. From this moment,
   a direct connection without a Cloudflare certificate gets `400` at the TLS level.

   **What this flip does NOT give (see §2b below for the full analysis):** the zone AOP
   uses a shared Cloudflare certificate — the same one for all Cloudflare
   customers, not bound to our zone. `on` proves "came from the Cloudflare
   network", not "from the edge actually serving `cheekycheese.tech`" —
   spoofing `CF-Connecting-IP` by ANOTHER Cloudflare customer is not
   closed by this step. Only §2b closes it (our own certificate, bound to the
   host).

### Rollback — two independent modes (the cures are different)

Added in PR #555 (security review, AOP-4) — before that the runbook did not describe rollback
at all. The symptom decides which mode:

**Mode A — traffic gets `400`.** The client presents a certificate that does not
verify against `cloudflare-origin-pull-ca.pem` (see the analysis in step 3 above
and in `nginx/nginx.conf`'s comment above `log_format main`) — this is the built-in
behavior of `ssl_verify_client optional`, not a failure of nginx startup: nginx itself is alive and
serves everything else correctly. **The cure — turn off Global Authenticated
Origin Pulls in the Cloudflare panel** (`SSL/TLS` → `Origin Server`): the edge stops
presenting a certificate at all, `optional` resolves the request to `NONE`, the response —
a normal `200`. Neither a redeploy nor a rollback of the PR is needed — purely a zone
toggle on the Cloudflare side, the effect is instant.

**Mode B — nginx did not start.** The reason: the file `cloudflare-origin-pull-ca.pem`
is absent or corrupted ON THE HOST — `ssl_client_certificate` cannot
read it, nginx fails while loading the config, the container does not come up at all
(this is already a different class of failure than Mode A — it does not reach the TLS handshake).
The Cloudflare panel will not help here at all — the problem is on our side. Two paths:

1. **Repair the file on the host** — reapply step 1 above (`sudo curl ... -o
/etc/nginx/certs/cloudflare-origin-pull-ca.pem` + the verifying `openssl x509
... -subject -dates`), then `docker compose -f docker-compose.prod.yml -f
docker-compose.ghcr.yml --env-file .env.production up -d nginx` on the VPS.
   Faster, but requires the owner's manual login to the host.
2. **`workflow_dispatch` `deploy.yml` with the previous working `image_tag`** —
   rebuilds and redeploys the known-working image entirely. The assistant
   has no interactive SSH to the VPS (`appleboy/ssh-action` works only inside
   the workflow run itself), so in practice this is the only path
   available without the owner's manual login to the VPS.

With PR #555 `deploy.yml` also got a preflight step (right before the container swap,
Step 3): a new deploy fails BEFORE tearing down the current working container, if
`cloudflare-origin-pull-ca.pem` is absent on the host — this catches Mode B EARLIER
for future deploys, but does NOT protect against a file removed/corrupted on the host
AFTER the last successful deploy (the already-running container will keep failing on
restart) — that case is still Mode B above, repairing the file is mandatory.

### 2b. Per-host AOP, with our own certificate (fully closes the third row of the table)

The zone AOP uses a **shared** Cloudflare certificate — the same for all Cloudflare
customers. It proves "came from a Cloudflare edge", but not "from the edge serving
our zone". To close spoofing of `CF-Connecting-IP` by another Cloudflare customer,
you need **our own** client certificate, uploaded to Cloudflare and bound to the host;
nginx verifies it against our own CA.

This is done only through the Cloudflare API (there is no such toggle in the panel) and requires
a token with rights to the zone. **Do not paste the token anywhere in the correspondence** — you run the
commands yourself, on your own machine.

If you decide to go all the way — tell me, I will prepare the exact sequence: generating
the pair, uploading the certificate to the zone, binding it to the two hosts, replacing the CA in nginx, and the same
observation phase. This is a separate half-day task, and it makes sense to do it **after**
steps 1 and 2a have worked.

---

## What this changes in the backlog

- Items **A/B/C** remain as agreed: I fix the findings, I do not switch the filter mode.
  After step 1 the value of the switch itself drops almost to zero — the firewall cuts off
  the same traffic earlier and more reliably. The filter remains a second line of defense.
- A new operational requirement appears: the freshness of the Cloudflare ranges becomes
  capable of taking down prod (see the cost of step 1).
- The statement "the origin is closed" will become true only after step 2a. Before it, writing so
  in the documentation is not allowed — right now the header of `origin-gate.conf` says so honestly,
  and this honesty must be preserved.
