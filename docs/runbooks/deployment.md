# Deployment Runbook — CheekyCheeseIT CRM

> **Status:** the first deploy was done on 2026-06-27. Auto-deploy was enabled on 2026-07-12.
> Sections that require verification on a live server are marked `[UNTESTED]`.

## Architecture overview

```
User → Cloudflare (DNS/TLS/CDN/DDoS) → Hetzner VPS (CX33)
                                                       │
                                          nginx (80/443)
                                          ├── cheekycheese.tech → Landing SPA
                                          └── app.cheekycheese.tech → CRM SPA
                                                       │
                                                 api (NestJS :3001, internal)
                                                 ├── postgres:5432 (internal)
                                                 └── redis:6379   (internal)

Documents: Cloudflare R2
```

| Service    | Image                                                     | Reachable from outside       |
| ---------- | --------------------------------------------------------- | ---------------------------- |
| `postgres` | postgres:16-alpine                                        | no (only inside Docker)      |
| `redis`    | redis:7-alpine                                            | no (only inside Docker)      |
| `api`      | `ghcr.io/yaremenko-maksym/cheekycheeseit-crm-api:<tag>`   | no (only through nginx /api) |
| `nginx`    | `ghcr.io/yaremenko-maksym/cheekycheeseit-crm-nginx:<tag>` | 80, 443                      |

Cookie auth works same-origin: `app.cheekycheese.tech/api/...` → nginx `/api/` → api:3001.

---

## 1. Owner's provisioning checklist

> **The repo owner does this by hand, once. The assistant has no access to
> these systems and cannot do it for you.**

### 1.1 Hetzner VPS

1. Create a server: **CX33** (4 vCPU, 8 GB RAM), location **Nuremberg or Helsinki** (EU).
2. OS: **Ubuntu 24.04.3 LTS** (kernel 6.8, x86_64; the fact was taken from the prod host `ubuntu-8gb-hel1-5`
   on 2026-09-03 — when creating a new server, check against the current Ubuntu LTS release at the time of
   creation, not against this line).
3. Add an SSH key at creation — this will be the deploy key (see §1.4).
4. Remember the assigned VPS IP address — it will be needed for the DNS A records (§1.2).

### 1.2 Cloudflare — add the domain and configure DNS

> **CRITICAL: before changing the NS servers, make sure all existing DNS records
> are migrated to Cloudflare (especially MX, SPF, DKIM — the @cheekycheese.tech mail is live!).**

**Steps:**

1. In Cloudflare → "Add a Site" → enter `cheekycheese.tech`.
2. Cloudflare will show a list of existing DNS records, imported automatically.
   **Check for all MX, SPF (TXT `v=spf1 ...`), DKIM (TXT `_domainkey.*`), DMARC.**
   If some records are missing — add them by hand before changing the NS.
3. Change the NS servers at the domain registrar to those Cloudflare shows.
4. Wait for the green status ("Active") in Cloudflare — usually 5-30 minutes.
5. Add/update the A records:

   | Record                  | Type | Value      | Proxied |
   | ----------------------- | ---- | ---------- | ------- |
   | `cheekycheese.tech`     | A    | `<VPS IP>` | yes ✓   |
   | `www.cheekycheese.tech` | A    | `<VPS IP>` | yes ✓   |
   | `app.cheekycheese.tech` | A    | `<VPS IP>` | yes ✓   |

6. Configure TLS: SSL/TLS → mode **Full (strict)**.
   - "Full (strict)" requires a valid certificate on the origin (VPS).
   - Option A (recommended): issue a **Cloudflare Origin Certificate** (15 years):
     SSL/TLS → Origin Server → Create Certificate → enter `cheekycheese.tech,*.cheekycheese.tech`.
     Download the `.pem` and `.key`. Place them on the VPS (see §4).
   - Option B: Let's Encrypt on nginx (certbot standalone) — nginx must be stopped
     while issuing. Less convenient (renewal every 90 days).

### 1.3 Google OAuth — update the redirect URI

In **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs**:

- Authorized JavaScript origins: `https://app.cheekycheese.tech`
- Authorized redirect URIs: `https://app.cheekycheese.tech/api/auth/google/callback`

Remove old localhost / tunnel records (if any).

### 1.4 SSH deploy key — create it and add it to GitHub Secrets

```bash
# Generate the key (no passphrase — CI cannot enter a password):
ssh-keygen -t ed25519 -f ~/.ssh/crm_deploy_key -C "crm-deploy@github-actions" -N ""

# Print the public key — add it on the VPS to ~/.ssh/authorized_keys:
cat ~/.ssh/crm_deploy_key.pub

# Print the private key — add it to the GitHub Secret VPS_SSH_KEY:
cat ~/.ssh/crm_deploy_key
```

On the VPS:

```bash
echo "<public key>" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 1.5 Cloudflare R2 — create a bucket for documents and a bucket for backups

1. Cloudflare → R2 Object Storage → Create Bucket:
   - `crm-documents-prod` — for user-uploaded documents
   - `crm-backups` — for nightly PG dumps (§8)
2. Create **TWO SEPARATE** R2 API Tokens — one per bucket, **not one shared**
   (`task-infra-prod-backup-safety-net`, round 2, 2026-08-03 — before this there was one
   token for both buckets; split deliberately, see the box below):
   - **Documents token** — scope: Object Read & Write, bucket `crm-documents-prod`
     ONLY. Goes into GitHub Secrets `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
     (§3) → `.env.production` on the VPS → read by `apps/api`.
   - **Backups token** — scope: Object Read & Write, bucket `crm-backups` ONLY
     (the same token both writes via `pg-backup.sh` and deletes by the retention
     period — no separate read-only token is set up, see §8). Goes **ONLY**
     into `/etc/crm-backup.env` on the VPS (§8) — **never** into GitHub Secrets.
   - For each token remember: Access Key ID, Secret Access Key.
3. The R2 endpoint looks like this: `https://<account-id>.r2.cloudflarestorage.com`
   (the same endpoint for both tokens — the endpoint is not tied to the scope).
4. **The CORS policy of the bucket `crm-documents-prod` is mandatory, added 2026-08-05.**
   R2 → bucket → Settings → CORS Policy:

   ```json
   [
     {
       "AllowedOrigins": ["https://app.cheekycheese.tech"],
       "AllowedMethods": ["GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   The bucket `crm-backups` needs no policy — the browser does not access it.

> **Why this is not cosmetic and why the failure is silent.** Since 2026-08-05
> (`task-scan-cache-leak`, PR #479) `document-image.tsx` requests images in
> CORS mode (`crossOrigin="anonymous"`). This was done not for convenience: without it
> the storage response is **opaque**, `Cache-Control` cannot be read from it, and
> the `cacheWillUpdate` check in the service worker let **everything** into the cache —
> document scans and resumes sat on devices for 30 days despite an honest
> `private, no-store` from `s3.service.ts`. A readable response is the only way
> to tell an avatar (`public, immutable`, we cache) from a passport scan (`no-store`,
> we do not cache).
>
> The cost: **if the policy is removed or narrowed, images stop loading at all** —
> all 17 places in the CRM where this component is used (avatars, project logos,
> document previews). The failure is visually silent: `onError` hides the element
> (`display:none`), in the console — an ordinary CORS error, no message to
> the user. That is, "there are no images" will look like "there never were images".
>
> Check the policy without going into the panel (the endpoint is taken from the file already on the VPS;
> only the access headers appear in the output, the keys — no):
>
> ```bash
> ( set -a; . /etc/crm-backup.env; set +a
>   curl -sI -X OPTIONS "$S3_ENDPOINT/crm-documents-prod/" \
>     -H 'Origin: https://app.cheekycheese.tech' \
>     -H 'Access-Control-Request-Method: GET' ) | grep -i '^access-control'
> ```
>
> Expected `Access-Control-Allow-Origin: https://app.cheekycheese.tech` and
> `Access-Control-Allow-Methods: GET`. Empty — the policy was not applied.
> Additionally, `Access-Control-Expose-Headers` is **not needed**: `Cache-Control`
> is in the list of headers readable under CORS by default.

> **Why two tokens, not one for both buckets.** A single account-wide token
> meant: compromising the `api` container (the only place where the
> GitHub-secret creds live) = reading and deleting 30 days of PG dumps. After the split, a
> secret that reaches GitHub Actions/`.env.production`/the `api` container
> physically cannot touch `crm-backups` — the token with access to backups does not exist anywhere
> except `/etc/crm-backup.env` on the VPS itself. This same property is the
> reason the automatic backup-freshness check (§8.1) goes over
> SSH right from the server, not from GitHub Actions: the runner simply has no, and must not
> have, creds for `crm-backups`.

