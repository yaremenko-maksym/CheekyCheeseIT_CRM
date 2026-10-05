# User Testing Tunnel — Pre-flight Checklist

We run `bash scripts/pm/prep-user-testing.sh <pr_branch>` to bring up the User Testing demo with a public URL for testing from a phone. This runbook is a checklist of all failure points based on real experience.

## The configuration that works (as of 2026-05-23)

| Layer               | Decision                                           | Why                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tunnel provider** | `serveo.net` (SSH reverse forward)                 | LocalTunnel — 503 on demand. Cloudflare quick tunnel — blocked in our network. ngrok free — requires registration + conflicts with rate limits. Serveo — stable, anonymous, over SSH.           |
| **URL format**      | `https://<hash>-<ip-dashed>.serveousercontent.com` | Anonymous mode (no SSH key auth).                                                                                                                                                               |
| **Build mode**      | Production build + Vite preview (NOT dev)          | Dev over a tunnel = flaky HMR socket + hundreds of unbundled requests. Preview = a minified bundle.                                                                                             |
| **API access**      | `vite preview` proxies `/api → localhost:3001`     | So that from the mobile browser requests go through the tunnel origin, not to the phone's localhost.                                                                                            |
| **OAuth login**     | **Dev Login** (`POST /api/auth/dev-login {email}`) | Google OAuth does not work over a tunnel — `redirect_uri_mismatch` (Google requires a whitelisted redirect URI, and the tunnel URL is dynamic). Dev Login is a bypass for testing.              |
| **Dev Login UI**    | `VITE_DEV_LOGIN=true` in the build (always)        | `login.tsx` renders the Dev Login button only if `import.meta.env.DEV` or `VITE_DEV_LOGIN === 'true'`. In a production build `DEV === false` → the flag is required. The script sets it itself. |
| **Ports**           | `API_PORT=3001 PORT=3001` (explicit export)        | Overrides any environment inherited from previous runs.                                                                                                                                         |

## Pre-flight checklist (what must be done BEFORE launch)

### 1. SSH is available

```bash
command -v ssh && echo OK
```

The script checks this automatically. If not — `xcode-select --install` (macOS) or `apt install openssh-client` (Linux).

### 2. Vite allowedHosts includes `.serveousercontent.com`

Check `apps/web/vite.config.ts`:

```ts
server: { allowedHosts: ['.serveousercontent.com', '.serveo.net'], ... }
preview: { allowedHosts: ['.serveousercontent.com', '.serveo.net'], ... }
```

Without this, Vite returns `Blocked request. This host is not allowed.` on any non-localhost Host header.

### 3. The preview proxy for /api is configured

In `vite.config.ts → preview`:

```ts
proxy: {
  '/api': { target: 'http://localhost:3001', changeOrigin: true }
}
```

Without this, the browser on the phone will try `GET http://localhost:3001/api/...` — that is the PHONE's own localhost, and the API is unreachable.

### 4. Build with the right env vars

`scripts/pm/prep-user-testing.sh` builds with:

- `VITE_API_URL=/api` — relative API URLs (otherwise a hardcoded localhost breaks the tunnel)
- `VITE_DEV_LOGIN=true` — shows the Dev Login button in a production build

If you override the environment — do NOT set `VITE_API_URL=http://localhost:3001/api` (that will break the tunnel). It is better to leave `VITE_DEV_LOGIN` at its default — the script sets it itself.

### 5. Postgres is running and tracking is present

The script checks this automatically (drizzle pre-flight). If it is red — `docker-compose up -d` and wait.

### 6. Dev Login is available on the backend

`apps/api/.env`: `ENABLE_DEV_LOGIN=true` (or equivalent). Without the backend flag the button is in the UI, but `POST /api/auth/dev-login` returns 403. On the frontend — a server error.

### 7. Ports 3000 and 3001 are free

The script kills its own previous processes (by ports via `lsof -ti`, not by name — it does not touch third-party Vite/Node), but if 3000 is occupied by an unrelated dev server (for example, VSCode holding it) — it prints diagnostics with PID/command and suggests closing it manually.

