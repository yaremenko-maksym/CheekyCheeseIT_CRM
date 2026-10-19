# API permission-denied watch — runbook

Measure 2 of the least-privilege ADR (`docs/architecture/2026-10-17-db-least-privilege-roles.md`,
"What step 4 does not reach"). Workflow: `.github/workflows/api-permission-denied-watch.yml`.

## What it is

- Every 30 minutes a runner opens one **plain `ssh`** session (`scan-api-permission-denied.sh`),
  runs `api-permission-denied-remote.sh` on the VPS (read-only: `docker compose ps` / `logs`),
  and pipes the result straight into `check-api-permission-denied.sh`.
- The VPS matches and sanitises: only validated fields leave production (this repository and its
  Actions logs are public). The checker is the second lock and refuses any other line without
  printing it. `logger` and `object` are allowlisted against the privilege manifest and the
  source; anything else is `unknown`, and **`unknown` still pages**.
- The deploy has its own scan of the new container's logs (`deploy-stack-on-vps.sh`), which fails the
  deploy.
- Exit codes: `0` clean, `1` a hit, `2` blind (could not read the logs). Both `1` and `2` turn the
  run red. A blind scan is never a clean one.

## Honest state

- **Coverage depends on the API logging the SQLSTATE** (`fix/api-log-db-sqlstate`). A Drizzle error's
  message is `Failed query: ...`; `permission denied` and `42501` live on `.cause`. Until the API
  writes them, a swallowed privilege error in a cron handler does not reach the log this watch reads.
- **Paging is a failed-run notification**, which goes to whoever last edited the cron line and is not
  verified to reach a phone. A real channel (an `ntfy.sh` topic secret) is approved and is a
  separate follow-up.
- Known gaps: a deploy recreates the container and its older logs go with it; the log driver
  rotates (10 MB x 5), so a flood inside one window could push a hit out; GitHub disables scheduled
  workflows after 60 days without repository activity and nothing alerts on the watch itself going
  missing.

## What remains for the owner (SSH surface)

The watch runs with the **full deploy key** (`VPS_SSH_KEY`, repo-level secret), so it is not
read-only by construction: the command is, the key is not. The plain-`ssh` change removed the
third-party action and its unchecksummed runtime download from that path. Still open, all of which
are production credentials or settings and therefore yours:

1. **A dedicated key** for this watch, installed in `authorized_keys` with
   `restrict,command="<read-only logs wrapper>"`. A forced command ignores what the client asks for,
   so `api-permission-denied-remote.sh` would have to live on the VPS (installed by you) and the
   driver would stop piping it. The `docker` group is root-equivalent on that host, which is why the
   restriction must be on the key and not left to the script. Then replace the `VPS_SSH_KEY` the
   workflow reads.
2. **A GitHub Environment** (for example `monitoring`) holding that key, with a deployment branch
   policy limited to `main`. Today the `production` environment has no secrets, reviewers or branch
   policy, and anyone with write access can run a branch version of a workflow with the repo
   secrets. That is inherent to repo-level secrets and no change in this workflow can close it.
3. **`VPS_KNOWN_HOSTS`** as a repository **variable** (public host-key lines, not a secret). Without
   it the driver trusts the host key on first use and prints a warning on every run.
4. **Role in the alert.** The log does not name the role. Reading it means reading the
   credential-bearing `DATABASE_URL` inside the api container (printing only the validated user
   name); it was not done because it touches production configuration. Say if you want it.

## Verifying it end to end

`bash scripts/devops/tests/test-check-api-permission-denied.sh` — includes the seam between the
producer and the checker (the real driver over a stand-in and, where an `sshd` exists, over a real
`ssh` connection to a throwaway server). After the first merge, run the workflow once with
`workflow_dispatch` (window `6h` is fine) and confirm a green run on a real VPS.