> **The correct S3-env values for Cloudflare R2 (our prod provider):**
> The validator (`apps/api/src/config/env.ts`) expects `S3_ENDPOINT` to be a valid URL
> (`.string().url()`) — the R2 endpoint `https://<account-id>.r2.cloudflarestorage.com`
> satisfies it. For R2:
>
> - `S3_USE_SSE=false` — R2 **does not support** the SSE-S3 header (`ServerSideEncryption: AES256`)
>   and rejects PutObject if it is present. R2 encrypts data at-rest itself (AES-256), so
>   the absence of the header is correct and safe. In `deploy.yml` this value is **hardcoded `false`**
>   (not a secret). Set `true` only when migrating to AWS S3.
> - `S3_FORCE_PATH_STYLE=false` — R2 (like AWS S3) uses virtual-hosted-style URLs
>   (`bucket.host/key`). `true` — **only** for the local dev/CI S3 stand (path-style `host/bucket/key`).
> - `S3_REGION=auto` for R2 (`eu-central-1` is for AWS S3).
>
> The code already supports both providers via the `S3_USE_SSE` flag (see PR #292: `s3.service.ts`
> sends the SSE header only when `S3_USE_SSE=true`). No code changes are required.

### 1.6 Host firewall — allow :80/:443 ONLY from Cloudflare (MANDATORY)

> **Why (security-critical):** nginx trusts the `CF-Connecting-IP` header from the Cloudflare ranges
> and restores the real client IP from it. This IP is written as **legal evidence**
> at contract and ToS signing. If someone reaches the origin IP of the VPS **directly, bypassing Cloudflare**
> (the origin IP often leaks), they will hit the same nginx and be able to send a **forged** `CF-Connecting-IP`
> → a forged legal IP. Therefore the origin MUST accept HTTP(S) only from Cloudflare.

**Option A (simpler): host firewall `ufw` — allow :80/:443 only from the Cloudflare CIDRs.**

```bash
# On the VPS. SSH (port 22) — keep open (better to restrict to your own IP separately).
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp                       # SSH (consider `ufw allow from <your-IP> to any port 22`)
# Allow 80/443 ONLY from the current Cloudflare ranges:
for cidr in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
  ufw allow from "$cidr" to any port 80  proto tcp
  ufw allow from "$cidr" to any port 443 proto tcp
done
ufw enable
ufw status numbered
```

> The CF range list changes rarely — on a change (see §11) re-run the loop and remove the old rules.

**Option B (more reliable): Cloudflare Authenticated Origin Pulls (mTLS)** — the origin accepts TLS only
from Cloudflare by a CF client certificate. Enabled in Cloudflare → SSL/TLS → Origin Server →
Authenticated Origin Pulls + `ssl_client_certificate`/`ssl_verify_client on` in nginx. Apply it if
the firewall lockdown is insufficient (for example, a dynamic set of outbound IPs).

> Without §1.6 the real-IP restore (§11) is bypassed → do not treat the IP evidence as trustworthy until the lockdown.

### 1.7 Cloudflare Turnstile — spam guard for the vacancy form (task-vacancies-api, PR #390)

> **CRITICAL — order of actions:** `apps/api/src/config/env.ts` fails the **prod boot** of the API
> (crash-loop) if `TURNSTILE_SECRET_KEY` is not set or stays at the default dev value of
> Cloudflare's "always passes" (a conscious security fix, not a bug). **Do NOT merge PR #390**
> (the public vacancy-apply endpoint) until the secret `TURNSTILE_SECRET_KEY` is set up in GitHub —
> otherwise the very first deploy after merge will drop the prod API into a crash-loop.
> One set-up secret is not enough: **PR #391 (this deploy.yml wiring) must be merged
> BEFORE (or at the same time as) PR #390** — on the current `main` the variable physically will not reach
> `.env.production`, and the vacancy DDL will not be applied. Order: secret → merge #391 → merge #390.

**Owner's steps in the Cloudflare Dashboard:**

1. Cloudflare → **Turnstile** → **Add site**.
2. Domains: `cheekycheese.tech` **and** `localhost` (the second — so the widget works in dev/locally).
3. Widget mode: Managed (recommended).
4. After creation Cloudflare will show the **Site Key** (public) and the **Secret Key** (private).

**Set up in GitHub → Settings → Secrets and variables → Actions:**

| Secret                    | Value                        | Where it goes                                                                                         |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY`    | Secret Key from step 4 above | `write-env` job → `.env.production` on the VPS → read by `apps/api` (`env.ts`)                        |
| `VITE_TURNSTILE_SITE_KEY` | Site Key from step 4 above   | `build` job → build-arg in `nginx/Dockerfile` (landing-builder stage) → baked into the landing bundle |

- `TURNSTILE_SECRET_KEY` follows the same path as the other API secrets (`JWT_SECRET`,
  `SESSION_SECRET`, ...): the SSH env channel in the `write-env` job → a line in `/opt/crm/.env.production`
  (mode 600) → read by the `api` container via `env_file` in `docker-compose.prod.yml`. `deploy.yml`
  is **fail-loud**: if the secret is empty, the `write-env` job fails BEFORE anything is deployed
  (an explicit check `if [ -z "$TURNSTILE_SECRET_KEY" ]`), with a message linking to this section.
- `VITE_TURNSTILE_SITE_KEY` — a build-time (not runtime) secret: it enters the `build` job as a
  Docker build-arg when building `nginx/Dockerfile` (the stage that actually builds
  `apps/landing` for prod — NOT `apps/landing/Dockerfile`, which only duplicates the ARG for
  a standalone local build). An empty value **does not break the build** — before PR #390 is merged (the form
  does not yet exist in the bundle) this is expected; the `build` job prints `::warning::` in the log if
  the secret is not set.
- Dev/locally: the default value is the CF-documented always-pass site key
  `1x00000000000000000000AA` (see `apps/landing/.env.example` and the root `.env.example`).
  On the API side — the corresponding always-pass secret key is already in `apps/api/.env.example`.

### 1.8 Google Indexing API — instant (re)indexing of vacancies (task-google-indexing-api)

> **Fully optional.** Without the keys, `apps/api` starts the indexing service in no-op mode
> (one warning in the logs at boot) — publishing/closing vacancies works as usual, just without a
> push notification to Google. This does NOT block the deploy and is NOT like Turnstile (§1.7) — there is no
> fail-loud check in `deploy.yml`.

**Why.** The Google Indexing API officially supports **only JobPosting pages**: after
`publish` the notification enters the index in minutes (not weeks, as with ordinary crawling), after
`close` — instant removal of a stale vacancy from the results. The public vacancy URL:
`https://cheekycheese.tech/careers/<slug>/` (the trailing `/` is required).

**Owner's steps in the Google Cloud Console:**

1. Open/create a GCP project (you can reuse an existing one if there already is one for other
   Google integrations of the project).
2. **APIs & Services → Library** → find **Web Search Indexing API** → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service Account** → set a name/description
   (for example `crm-indexing`) → **Create and Continue** → roles can be skipped (rights are granted
   via Search Console, not via IAM) → **Done**.
4. Open the created service account → the **Keys** tab → **Add Key → Create New Key** → format
   **JSON** → a file like `<project-id>-xxxxxxxxxxxx.json` is downloaded.
5. Extract `client_email` and `private_key` from the downloaded JSON and immediately encode the private key
   in base64 as one line (important: `jq -r` expands the literal `\n` inside the JSON string into
   real newlines of the PEM block BEFORE encoding; `tr -d '\n'` after `base64` removes
   the line wrap — on Linux `base64` without `-w0` wraps the output at 76 characters, on macOS
   `base64` does not wrap at all, so `tr -d '\n'` gives the same result on both OSes):

   ```bash
   # The path to the JSON key downloaded in step 4:
   KEY_FILE=~/Downloads/<project-id>-xxxxxxxxxxxx.json

   # → the value for the secret GOOGLE_INDEXING_SA_EMAIL:
   jq -r '.client_email' "$KEY_FILE"

   # → the value for the secret GOOGLE_INDEXING_SA_KEY_B64 (one line, no newlines):
   jq -r '.private_key' "$KEY_FILE" | base64 | tr -d '\n'
   ```

6. **Google Search Console → property `cheekycheese.tech`** (the same verified property from §11 item 5;
   indexing is requested only for the landing, so there is no need to additionally verify
   `app.cheekycheese.tech`) → **Settings → Users and permissions** → at the bottom of the page the link
   **Add an owner** (not the ordinary "Add user" — an ordinary user gets `403`, you need exactly an
   **Owner**) → paste the service account's `client_email` from step 5 → confirm.