## Environment variables

| Var                 | Default        | Description                                                                                                       |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SKIP_TUNNEL`       | `0`            | `1` — do not bring up Serveo, only locally on `localhost:3000`. Useful if the tunnel is not needed / not working. |
| `SKIP_UNIT_TESTS`   | `0`            | `1` — skip step 4 (unit tests). **Use only on flakes**, understanding the risk of showing a broken bundle.        |
| `POSTGRES_HOST`     | `localhost`    | Postgres host.                                                                                                    |
| `POSTGRES_PORT`     | `5432`         | Postgres port.                                                                                                    |
| `POSTGRES_DB`       | `crm_db`       | DB name.                                                                                                          |
| `POSTGRES_USER`     | `crm_user`     | DB user.                                                                                                          |
| `POSTGRES_PASSWORD` | `password`     | DB password.                                                                                                      |
| `API_PORT` / `PORT` | `3001` (force) | The script explicitly exports `3001`, overriding any inherited value.                                             |

## Launch

```bash
bash scripts/pm/prep-user-testing.sh <pr_branch>
```

With a flake bypass:

```bash
SKIP_UNIT_TESTS=1 bash scripts/pm/prep-user-testing.sh <pr_branch>
```

Locally only (no tunnel):

```bash
SKIP_TUNNEL=1 bash scripts/pm/prep-user-testing.sh <pr_branch>
```

Expect:

- ~30-40 sec build (api + web)
- ~10 sec server startup
- ~5-30 sec handshake with serveo.net + URL parsing
- Total: ~60-90 sec until the frame with the URL is visible

## If it failed — diagnostics

### `command not found: timeout` (or nothing fails, but it hangs)

This is macOS without brew coreutils. The script falls back on its own to `gtimeout` → `perl alarm`. If you see this error — you have an old version of the script without the shim. Update to the current main.

### `fatal: 'X' is already checked out at '/path/to/worktree'`

The branch is already checked out in another git worktree (`.claude/worktrees/<name>`). The script should detect this itself via `git worktree list --porcelain` and `cd` into the right worktree instead of checking out. If it fails — you have an old version of the script.

Manual workaround: `cd /path/to/worktree && bash scripts/pm/prep-user-testing.sh <branch>` from there.

### `Port 3000 (Vite preview) occupied after kill`

The script could not free the port even after kill -KILL. This means the port is held by a process that is not found via `lsof -ti :3000` (for example, a root process or a Docker container on the host network).

The diagnostics are printed with PID and command. Typical sources:

- VSCode dev server (close the terminal in VSCode)
- A forgotten `pnpm dev` session (`pkill -f 'vite|nest'` or `ps aux | grep -E 'vite|nest'`)
- Another run of `prep-user-testing.sh` (`ps aux | grep prep-user-testing`)
- A Docker container with `--network host` (`docker ps`)

### `Serveo SSH tunnel went down`

The tunnel log is in `/tmp/pm-serveo-<PID>-<random>.log` (printed to the script's stderr). Typical errors:

| Error in the SSH log            | Cause                                              | What to do                                                                                                  |
| ------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `port 80 is already in use`     | Someone else is holding a tunnel on serveo         | Wait 30 sec and retry (anonymous tunnels free the port quickly)                                             |
| `Connection refused`            | SSH on 22 is blocked by a firewall                 | Use a tunnel over 443 (Serveo: `-p 443 serveo.net`) or change networks                                      |
| `Host key verification failed`  | An old key in `/tmp/pm-serveo-known-hosts`         | `rm /tmp/pm-serveo-known-hosts && retry`                                                                    |
| `Permission denied (publickey)` | Only if the OpenSSH config globally requires a key | `ssh -o PreferredAuthentications=password serveo.net` (but usually a key is not required for anonymous SSH) |

### `/api/health via preview (3000) is unreachable`

This is a sanity check in the script (after wait-for-services). It means `preview.proxy` is not configured in vite.config.ts. See check 3 above.

### `localhost:3000 does not respond after wait-for-services`

The build failed or the preview server did not start. Logs:

- `/tmp/pm-api.log` — the NestJS log
- `/tmp/pm-web.log` — the Vite preview log

### The tunnel came up, the URL is visible, but the page does not open from the phone

1. Open the URL in a desktop browser — if it works there, the problem is in the mobile network (a firewall on public DNS, for example)
2. Try another Wi-Fi on the phone or mobile data
3. Use `curl https://<tunnel-url>/api/health` from the desktop — if 200, the tunnel works and the problem is UI-level

