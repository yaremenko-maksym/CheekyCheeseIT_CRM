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

## Which pattern is the contract

- **The contract (primary):** the line the API's one chokepoint emits (PR #1042,
  `privilege-denied-reporter`): `db_privilege_denied sqlstate=42501 table=<T> ctx=<C>`, with
  `table=unknown` meaning the 42501 named no table. The watch matches it **anchored on the logger
  context** it is emitted under, `[DatabasePrivilege] db_privilege_denied` ... `sqlstate=42501`,
  and reads the table from the `table=` field, never from Postgres text. Reported as
  `src=contract`. The anchor means request data echoed into some other handler's message cannot
  forge the primary pattern without also injecting that bracketed context. **Two things the API
  must keep stable, both part of the contract:** the context name `DatabasePrivilege`, and the
  line staying on Nest's **text** `Logger.error` (a pino record at warn level carrying a genuine
  42501 would be dropped by the level rule below).
- **Belt and braces (secondary):** the text `permission denied` and `must be owner|superuser`, for a
  privilege error that did not pass the chokepoint (a callback-style pool call) or while the
  chokepoint is not deployed. Reported as `src=text`.
- Both page. They can fire for the same failure (a handler's diagnostic line quotes the Postgres
  message), so the summary says "N contract, M other" instead of pretending to dedupe.
- **Not matched on purpose:** a bare `sqlstate=42501` or `code: 42501`. It matched #1042's diagnostic
  fragment `db_sqlstate=42501` (one failure, two pages), and a client can put it in a query string.
- **Changing a token in that line is changing the alert.** Tell whoever owns this watch; nothing
  in the repository ties the two together except this contract and the test fixtures.