7. Set up in **GitHub → Settings → Secrets and variables → Actions → Secrets** (Environment
   "production", through the same channel as `TURNSTILE_SECRET_KEY` — see the §3 table below):

   | Secret                       | Value                                                                                                                                                                                                              |
   | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `GOOGLE_INDEXING_SA_EMAIL`   | `client_email` from step 5                                                                                                                                                                                         |
   | `GOOGLE_INDEXING_SA_KEY_B64` | base64(`private_key`) from step 5 — one line                                                                                                                                                                       |
   | `PUBLIC_LANDING_ORIGIN`      | Optional — only if the landing base URL ever changes from `https://cheekycheese.tech` (this address is already embedded as the default in the `apps/api` code; the secret is NOT required at the first provision). |

   All three are read by the `write-env` job of `deploy.yml` and written to `/opt/crm/.env.production` **only
   if non-empty** (an empty string is not written at all — otherwise there is a risk that even an empty
   `GOOGLE_INDEXING_SA_EMAIL=` would confuse the Zod validator on the `apps/api` side, which distinguishes
   "the variable is absent" from "the variable is empty"). Nothing set up → the service stays in no-op.

**How to check that it works:**

- Publish (or close) any vacancy in the CRM → within a minute open **Search Console →
  URL Inspection**, paste `https://cheekycheese.tech/careers/<slug>/` and see that the
  indexing status updated (or request **Request Indexing** by hand if you want to force it).
- API logs on the VPS: `docker compose ... logs api | grep -i indexing` — successful notifications
  are logged; Google API errors are logged but **never** block the publishing/closing of
  a vacancy (fail-soft by design, see task-google-indexing-api).
- The weekly refresh of all `PUBLISHED` vacancies (API cron) and the weekly deploy rebuild are
  INDEPENDENT mechanisms with the common goal of "JobPosting freshness": the cron sends URL_UPDATED to Google,
  the rebuild updates validThrough/sitemap in the static assets
  (see the `schedule:` trigger in `.github/workflows/deploy.yml`, task-infra-weekly-rebuild) — both
  tied to the same "do not go stale between merges" logic as the sliding `validThrough`
  (build-time + 60 days).
- The default quota is 200 requests/day at onboarding; at the current vacancy volume (occasional
  publish/close + one weekly pass over all `PUBLISHED`) this is more than enough.

---

### 1.9 Cloudflare Workers AI — resume generation (task-infra-wire-cloudflare-ai)

> **The secrets are already set up by the owner** (`CLOUDFLARE_AI_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`) — this
> section documents what they mean and how their working state is checked, not how to create them
> again.

**Why.** The next layer of the "apply to vacancies" feature generates resumes via Cloudflare Workers AI.
There is no need to deploy a Worker — `apps/api` calls the REST API directly:

```
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}
Authorization: Bearer {TOKEN}
```

| Secret                  | Value                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_AI_TOKEN`   | An API token with **Workers AI — Read** and **Workers AI — Edit** rights (My Profile → API Tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID (Dashboard → right column of any domain)                                 |

**Both are OPTIONAL until the generation layer is merged** — `apps/api` does not read them yet (the code will arrive in a separate
PR). The `write-env` job of `deploy.yml` writes them to `/opt/crm/.env.production` **only if non-empty**
(the same conditional-write pattern as `GOOGLE_INDEXING_SA_*`/`RESEND_API_KEY`, see §3) — the deploy does not
fail either in their absence or in their presence before the consumer code appears.

**Token check on every deploy.** The `deploy` job's step **"Verify Cloudflare Workers AI token"**
(the first step of the job, before `docker compose up`) hits `GET .../ai/models/search?per_page=1` —
deliberately NOT `.../ai/run/<model>` (that entry point spends neurons of the free tier, 10,000/day
— the catalog `models/search` spends nothing). Three outcomes:

- **HTTP 200** — the token works.
- **HTTP 401** — the token is wrong or copied incompletely. Reissue/repaste the secret.
- **HTTP 403** — the token lacks the `Workers AI — Read`/`Workers AI — Edit` rights. Recreate with
  the needed scopes.
- Network/5xx/unexpected code — Cloudflare's side or a temporary problem, not our configuration.

Secrets not set → `::notice::` and a soft skip (the same pattern as the guarded DDL steps and
the IndexNow ping). A failure of the check itself (401/403/network) **does not fail the deploy** —
`continue-on-error: true`, the same principle as the backup-freshness check (§8.1): this is a signal about
configuration, not about the application's working state. Not a single character of the token enters the log —
the value is passed only through the `env:` block (never substituted into the text of the `run:` script), the body
of the response is discarded (`-o /dev/null`), only the 3-digit HTTP code is logged.

---

## 2. Installing Docker on the VPS

```bash
# On the VPS (as root or with sudo):
apt update && apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow the deploy user to run docker without sudo:
usermod -aG docker $USER
# Re-login or: newgrp docker

# Check:
docker compose version   # should show Compose plugin v2.x
```

> **Compose ≥ v2.22 is required** — `docker-compose.ghcr.yml` uses `build: !reset null` to
> reset the `build:` directive from the base compose (the syntax appeared in Compose v2.22). On a fresh
> install of `docker-compose-plugin` from the official repo (above) the version is modern — but if there is a
> "`!reset` not recognized" problem, upgrade the plugin: `apt update && apt install --only-upgrade docker-compose-plugin`.

---

## 3. GitHub Secrets — the full list

Add to **GitHub → Settings → Secrets and variables → Actions → Secrets** (Repository level).
Additionally create an **Environment "production"** and add them there too for extra protection.

| Secret                       | Value / how to get it                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VPS_HOST`                   | The VPS IP address (from §1.1)                                                                                                                                                          |
| `VPS_USER`                   | The SSH user (usually `root` or a dedicated deploy user)                                                                                                                                |
| `VPS_SSH_KEY`                | The contents of the private key `~/.ssh/crm_deploy_key` (the whole file including `-----BEGIN...-----`)                                                                                 |
| `POSTGRES_PASSWORD`          | `openssl rand -base64 32` — a strong password (≥32 characters)                                                                                                                          |
| `JWT_SECRET`                 | `openssl rand -base64 48` — at least 32 characters                                                                                                                                      |
| `SESSION_SECRET`             | `openssl rand -base64 48` — at least 32 characters                                                                                                                                      |
| `CREDENTIALS_ENC_KEY`        | `openssl rand -base64 32` — must be exactly 32 bytes for AES-256                                                                                                                        |
| `GOOGLE_CLIENT_ID`           | From Google Cloud Console → OAuth 2.0 Client (§1.3)                                                                                                                                     |
| `GOOGLE_CLIENT_SECRET`       | From the same place                                                                                                                                                                     |
| `S3_ENDPOINT`                | R2: `https://<account-id>.r2.cloudflarestorage.com`; AWS S3: leave empty (the SDK uses the default endpoint)                                                                            |
| `S3_REGION`                  | R2: `auto`; AWS S3 Frankfurt: `eu-central-1`                                                                                                                                            |
| `S3_BUCKET`                  | `crm-documents-prod` (documents — **NOT** `crm-backups`, see the box below)                                                                                                             |
| `S3_FORCE_PATH_STYLE`        | R2: `false`; AWS S3: `false` (virtual-hosted style). `true` — only the local dev/CI S3 stand                                                                                            |
| `AWS_ACCESS_KEY_ID`          | **Documents token** Access Key ID (§1.5) — scope ONLY `crm-documents-prod`, or an AWS IAM key                                                                                           |
| `AWS_SECRET_ACCESS_KEY`      | **Documents token** Secret (§1.5) — the same scope as above, or an AWS IAM secret                                                                                                       |
| `TURNSTILE_SECRET_KEY`       | Cloudflare Turnstile Secret Key (§1.7). **Required BEFORE merging PR #390** — otherwise the prod API crash-loops at boot.                                                               |
| `VITE_TURNSTILE_SITE_KEY`    | Cloudflare Turnstile Site Key (§1.7). Optional before #390 — an empty value does not break the landing build.                                                                           |
| `GOOGLE_INDEXING_SA_EMAIL`   | Fully optional (§1.8). `client_email` from the GCP service-account JSON key. Empty → the indexing service is in no-op mode, the deploy is not blocked.                                  |
| `GOOGLE_INDEXING_SA_KEY_B64` | Fully optional (§1.8). base64(`private_key` PEM) from the same JSON key, one line.                                                                                                      |
| `PUBLIC_LANDING_ORIGIN`      | Fully optional (§1.8). Needed only if the landing base URL changes — the code already has the default `https://cheekycheese.tech`.                                                      |
| `CLOUDFLARE_AI_TOKEN`        | Fully optional until the resume-generation layer is merged (§1.9). Rights `Workers AI — Read` + `Workers AI — Edit`. Every deploy checks its working state (does not block the deploy). |
| `CLOUDFLARE_ACCOUNT_ID`      | The Cloudflare account ID (§1.9) — not a secret in essence, but set up through the same channel as the token above.                                                                     |