### The Dev Login button does not appear on the login page (you are testing via the tunnel)

Symptom: you open the tunnel URL from the phone → `/crm/login` shows only the Google SSO button.

Cause: the build was made without `VITE_DEV_LOGIN=true`. In the production bundle `import.meta.env.DEV === false`, and the condition `DEV || VITE_DEV_LOGIN === 'true'` returns `false` → the button is hidden.

Fix: rebuild via `scripts/pm/prep-user-testing.sh` — it sets the flag itself. If you run the build manually: `VITE_API_URL=/api VITE_DEV_LOGIN=true pnpm --filter @crm/web build`.

### OAuth: `redirect_uri_mismatch` on the phone

This is expected — Google OAuth requires a fixed redirect_uri in the Console. The tunnel URL is dynamic. **Fix: use Dev Login** (`POST /api/auth/dev-login {email}`) via the login page, not Google.

### Unit tests failed and are blocking User Testing

If you know it is a flake (not a real regression) and want to quickly show the UI to the user:

```bash
SKIP_UNIT_TESTS=1 bash scripts/pm/prep-user-testing.sh <pr_branch>
```

**Risk:** the user will see a bundle with potentially broken logic. Use only when you are sure the cause is flaky test infra (a race in a snapshot, a timeout under load), not a real regression. In parallel, open a task to stabilize the test.

## Full fallback: SKIP_TUNNEL

If nothing works / phone testing is not needed — disable the tunnel:

```bash
SKIP_TUNNEL=1 bash scripts/pm/prep-user-testing.sh <pr_branch>
```

The script will bring up the API + preview locally, without a tunnel. You can test on the desktop via `http://localhost:3000`.

## What does NOT work (known limitations)

- **Hot reload over the tunnel** — preview mode does not serve HMR. Any code change → restart the script.
- **Persistent subdomain** — anonymous Serveo generates a random hash. To get a stable URL — configure an SSH key in `~/.ssh/serveo` + use `ssh -i ... user@serveo.net` (see https://serveo.net).
- **WebSocket** — the preview server forwards HTTP, but not WebSocket. If the backend uses WS for something — it will not pass through the tunnel. (The CRM does not use WS yet.)
- **Google OAuth** — see above. A permanent fix would require whitelisting the tunnel domain in the Google Console (impossible for dynamic hashes).

## History of attempts (to understand why serveo.net specifically)

1. **LocalTunnel** — 503 Service Unavailable. A known problem under high load on the free tier.
2. **Cloudflare quick tunnel** — `trycloudflare.com` is blocked in our network (corporate firewall or ISP-level).
3. **ngrok free** — requires registration + a very strict rate limit, the hash changes on every start.
4. **serveo.net** — works. SSH reverse forward, anonymous, free.

When changing providers: update `allowedHosts` in `vite.config.ts` AND the URL regex in `prep-user-testing.sh`.

## macOS compatibility of the script (for DevOps)

The script actively supports macOS without brew coreutils — all the utilities used are wrapped in shims:

- `timeout` → fallback to `gtimeout` → fallback to `perl alarm`
- `mktemp` template → an explicit name `/tmp/pm-serveo-$$-${RANDOM}.log`
- `pkill -f vite` → `lsof -ti :3000 | xargs kill` (by port, not by name — it does not kill third-party processes)
- `git checkout` → detects the worktree via `git worktree list --porcelain`, `cd` if the branch is in another worktree