- **Client-influenced logs:** Fastify's request logger writes `req.url` (query string included),
  `hostname` (from the Host header) and the requested path of a 404 into pino JSON records. Those
  records are dropped (below level 50) or stripped of `req`/`res`/`reqId` (level 50 and above)
  before matching, on the VPS and in the deploy scan, so an anonymous request cannot forge a hit
  through a pino record. How the filter fails matters more than how it works:
  - The level is read **from the text** (`{"level":NN`), never from a successful parse. Docker's
    json-file driver splits any line over 16384 bytes and `--timestamps` stamps **each chunk inline**,
    so a long record arrives with a second timestamp inside it; where the stamp lands decides whether
    `json.loads` works, and the client chooses (pino doubles each `"` it escapes). The old filter kept
    what it could not parse, request data included.
  - A record that will not parse has its embedded stamps stripped and is parsed again. One that
    still will not, but looks like pino, is **dropped, never kept**, and counted: the envelope carries
    `LOGSCAN_UNPARSED=<n>` and the checker prints a warning and a line in the run summary ("N
    pino-looking record(s) could not be parsed and were dropped"). A genuine error inside one would
    be missed, which is why the discard is visible rather than silent.
  - A **canary** goes through the same python invocation, and the filter must do every job it exists
    for: a level-50 record **with a `req` and a `reqId`** must come back exactly, with both removed
    (a filter that only drops level 30 leaves them in and fails); a level-30 record must not come
    back; a truncated level-50 record must not come back **and must be counted** as unparsed. A
    `python3` that exits 0 with empty output, copies its input, or does only part of the job fails
    the scan (`LOGSCAN_FAILED=req_filter_canary`; the deploy refuses) instead of turning a genuine
    hit into "clean".
  - **One hostile line cannot blind the scan.** Each line is processed on its own: the level is read
    from at most three digits, "looks like pino" is decided separately from the level, and any
    exception on a line (a 5000-digit level, a 200000-deep array) drops and counts that line
    instead of aborting the filter. A stranger who can put such a line into a log could otherwise
    switch the watch off.
  - The deploy scan calls `docker compose logs` **without** `--timestamps`, so Docker's inline chunk
    stamp is not produced there today; the same hardened filter and the same chunked-record test run
    against it anyway, so adding the flag later cannot reopen the hole.
  - **More than one `LOGSCAN_BEGIN` or `LOGSCAN_END` is BLIND.** A genuine run prints one of each;
    choosing a winner between two frames is wrong in both directions (a leading decoy, a trailing
    forgery).
    A text log line that echoes user input could still be forged; the way to close that is a structured
    field, not a better regex.

## What the gate can and cannot trust

- **Nothing in the deploy scan can fail a deploy any more: it is report-only.** Both the contract
  line and the unanchored text patterns (`permission denied`, `must be owner|superuser`) are
  counted and printed as warnings ("... NOT gating"). A gate a stranger can trip is worse than no
  gate: it blocks releases on demand and teaches people to disable it. The owner is still reached
  by the standing watch. What stays fatal is our own tooling failing to **look** (an unreadable
  log, no `python3`, a filter that fails its canary): no request can cause those, and "could not
  look" must not read as "nothing there". **Gating returns when the signal moves to a channel a
  request cannot write** (the journal, below).
- **Why:** Nest's text log lines are not filtered, and they carry decoded request data. Measured on
  a real stack (Nest 11, Fastify 5, drizzle-orm 0.45.2, node-postgres, Postgres 16): a public route
  whose slug reaches a query makes Drizzle put `params:` into its error message, Nest logs that
  message as a text line, and `%0a` in the same parameter lets a stranger start a physical log line.
  The pino filter is sound for pino records; text lines are the open channel.
- **The contract is NOT forgery-proof either.** Anchoring it on `[DatabasePrivilege]` was meant to
  need a newline plus a bracketed context, but the anchor needs only a space and a bracket, and
  `%20` and `%5B` supply both once decoded into a message. A stranger can also choose the table
  name from the public list, so the forged row looks genuine. So the standing watch can still be
  turned red by a stranger (a false alarm, not a suppression), which is why the deploy scan no
  longer gates on it. This is a known, open gap until the journal below exists.
- **The decision (PR #1041 review): the journal is the channel; a secret in the log line is not.**
  A nonce in the line would be a bearer secret in the one stream this repository publishes: the
  deploy prints `docker compose logs --tail=50 api` into a **public** Actions log on a health-check
  failure, GitHub masks only registered secrets, and one published line makes the scheme forgeable
  by replay. A MAC bound to the emission time would survive that, but "unforgeable by
  construction" beats "unforgeable by secret": a request cannot write files, there is nothing to
  leak, rotate or mask, and the signal stops depending on log formatting (which cost four review
  rounds and three HIGH findings). It also survives log rotation, which a grep never did.
- **The journal, in one paragraph:** the API's privilege chokepoint (PR #1042), in addition to its
  log line, appends one validated JSON record (`ts`, `table` restricted to `[A-Za-z0-9_$.]`, `ctx`
  from a fixed set) to a size-capped file inside the container; a write failure never affects the
  request. The scanner reads it with a fixed `docker compose exec -T api cat <journal path>`. Write
  side and read side are designed **together**, in one task across #1042's chokepoint and these
  scripts, not negotiated between two PRs. The deploy gate fails on the journal only once it exists.
- **Two costs accepted with eyes open:**
  1. **The journal is lost when the container is recreated** (a deploy). The deploy's own scan
     reads the new container's journal after boot, so that window is covered; what happened in the
     old container before a recreate is gone, exactly as its logs are today.
  2. **The scanner key gains `exec` where it had only `logs`.** That is a real widening: `exec`
     runs arbitrary commands in the production container.
- **PRECONDITION of the journal, not a nice-to-have:** the dedicated scanner key (see "What remains
  for the owner") must be installed with `restrict,command="..."` that **pins the exact `cat`
  invocation** (one fixed `docker compose ... exec -T api cat <journal path>`, no arguments taken
  from the client), and must **not** grant `exec` generally. The journal reader must not ship on
  the shared deploy key. Until that key exists, the journal read-side stays unmerged.
- **Not in this PR, and tracked separately:** scrubbing the query `params:` out of Nest's text log
  lines. It closes the measured route, not the family (any path that interpolates request data into
  a text line re-opens it), but it fixes a data-minimisation item already in the backlog, so it is
  its own task.

## Honest state

- **Coverage depends on the API logging the contract line** (PR #1042, `fix/api-log-db-sqlstate`).
  A Drizzle error's message is `Failed query: ...`; `permission denied` and `42501` live on `.cause`.
  Until the chokepoint is deployed, a swallowed privilege error in a cron handler does not reach the
  log this watch reads, and the contract has no production line to match: **detection in place and
  verified, coverage, paging and deploy gating pending**.
- **Paging is a failed-run notification**, which goes to whoever last edited the cron line and is not
  verified to reach a phone. A real channel (an `ntfy.sh` topic secret) is approved and is a
  separate follow-up.
- **A scan that lands while a deploy is recreating the api container goes BLIND (red).** There is
  no running api container for a few minutes, the watch cannot read anything, and it says so
  (`no running api container ... expected for a few minutes while a deploy recreates it`). It is
  not handled automatically on purpose: any "skip while a deploy is running" rule is a path that
  can silence the watch for good if the deploy run hangs. The deploy's own scan covers that
  window. Expect an occasional red run that clears on the next scan; a red run that does not
  clear is a real problem. A bounded, positively-verified deferral (read the Deploy run's status,
  excuse only a run younger than ~45 minutes) is a possible follow-up if the noise matters.
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
   workflow reads. **This key is also the precondition for the journal** (see "What the gate can
   and cannot trust"): reading the journal needs `exec`, so the forced command must pin the exact
   `cat` invocation and the key must not be allowed `exec` in general.
2. **A GitHub Environment** (for example `monitoring`) holding that key, with a deployment branch
   policy limited to `main`. Today the `production` environment has no secrets, reviewers or branch
   policy, and anyone with write access can run a branch version of a workflow with the repo
   secrets. That is inherent to repo-level secrets and no change in this workflow can close it.
3. **`VPS_KNOWN_HOSTS`** as a repository **variable** (public host-key lines, not a secret; get
   them with `ssh-keyscan -t ed25519 <host>` from a network you trust). Set it **before the schedule
   goes live**. Without it the driver fetches the host key with `ssh-keyscan` seconds before the
   strict check, so the check is against its own fetch and verifies nothing. The runner is
   ephemeral, so that is trust on **every** use, not on a first one. What this exposes is **not**
   key theft: public-key authentication signs over a session id bound to the attacker's own key
   exchange, so an impostor cannot replay it. It exposes an **on-path attacker answering as the
   VPS and forging a clean envelope**, which silences the watch. Low likelihood, bounded impact,
   and no worse than the deploy today; the driver warns on every run until it is set.
4. **Role in the alert.** The log does not name the role. Reading it means reading the
   credential-bearing `DATABASE_URL` inside the api container (printing only the validated user
   name); it was not done because it touches production configuration. Say if you want it.

## Verifying it end to end

`bash scripts/devops/tests/test-check-api-permission-denied.sh` — includes the seam between the
producer and the checker (the real driver over a stand-in and, where an `sshd` exists, over a real
`ssh` connection to a throwaway server). After the first merge, run the workflow once with
`workflow_dispatch` (window `6h` is fine) and confirm a green run on a real VPS.