> `GITHUB_TOKEN` (for the GHCR login in deploy) is generated by GHA automatically — no need to add it.
>
> `S3_USE_SSE` is **not in** the secrets list — it is hardcoded `false` right in `deploy.yml`
> (the write-env step), because our prod provider is Cloudflare R2 (see §1.5). Change it only when migrating to AWS S3.
>
> **The `crm-backups` token is NOT in this list, deliberately** — it lives ONLY in
> `/etc/crm-backup.env` on the VPS, never in GitHub Secrets (§1.5, §8). `AWS_ACCESS_KEY_ID`/
> `AWS_SECRET_ACCESS_KEY` above are a separate, documents-only token.

**Secret generation commands:**

```bash
openssl rand -base64 48   # JWT_SECRET, SESSION_SECRET
openssl rand -base64 32   # CREDENTIALS_ENC_KEY, POSTGRES_PASSWORD
```

---

## 4. TLS — configuring the certificate on the VPS

### Option A (recommended): Cloudflare Origin Certificate

The Origin Certificate is issued in the Cloudflare Dashboard (§1.2, step 6) and is valid for 15 years.
Cloudflare → Full (strict) terminates TLS at the edge and establishes a new TLS connection to the VPS.

> **Order MATTERS (we avoid a plaintext CF→origin window):** bring up 443 on the origin (origin cert +
> uncommented `listen 443 ssl`) and switch Cloudflare to **Full (strict)** BEFORE you
> enable Proxied / switch the NS to live traffic. If you enable Proxied while the origin is still `Flexible`/only-:80,
> the CF→origin leg will go over HTTP. After a valid origin cert, immediately uncomment HSTS in
> `security-headers.conf`.

```bash
# On the VPS — create a directory for the certs:
mkdir -p /etc/nginx/certs

# Copy the files downloaded from the Cloudflare Dashboard:
# origin-cert.pem → contains the certificate (CF issues .pem or .crt)
# origin-key.key  → the private key
scp origin-cert.pem root@<VPS_IP>:/etc/nginx/certs/cheekycheese.tech.crt
scp origin-key.key  root@<VPS_IP>:/etc/nginx/certs/cheekycheese.tech.key
# For app.* you can use the same wildcard cert (*.cheekycheese.tech):
cp /etc/nginx/certs/cheekycheese.tech.crt /etc/nginx/certs/app.cheekycheese.tech.crt
cp /etc/nginx/certs/cheekycheese.tech.key /etc/nginx/certs/app.cheekycheese.tech.key

chmod 600 /etc/nginx/certs/*.key
```

After placing the certs, uncomment the `listen 443 ssl` blocks in:

- `nginx/conf.d/crm.conf`
- `nginx/conf.d/landing.conf`

And uncomment the HSTS header in `nginx/conf.d/security-headers.conf`.

In `docker-compose.prod.yml` uncomment the `volumes:` section of the nginx service:

```yaml
volumes:
  - /etc/nginx/certs/cheekycheese.tech:/etc/nginx/certs/cheekycheese.tech:ro
  - /etc/nginx/certs/app.cheekycheese.tech:/etc/nginx/certs/app.cheekycheese.tech:ro
```

### Option B: Let's Encrypt (certbot)

```bash
# On the VPS (nginx must be stopped for standalone mode):
docker compose -f /opt/crm/docker-compose.prod.yml stop nginx
apt install -y certbot
certbot certonly --standalone \
  -d cheekycheese.tech -d www.cheekycheese.tech
certbot certonly --standalone \
  -d app.cheekycheese.tech
```

Renewal every 90 days — set up `cron` or a `systemd timer`:

```bash
# /etc/cron.d/certbot-renew
0 3 1 * * root certbot renew --pre-hook "docker stop crm-nginx-1" \
                               --post-hook "docker start crm-nginx-1"
```

---

## 5. Drizzle migrations in production [UNTESTED]

> The `db:push` (drizzle-kit push) strategy — idempotent schema synchronization.
> Safe to re-run. **Do NOT run `db:seed` in production.**

Current production strategy: the `deploy.yml` workflow has a step that attempts to run
`drizzle-kit push` inside the running API container. However, `drizzle-kit` is a dev
dependency and is **absent from the prod image of the API** (which is run through `pnpm deploy --prod`).

**Practical solution (recommended until automation):**

```bash
# On the VPS after `docker compose up -d`:
# Temporarily add DATABASE_URL from .env.production and run push via node:

docker run --rm \
  --network crm_backend \
  --env-file /opt/crm/.env.production \
  node:22-alpine \
  sh -c "
    npm install -g drizzle-kit &&
    # Need the schema — mount it or use another approach
    echo 'Requires schema files — use approach below'
  "
```

**A more reliable approach (once on a schema change):**

```bash
# Locally, with DATABASE_URL pointing to production via an SSH tunnel:
ssh -L 5433:postgres:5432 <VPS_USER>@<VPS_HOST> -N &
DATABASE_URL=postgresql://crm_user:<POSTGRES_PASSWORD>@localhost:5433/crm_db \
  pnpm --filter @crm/api db:push
kill %1  # stop the tunnel
```

**Long-term solution (Coder task):** add `drizzle-kit` as a runtime dep in
the prod image of the API or create a separate migrate container in `docker-compose.prod.yml`.

---

## 6. Bootstrap — the first two ADMIN users

> **Done ONCE after the first deploy. Do NOT run db:seed in prod.**
> `db:seed` creates test data (the dev seed) — not needed in production.

After `docker compose up -d` and successful migrations:

```sql
-- Connect to postgres on the VPS:
docker compose -f /opt/crm/docker-compose.prod.yml \
               -f /opt/crm/docker-compose.ghcr.yml \
               --env-file /opt/crm/.env.production \
               exec postgres psql -U crm_user -d crm_db

-- Insert two ADMIN users.
-- Only email + display_name + role. All other columns take the schema defaults:
--   id=gen_random_uuid(), created_at/updated_at=now(), senior_share_percent=26,
--   legal_full_name=NULL, google_id=NULL (filled in at the first login via Google SSO).
-- Do NOT fill in legal_full_name here — the legal full name is set separately when working with contracts.
-- Do NOT set senior_share_percent=NULL — the column is NOT NULL (it would fail); omit it → default 26
--   (for ADMIN the 50/50 share is computed separately, this field does not apply to it).
-- Replace the emails with real Google accounts AT THE MOMENT of bootstrap (do NOT commit to the repo):
INSERT INTO users (email, display_name, role) VALUES
  ('<email-konstantin>', 'Konstantin', 'ADMIN'),   -- ← real Google email of owner 1
  ('<email-maksym>',     'Maksym',     'ADMIN')     -- ← real Google email of owner 2
ON CONFLICT (email) DO NOTHING;

\q
```

After the INSERT — log in via Google SSO at `https://app.cheekycheese.tech`.
Login is only via Google OAuth (there is no manual OAuth in production, the `dev-login` endpoint
is active only when `NODE_ENV=development`).

---

## 7. The first deploy (step by step)

1. Make sure all the secrets are added in GitHub (§3).
2. Make sure the VPS is provisioned (§1-2) and the SSH key is verified:
   ```bash
   ssh -i ~/.ssh/crm_deploy_key <VPS_USER>@<VPS_IP> echo "SSH OK"
   ```
3. Run the deploy manually:
   GitHub → Actions → **Deploy** → Run workflow → Branch: `main` → Run.
4. Watch the logs in Actions (build → write-env → copy-compose → deploy).
5. After success — check the stack on the VPS:
   ```bash
   ssh <VPS_USER>@<VPS_IP> \
     docker compose -f /opt/crm/docker-compose.prod.yml \
                    -f /opt/crm/docker-compose.ghcr.yml \
                    --env-file /opt/crm/.env.production \
                    ps
   ```
   All services should show `(healthy)`.
6. Run the bootstrap of the ADMIN users (§6).
7. Configure TLS if not done yet (§4).
8. Smoke test:
   - `https://cheekycheese.tech` — the landing is shown.
   - `https://app.cheekycheese.tech` — a redirect to Google Login (not 502).
   - `https://app.cheekycheese.tech/api/health` — `{"status":"ok"}`.
   - Log in via Google SSO — land in the CRM.
9. **Auto-deploy is enabled** (since 2026-07-12 — a two-channel model):
   - **A human push/merge** (the owner via the GitHub UI, a revert, a hotfix) —
     `push: branches: [main]` in `deploy.yml` starts Deploy directly.
   - **Auto-merge via `merge-approved`** — `auto-merge-on-label.yml` after
     the squash explicitly dispatches `deploy.yml` (`gh workflow run --ref main`), because
     GITHUB_TOKEN pushes do not create push events for workflows (GitHub's
     anti-recursion protection; `workflow_dispatch` is a documented exception,
     works without a PAT).
   - There is no double run: on an auto-merge the push trigger is silent (GITHUB_TOKEN),
     the dispatch step fires; on a manual merge the push fires, dispatch does not participate.
   - The race condition is covered by `concurrency: deploy-production` + `cancel-in-progress: true`.

   **To disable auto-deploy in an emergency:**
   1. Comment out the `push:` block in `.github/workflows/deploy.yml`.
   2. Remove the "Dispatch production deploy" step from
      `.github/workflows/auto-merge-on-label.yml`.
   3. Commit and push.

---

## 8. Automatic PG backups

> **Incident (discovered 2026-08-03):** on the live VPS there was NOT A SINGLE one of
> the three conditions below — neither `/etc/crm-backup.env`, nor the crontab line, nor even
> the `pg-backup.sh` file itself (it was never copied to the server). Prod with
> finances, contracts, and personal data had been running without a single
> backup since the very first deploy, and nothing detected it.
> `task-infra-prod-backup-safety-net` closes the file part automatically
> (§8, step 1 below) and adds a permanent signal if backups stop
> appearing (§8.1) — but installing the cron and the secrets below is **still
> manual**, and it must be seen through to the end.

Script: `scripts/devops/pg-backup.sh`.
Schedule: daily at 3:00 UTC.

**Step 1 (automated, nothing to do).** Every `Deploy` run
copies `scripts/devops/pg-backup.sh` to the VPS at
`/opt/crm/scripts/devops/pg-backup.sh` (the same `copy-compose` mechanism already
used for `check-security-headers.sh`/`check-nginx-perimeter.sh`)
and on every run re-sets the execution bit (`chmod +x`, the step
"Ensuring pg-backup.sh is executable" in the `deploy` job) — so the file on the
server is now guaranteed fresh and executable after any deploy.

**Step 2 (manual, done by the owner — secrets and SSH access are not taken out to CI).**

> **Order matters: the env file first, then the cron.** Earlier there was
> a cron line here WITHOUT loading `/etc/crm-backup.env` — and `pg-backup.sh` does not read the variables
> itself, it requires them from the environment (`required_vars` in its header).
> Such a line fails on the very first run with `Required env var
'POSTGRES_PASSWORD' is not set`. The ready working line is below, after
> creating the file.

Create a file with the env variables for cron (cron does not inherit ~/.bashrc):

> **The creds here are NOT the values from the GitHub Secrets `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.**
> This is the **Backups token** — a SEPARATE R2 API Token, scope ONLY `crm-backups` (§1.5). The GitHub
> Secret with the same name is the **Documents token**, scope ONLY `crm-documents-prod`, and it
> does NOT have access to `crm-backups`. This is a deliberate split (§1.5) — the Backups token
> is set up in Cloudflare separately and lands **only** in this file, never in GitHub.

```bash
cat > /etc/crm-backup.env << 'EOF'
POSTGRES_PASSWORD=<value from the GitHub Secret POSTGRES_PASSWORD>
AWS_ACCESS_KEY_ID=<Access Key ID of the Backups token — see the box above, NOT a GitHub Secret>
AWS_SECRET_ACCESS_KEY=<Secret Access Key of the Backups token — see the box above, NOT a GitHub Secret>
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=crm-backups
S3_REGION=auto
BACKUP_RETENTION_DAYS=30
EOF
chmod 600 /etc/crm-backup.env
```

Install the cron line (it loads the env file itself):

```bash
0 3 * * * set -a; . /etc/crm-backup.env; set +a; /opt/crm/scripts/devops/pg-backup.sh >> /var/log/crm-backup.log 2>&1
```

> **`set -a` here is mandatory, not a decoration — do not "simplify" to `. file && script`.**
> Loading the file creates the variables in the CURRENT shell, while `pg-backup.sh`
> runs as a SEPARATE process and does not inherit variables not marked for export.
> Verified by experience 2026-08-04: `. env && child.sh` → the child process
> sees an empty value; `set -a; . env; set +a; child.sh` → sees it. The previous
> wording in this file (`source ... && ...`) was broken twice: besides the
> export, cron runs commands through `/bin/sh`, and that on Ubuntu is `dash`, where
> the `source` command does not exist at all — only the dot. The alternative, if
> you want to avoid `set -a`, is to put `export` before each line of the env file.

Dependency: the `aws` CLI v2 — install it per the instructions in the script's header.

**After installing the cron — be sure to run `pg-backup.sh` by hand once**
(`set -a; . /etc/crm-backup.env; set +a; /opt/crm/scripts/devops/pg-backup.sh`)
and confirm that the object appeared in the bucket (see §8.1) — do not rely only
on waiting for the next 03:00 UTC. It is exactly this step that used to be skipped and
never noticed.

**Restore:** the restore procedure is described in the comment at the end of `pg-backup.sh`.

### 8.1 How to confirm that backups are really happening (not just configured)

Previously this state (whether the cron is configured and whether it actually runs) was not
checked by anything — hence the incident above. Now there are two independent ways to
check:

- **An automatic signal (task-infra-prod-backup-safety-net, round 2,
  2026-08-03).** The `deploy` job of `deploy.yml` on every run (after any
  merge into `main` + the weekly rebuild on Sundays, see `schedule:` in
  `deploy.yml`) goes over SSH to the VPS (the same `appleboy/ssh-action` + `VPS_HOST`/
  `VPS_SSH_KEY` as the other SSH steps of the deploy — not a separate channel) and
  runs `scripts/devops/check-backup-freshness.sh` RIGHT ON THE SERVER. This is not a
  random choice: the creds that can read `crm-backups` specifically
  live ONLY in `/etc/crm-backup.env` on the VPS (§1.5) and never enter
  GitHub Actions — the check must run in the same place where these creds
  legitimately exist, otherwise GitHub secrets would again be needed to read the
  backup bucket, which would defeat the token split.

  The script on the server reads `/etc/crm-backup.env` and returns ONLY
  `STATUS=`/`AGE_HOURS=`/`OBJECTS=` — neither keys nor endpoint nor object
  names go out (see the script's header). `deploy.yml` distinguishes
  **three** outcomes, rather than lumping them into one:

  | STATUS                         | Means                                                                   | Reaction                          |
  | ------------------------------ | ----------------------------------------------------------------------- | --------------------------------- |
  | `not_configured`               | `/etc/crm-backup.env` is absent or incomplete                           | Alert: "backups not configured"   |
  | `stale`                        | An object exists but is older than 24h (or there are no objects at all) | Alert: "backups are stale"        |
  | `fresh`                        | The object is younger than 24h                                          | Closes an open alert (if any)     |
  | _(SSH failed / script failed)_ | The check could not be done — does NOT mean "no backups"                | Touches nothing, only `::warning` |

  The first three are definite states (handled by
  `scripts/devops/interpret-backup-freshness.sh`); the last deliberately
  does **not** touch the alert issue at all: if the check could not look at
  the bucket (SSH unreachable, the script failed unexpectedly), asserting "no
  backups" would be a lie, not a signal. The real alert (open/comment/close)
  goes through the **same** mechanism already used for a red `Deploy`
  (`scripts/devops/post-merge-alert.sh`, `scripts/devops/resolve-alert-
channel.sh`, `KIND=backup`) — the private telemetry repository, or
  this repository as a fallback if a PAT is unavailable. The issue is closed
  automatically when the next check finds `STATUS=fresh`. This
  check **does not fail the deploy itself** (see the comment in `deploy.yml` next to
  the "Check backup freshness on VPS (SSH)" step) — a backup's freshness is in no way
  connected to whether THIS deploy succeeded, so it is a separate
  operational signal, not a merge gate.

- **Manual check at any time (on the VPS itself, with the same creds):**
  ```bash
  set -a; . /etc/crm-backup.env; set +a
  aws s3 ls "s3://${S3_BUCKET}/backups/" --region "${S3_REGION}" \
    --endpoint-url "${S3_ENDPOINT}"
  ```
  The newest object by time (`crm-db-<timestamp>.sql.gz`) must not
  be older than a day. (From the owner's laptop this command will not work —
  the Backups token deliberately does not reach it, see §1.5.)

---

## 9. Rollback

**The primary method — `workflow_dispatch` with `image_tag`.** With task-infra-rollback-
deploys-not-rebuilds (this change) it is an HONEST rollback: the workflow deploys
an image already published in GHCR under the specified tag and **does not rebuild the code,
does not overwrite anyone's tag**. Before this change it was the opposite — entering an old
SHA still rebuilt the current `main` HEAD and published the result UNDER
THE OLD TAG, that is, destroyed the very image you were trying to roll back to,
silently, at the moment of the outage.

The only path to prod for the owner is this workflow: the owner has no SSH to
the server (see the "Emergency SSH path" section below).

```bash
# List of available tags (git SHA) in GHCR:
# GitHub → Packages → cheekycheeseit-crm-api → versions
#
# Take the hash from this list itself (7-40 characters) — AND TAKE IT EXACTLY AS
# PACKAGES SHOWS IT (copy-paste, do not recompute by eye).
# The reason is not cosmetic: the short git hash is of variable length (usually 7
# characters, but git itself lengthens it to 8+ if the repository grows
# so large that 7 becomes ambiguous) — what flashed somewhere in the logs
# as an 8-character hash may be registered in the registry under a 7-character tag.
# The `main` tag is visible there too, but it is not a separate version to roll back to, it is a label
# on the MOST RECENT build (the deploy moves it on every push) — that is,
# most likely the very build you are rolling back from.

# Deploy a specific tag manually via workflow_dispatch:
# GitHub → Actions → Deploy → Run workflow → image_tag: <git-sha>
```

What happens inside the `build` job on this run (in order of steps):

1. **Shape validation.** `main` or anything other than 7-40 hex characters is
   an explicit step error ("image_tag input is not a valid git SHA") BEFORE anything
   else — security review PR #613 round 2, SR-M-1. Substitute the hash from the Packages
   list above.
2. **Build & push for the API and nginx are SKIPPED entirely.** Nothing is
   built, the tag `<git-sha>` is not overwritten — the steps carry
   `if: inputs.image_tag == ''`, both false on this run.
3. **"Verify rollback image exists in GHCR"** checks the manifest of BOTH
   images (`-api` and `-nginx`) under the requested tag
   (`docker buildx imagetools inspect`, without downloading the layers). No image
   under this tag — an explicit `::error::` and the job fails HERE, before
   `write-env`/`copy-compose`/the deploy to the VPS. Nothing is sent to the
   server until both images are confirmed.
4. **"Verify rollback image fingerprint"** (security review PR #615 round 2
   SR-M-1, round 3 SR-M-4) reads the `GIT_COMMIT` baked INTO THE CONFIG OF BOTH
   images — API and nginx (not into the layers — the same cheap manifest-only request
   as step 3), and compares each with the requested tag. Matched — we go
   on. Not matched — the job fails HERE: the tag points not to the commit
   it calls itself (a typical trace of the old "rollback rebuilds" bug — see
   the preamble of this section). Images built BEFORE this PR have no such
   fingerprint at all — this is NOT a refusal, but a `::notice::` "cannot verify", and
   the deploy goes on with only the existence check (step 3). This is
   DIFFERENT from "could not read the manifest at all" (for example, a future
   multi-platform build) — that situation gives a separate, loud
   `::warning::`, rather than quietly merging with "no fingerprint" (round 3 SR-M-4:
   previously it merged — docker's return code in this case is 0, and the value
   is empty, that is, indistinguishable from an honest absence of the field without a separate
   check).
5. **"Verify rollback target commit has all hard-required files"**
   (security review PR #615 round 3, SR-H-3) checks out the full history and
   verifies — WITHOUT reaching the VPS, purely via `git cat-file` — that the REQUESTED
   ROLLBACK COMMIT really contains all the files that the `deploy` job script
   considers unconditionally mandatory (compose files + migrations marked
   `UNCONDITIONAL` there). Before this check the same thing was discovered only
   DEEP inside the `deploy` job, ALREADY AFTER `write-env` (an adjacent,
   not the next job — both carry only `needs: build`, run
   IN PARALLEL) had overwritten `.env.production` on the VPS, and already after
   `copy-compose` had copied to the VPS everything that EXISTS at this
   commit (only the 4 newest unconditional files at the end of the
   ~25-step job actually check their presence — by the failure of the
   `scp` itself, not by an explicit check). Fails here — means `write-env` and
   `copy-compose` do not start at all (both `needs: build`), and nothing truly goes
   to the VPS. See the next subsection on how to find out IN ADVANCE
   how far back you can roll today with this step, without waiting for
   the failure.
6. If everything above passed — `write-env`/`copy-compose`/`deploy` go as on
   an ordinary deploy, but with ONE difference from the automatic path:
   `copy-compose` checks out the repository not at the current `main`, but at the
   **requested rollback commit** — see the next subsection, it is important.

### Compose files and DDL on a rollback are taken from the rollback commit, not from `main`

**Security review PR #615 round 2, SR-H-2.** Before this fix the `copy-compose`
job checked out the repository WITHOUT specifying a revision — on a rollback this
meant the compose files and SQL migrations were copied from TODAY'S
`main`, not from the commit being rolled back to. Result: old code
(the requested image) was deployed on top of migrations that this code
had never seen — silently, on the only path that exists
specifically for recovery after an outage.

Now `copy-compose` on a rollback explicitly switches to the commit that
CORRESPONDS to the requested image tag. The practical consequence:

- Migrations added AFTER the rollback commit do not reach the VPS at all —
  the corresponding DDL files are simply absent from the checkout, and the already-existing
  guard checks ("not merged yet") quietly skip them. Nothing new is
  applied on top of the old code.
- If the rollback commit is OLDER than the moment when one of the
  "unconditional" migration files appeared in `main` (in the deploy script they are marked
  `UNCONDITIONAL` — the file is hard-expected to be in place, `exit 1` if it is not),
  the rollback fails. **Security review PR #615 round 3, SR-H-3, fixes
  WHERE exactly:** previously this was discovered at the very end of `copy-compose`
  (after the compose files, eight older migrations, and the secrets in
  `.env.production` had already reached the VPS — see the previous subsection,
  step 5) — that is, the claim "before anything reaches the VPS" was an
  HONEST intention, but not a fact. Now this check is a separate step
  of the `build` job (the previous subsection, step 5), runs BEFORE
  `write-env`/`copy-compose` even start, and the claim became true.
  The failure itself remains HONEST, not a bug: the deploy script cannot
  deploy a rollback that far back, and says so directly, rather than
  deploying an inconsistent state.

  **How to find out TODAY'S limit BEFORE trying the rollback** (and not
  only from the fact of the failure) — one command, giving the commit older than which
  you can no longer roll back with this workflow:

  ```bash
  git log -1 --format='%h  %ad  %s' --date=short -- \
    docker-compose.prod.yml \
    docker-compose.ghcr.yml \
    apps/api/drizzle/manual/2026-06-29_company_account_requisites_markdown.sql \
    apps/api/drizzle/manual/2026-07-04_audit_hardening_constraints.sql \
    apps/api/drizzle/manual/2026-07-11_drop_usr_record.sql \
    apps/api/drizzle/manual/2026-07-13_payment_type_and_drop_pending_payout.sql \
    apps/api/drizzle/manual/2026-07-14_usdt_income_idempotency_index.sql \
    apps/api/drizzle/manual/2026-07-14_transaction_audit_log.sql \
    apps/api/drizzle/manual/2026-07-22_vacancies.sql \
    apps/api/drizzle/manual/2026-07-25_vacancy_i18n_seo.sql \
    apps/api/drizzle/manual/2026-08-19_senior_drop_income_idempotency_index.sql \
    apps/api/drizzle/manual/2026-08-21_pending_obligations_payout_request_id.sql \
    apps/api/drizzle/manual/2026-08-22_settled_amount_snapshot.sql \
    apps/api/drizzle/manual/2026-08-22_invoice_signature_void_and_snapshot.sql \
    apps/api/drizzle/manual/2026-09-01_approvals.sql \
    apps/api/drizzle/manual/2026-09-01_user_emails.sql \
    apps/api/drizzle/manual/2026-09-02_project_status.sql \
    apps/api/drizzle/manual/2026-09-02_user_email_invites.sql \
    apps/api/drizzle/manual/2026-09-03_pending_senior_share.sql \
    apps/api/drizzle/manual/2026-09-04_approval_status_cancelled.sql \
    apps/api/drizzle/manual/2026-09-07_notification_subjects.sql \
    apps/api/drizzle/manual/2026-09-12_notification_emails.sql \
    apps/api/drizzle/manual/2026-09-12_notification_preferences.sql \
    apps/api/drizzle/manual/2026-09-19_notification_email_skip_stale.sql \
    apps/api/drizzle/manual/2026-09-20_user_locale.sql \
    apps/api/drizzle/manual/2026-10-03_company_account_label_code.sql \
    apps/api/drizzle/manual/2026-10-05_vacancy_sourcing_schema.sql \
    apps/api/drizzle/manual/2026-10-05_vacancy_sources_seed.sql \
    scripts/devops/check-security-headers.sh \
    scripts/devops/check-nginx-perimeter.sh \
    scripts/devops/pg-backup.sh \
    scripts/devops/check-backup-freshness.sh
  ```

  `git log -1 -- <list of paths>` takes the MOST RECENT commit that touched ANY
  of the listed files — that is, the commit that added the latest by time
  "unconditional" file. Any rollback tag OLDER than this commit will not
  pass the rollback (it fails at step 5 of the previous subsection, before the VPS); EXACTLY this
  commit and any newer one are safe. The list of paths is a conscious mirror
  (not output, not an import) of the files in the `build` job's step "Verify rollback
  target commit has all hard-required files" (deploy.yml) — if that list
  changes (a new unconditional file appears), this command must
  change in the same PR, otherwise it will again start lying about the limit, only now
  in the other direction. **This no longer rests on this paragraph alone** (PR
  #615, round 4): `scripts/devops/check-prod-ddl-wiring.py` compares the two
  lists of paths by set and fails the CI step "Prod DDL wiring guard", naming
  the specific file and where to add it, if someone edited one list and
  forgot the other.

  **Security review PR #615 round 4, SR-M-5.** The "mirror against mirror"
  comparison above does not see one class of error: if BOTH lists (this one and the preflight list
  in deploy.yml) skip the same file that `copy-compose`
  actually copies with an unconditional `scp`, there is no mismatch between them — and the output
  is green, even though the limit is computed incorrectly. Exactly so `scripts/devops/pg-backup.sh`
  and `scripts/devops/check-backup-freshness.sh` were absent from both lists,
  while remaining in the fixed `source:` of the first `scp` step (added to both
  lists in this same round). `check-prod-ddl-wiring.py` now also compares the
  preflight list against the actual set of paths from the UNCONDITIONAL
  (no `if:`) `scp` steps of `copy-compose` — the preflight list must
  COVER them (a superset, not exact equality: the list itself may name a file
  that is not in any `scp`, if it is unconditionally present by
  some other path). The syntactic fact "is there an `if:`" is all
  that is checked here; the gate does not infer the semantics of "conditional in essence".

- **The schema, meanwhile, is NOT rolled back — and in the general case cannot be.**
  If between the rollback commit and the moment of the outage a NON-ADDITIVE
  migration happened (a view redefinition, a column drop), these changes have ALREADY
  been applied to the live database by the time the decision to
  roll back was made — a time zone earlier than the rollback itself. Pinning the checkout
  stops the application of ANYTHING FURTHER in THIS run; it does not
  undo what the previous (bad) migration already did. This is an
  unavoidable asymmetry of a rollback — more honest to name it than to pretend
  it does not exist.

### After a rollback — the mandatory next step: a revert in `main`

**Security review PR #615 round 2, SR-H-1.** This workflow does NOT touch
`main` — it only deploys an already-built image. So the rollback is
**temporary by construction**: the next merge into `main` (auto-deploy) or
the nearest Sunday 03:00 UTC (the weekly rebuild) will deploy
`main` HEAD again and silently undo the rollback — possibly at night, when no one
is watching.

**The mandatory next step after a rollback, not a footnote:** revert the
commit(s) in `main` themselves (`git revert <bad-sha>`, open a PR, merge it), so that
the next automatic deploy ALREADY IS the state you need.
Until this is done — prod rests on the honest word of the schedule, not on
your decision.

This same warning is duplicated in two places of the run itself (by
construction, not by oversight): a `::notice::` in the log of the `build` job (visible
right at launch, before waiting for the rest of the pipeline) and a separate block in the
`$GITHUB_STEP_SUMMARY` of the `deploy` job (visible on the run page without
scrolling through the many-hundred-line SSH log, and stays visible after
the log itself has scrolled out of view).

### Verification after a rollback — how to confirm it really rolled back

`GET /api/health` returns the build fingerprint (`commit`,
`apps/api/src/health/health.controller.ts`) — compare it with the requested rollback
tag the same way, by prefix match, as step 4 above (the short and
full hash are not necessarily the same length, one is always a prefix of the other).

**An honest caveat:** for images built BEFORE the build-arg
`GIT_COMMIT` appeared in `apps/api/Dockerfile` (security review PR #613),
the `commit` in the response will be `"unknown"` — that is, for part of today's
population of existing images this check answers "cannot tell",
not "yes"/"no". In this case the only way to confirm is the job summary
of the run itself (the step above) plus the fact that steps 3-4 of the build job reached
the end at all without failing.

### Emergency SSH path (not for the owner — no SSH key to the VPS)

The same result by hand, for the holder of `VPS_SSH_KEY` (usually only the deploy
pipeline itself). Use only if the workflow itself is unavailable (for example,
GitHub Actions is down):

**Security review PR #615 round 2, LOW-1:** `docker-compose.ghcr.yml` resolves
the image as `...:${IMAGE_TAG:-main}` — WITHOUT an explicit `IMAGE_TAG` in the environment and WITHOUT
`--env-file .env.production` (the only place from which `docker compose`
would pick it up itself — the file is not called `.env`, there is no autoload) the command
will silently go to the tag `main`, that is, to THE VERY broken build you are
trying to get away from. Both commands below carry `IMAGE_TAG=<old-sha>` BEFORE
`docker compose` deliberately — do not shorten them to a bare `docker compose up -d`.

```bash
ssh <VPS_USER>@<VPS_IP>
cd /opt/crm
IMAGE_TAG=<old-sha> docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  pull api nginx
IMAGE_TAG=<old-sha> docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  up -d
```

---

## 10. Maintenance

```bash
# Logs:
docker compose -f /opt/crm/docker-compose.prod.yml \
               -f /opt/crm/docker-compose.ghcr.yml \
               --env-file /opt/crm/.env.production \
               logs -f api

docker compose ... logs -f nginx

# Restart only the API (for example, after changing .env):
docker compose ... restart api

# Full stop:
docker compose ... down

# DESTRUCTIVE (destroys all data):
docker compose ... down -v
```

---

## 11. Architecture notes

### Cloudflare + real client IP

When Cloudflare proxies the traffic (Proxied = yes), `$remote_addr` in nginx is the
Cloudflare IP, not the real client's. Nginx is configured (in `nginx/conf.d/crm.conf`
and `landing.conf`) with a `set_real_ip_from <CF-CIDR>` + `real_ip_header CF-Connecting-IP` block,
which restores the real client IP into `$remote_addr` before it reaches
`X-Forwarded-For` to the API.

This is critical: the IP is recorded as legal evidence at contract
and ToS signing, and is also used by the NestJS rate limiter.

> **Without the host firewall (§1.6) this mechanism is bypassed:** a direct hit to the origin IP bypassing Cloudflare
> allows forging `CF-Connecting-IP`, since nginx trusts the CF ranges. The origin lockdown on
> Cloudflare (§1.6) is a mandatory precondition for the trustworthiness of the IP evidence. `set_real_ip_from`
> trusts ONLY the CF CIDRs (not `0.0.0.0/0`) — check this when updating the CF ranges.

The CF CIDR list must be updated when Cloudflare changes it (rarely, but it happens):

- IPv4: https://www.cloudflare.com/ips-v4
- IPv6: https://www.cloudflare.com/ips-v6

**X-Forwarded-For: nginx OVERWRITES, does not append (verified for `/api/public/*`).**
A deployment note from security-review PR #390 (the public vacancy-apply endpoint, `POST
/api/public/vacancies/:slug/apply`, relies on `req.ip` for rate-limit): all `location /api/`
blocks in `nginx/conf.d/crm.conf` **and** `nginx/conf.d/landing.conf` (the HTTP and HTTPS server blocks, both
files) use `proxy_set_header X-Forwarded-For $remote_addr;` — this **overwrites** the
header with the value of `$remote_addr` (already restored from `CF-Connecting-IP` via
`set_real_ip_from`), rather than appending to the incoming client XFF (as
`$proxy_add_x_forwarded_for` would). This is already configured correctly — the client cannot forge the XFF
that the API will see. The public `/api/public/*` vacancy endpoint is proxied through the same
`location /api/` block (there is no separate location for `/api/public/*`), so it inherits the same
protection. No changes in `nginx.conf`/`conf.d/*` were required for this — only recording the fact.

### VITE_API_URL

The value `/api` is baked into the CRM SPA bundle at the stage of building the nginx image (BuildArg).
On a change — rebuild the image (CI does this automatically on every deploy).

### Drizzle migrations vs seed

- `db:push` (`drizzle-kit push`) — idempotent schema synchronization. Run on every deploy.
- `db:seed` (`tsx src/database/seed.ts`) — creates test data. **NEVER in production.**
  Only the two ADMIN users by hand (§6).

### SEO: prerender + de-index the CRM + Lighthouse gate (task-infra-seo-gates)

**Owner: only `cheekycheese.tech` (the landing) should be indexable. `app.cheekycheese.tech`
(the CRM) is a work tool, de-indexed deliberately.**

**1. De-index the CRM.** `nginx/conf.d/crm.conf` (both server blocks, :80 and :443) returns
`X-Robots-Tag: noindex, nofollow, noarchive` on **every** response of the app domain — not only HTML, but also
the static assets (js/css/fonts/images/sw.js/index.html), because nginx **does not inherit** `add_header` in
a location that itself defines its own `add_header` (the classic nginx gotcha — see the comment in
`crm.conf` itself). The header is duplicated explicitly in each such location. `location = /robots.txt`
on the app domain returns inline `User-agent: *\nDisallow: /` — there is no file in `apps/web/dist` and none is needed.
`apps/web/index.html` did NOT get a `noindex` meta tag (outside the DevOps zone) — the nginx header covers both
the HTML and the assets, this is enough.

**2. The landing stays indexable.** `nginx/conf.d/landing.conf` did NOT get an X-Robots-Tag and did NOT
get a separate `location` for `/robots.txt`/`/sitemap.xml` — both files are served directly from
`apps/landing/dist` (Vite copies `apps/landing/public/*` into the dist root), as soon as
task-landing-seo-prerender puts them in `apps/landing/public/`. **Owner-TODO after this
task is merged and deployed:** check `curl https://cheekycheese.tech/sitemap.xml`, that the sitemap
does NOT contain a URL to `app.cheekycheese.tech` (this is the responsibility of the Coder task, but it is the owner who is
the last check before sending it to the Google Search Console, see item 4 below).

**3. Prerender in the prod build.** `nginx/Dockerfile` (the `landing-builder` stage) was switched from
`node:20-alpine` to `mcr.microsoft.com/playwright:v1.59.1-noble` (Chromium requires glibc — Alpine
does not fit; the version is pinned to the `@playwright/test` from `pnpm-lock.yaml`, upgrade them together). After
the ordinary `vite build` comes a **forward-compatible guard**: if `apps/landing/package.json` has a
`build:prerender` script (added by a separate parallel task
task-landing-seo-prerender/`feature/landing-seo-prerender`) — it is run (Playwright crawls the landing
routes and writes static HTML for crawlers); if the script is not there yet — the step is a no-op with a
`::warning::` in the build log, the ordinary CSR dist is used. This means: **the infra PR and the PR with the
prerender script can be merged in any order**, neither breaks the other's deploy.
`PRERENDER_API_ORIGIN=https://cheekycheese.tech` is passed as a build-arg in `deploy.yml` — during
the image build the old container is still alive and serving prod traffic (the switchover is later, at the
`docker compose up -d` step in the deploy job), so a call to the real prod API for data for
the prerender (for example, published vacancies) is safe.

**4. The Lighthouse CI gate.** `.github/workflows/lighthouse.yml` — a separate workflow (NOT a job in
`ci.yml`, because it is triggered only on `apps/landing/**` diffs via `paths:`, unlike the always-running
required-checks of `ci.yml`). It builds the landing with the same forward-compatible guard as
`nginx/Dockerfile` (if the `build:prerender` script is not there yet — an ordinary `vite build`), then
`npx @lhci/cli@0.15.1 autorun` against `scripts/devops/lighthouserc.json` (staticDistDir —
lhci's built-in static server, without extra dependencies) on **mobile AND desktop** presets (matrix)
with assertions `performance/accessibility/best-practices/seo ≥ 0.90`, 3 runs, median.
**NOT the LHCI default** — `@lhci/utils/src/assertions.js` defaults `aggregationMethod` to `optimistic`
(for `minScore` assertions this is literally `Math.max` over the three runs — it takes the BEST result, not the
median; verified empirically: 3 local runs gave performance 85/92/86, `optimistic`
silently passed the threshold 0.9 by the best value 0.92). `scripts/devops/lighthouserc.json` explicitly
sets `"aggregationMethod": "median"` at the `ci.assert` level — do not remove it, thinking it redundant
next to `numberOfRuns`. A red assertion colors the PR check (`Lighthouse (mobile)` / `Lighthouse
(desktop)`) — **this is NOT a required
status check** (branch protection without required checks — see `devops.md` "Branch Protection"), so
the red flag is visible, but does not block the merge hard; the PM/reviewer must require green before
`merge-approved` on any PR touching `apps/landing/**`.

**5. Google Search Console — the ONLY step that is not automated (owner-TODO):**

1. https://search.google.com/search-console → "Add property" → `cheekycheese.tech` (a Domain
   property, not URL-prefix — it covers `www.` and no-`www` at once).
2. Verify ownership via a Cloudflare DNS TXT record (Search Console will show the value)
   OR an HTML file (does not fit — a SPA without static hosting of arbitrary files via Cloudflare
   Pages; DNS TXT is the simplest option with the Cloudflare DNS from §1.2 already configured).
3. After verification → Sitemaps → submit `https://cheekycheese.tech/sitemap.xml` (the file will appear
   after task-landing-seo-prerender is merged and deployed — before that a 404, this is normal).
4. **Do NOT add `app.cheekycheese.tech` as a separate property** — the CRM is deliberately de-indexed,
   there is no point in verifying it in GSC and it creates a risk of an accidental "Request indexing" of internal pages.

---

## 12. What is still NOT tested automatically

- Drizzle migrations inside the prod API container (§5) — `drizzle-kit` is not in the prod image.
- `pg-backup.sh` — requires the aws CLI and a working R2/S3 bucket.
- `scripts/devops/check-backup-freshness.sh` + `scripts/devops/interpret-backup-freshness.sh` —
  all states (not_configured / stale / fresh / aws-error) and the absence of a secret leak into the
  output were verified locally via `CRM_BACKUP_ENV_FILE`/`FAKE_MODE=1`/a stub `aws`
  (see `task-infra-prod-backup-safety-net`), but NOT over real SSH to the VPS and NOT against
  the real `crm-backups` bucket — the R2 bucket and the Backups token (§1.5) have not yet been created
  by the owner.
- TLS / Cloudflare Full (strict) handshake with the origin cert on nginx.
- A real smoke test via `https://app.cheekycheese.tech/api/health`.
- `set_real_ip_from` CF CIDR — the correctness of the real-IP restore under Cloudflare proxied.
- The host firewall (§1.6) — that the origin is really unreachable directly bypassing Cloudflare
  (check: a request to the origin IP bypassing CF should time out/be rejected).
- `pg-backup.sh` retention prune — that old backups are really deleted (epoch comparison).
- `ngx_http_realip_module` is present in the nginx image (in `nginx:alpine` it is there by default;
  confirm that the custom nginx Dockerfile does not strip it out).
- `deploy.yml` `permissions:` least-privilege — that the jobs work successfully with the trimmed token
  (build: packages:write, deploy: packages:read, the rest: contents:read).
- **task-infra-seo-gates** (nginx configtest + curl smoke passed locally via docker, see the PR —
  but NOT on real prod): `curl -I https://app.cheekycheese.tech/` really contains
  `X-Robots-Tag: noindex`; `https://app.cheekycheese.tech/robots.txt` really returns `Disallow: /`
  through Cloudflare (not only directly on the origin); `mcr.microsoft.com/playwright:v1.59.1-noble` as
  the base image of `landing-builder` does not increase the deploy build time above an acceptable level (the first
  real prod deploy after merge — measure it).
