# Can `pg-boss` own job-source runs in this repository, under `crm_app` and deploy-only DDL?

**Date:** 2026-10-24 · **Why:** the ADR `2026-10-24-job-source-run-ownership.md` (r5 Task 2.5) has to
choose between hand-written Postgres claims and `pg-boss`. This file records the external facts that
choice rests on.
**Shelf life:** recheck the whole file on any `pg-boss` major release. Recheck the "Version and
cadence" facts if the decision is reopened more than 90 days after 2026-10-24. The signal is
`npm view pg-boss version engines`: if `engines.node` no longer admits Node 22, or `"type"` stops
being `"module"`, this file is stale.

## Short answer

`pg-boss` 12.38.0 (MIT) runs on our Node 22 pin (it requires `>=22.12.0`). It is ESM-only. It **can**
run without `CREATE` privileges: set `migrate: false`, keep non-partitioned queues and leave
`persistQueueStats` off. The schema is then pre-created from SQL that the library exports. Every
schema-version bump becomes a deploy-applied migration, and the schema version moved six times in
the 40 days before this file was written. It fences its **own** settle calls per attempt
(`id:retry_count`). It knows nothing about our tables, so it cannot fence our page writes or recover
our meter reservations.

## Facts

Unless marked otherwise, each fact was read from the published tarball `pg-boss@12.38.0`
(`npm pack`, read without executing) or from the npm registry, on 2026-10-24.

### Version, runtime, licence, maintenance

- Current version **12.38.0**, published 2026-10-13. Source: npm registry, `npm view pg-boss version time`, 2026-10-24.
- `engines.node` is **`>=22.12.0`**. Source: same, and `package.json` in the tarball.
- `"type": "module"`, with `main` and `types` pointing at `dist/index.*` and no `exports` map. Source: `package.json` in the tarball.
- Licence **MIT**. Source: npm registry, `license`.
- Exactly one npm maintainer. Source: `npm view pg-boss maintainers`, 2026-10-24.
- 77 releases in the 12.x line, from 12.0.0 (2025-11-09) to 12.38.0 (2026-10-13). Source: `npm view pg-boss time`.
- Repository: [github.com/timgit/pg-boss](https://github.com/timgit/pg-boss) (`repository.url` in `package.json`).

### Dependencies (bounded supply-chain review)

- Runtime dependencies: `pg ^8.23.1`, `cron-parser ^5.10.2`, `rrule-temporal ^2.2.8`,
  `serialize-error ^13.0.2`. There is one peer dependency, `@opentelemetry/api ^1.9.0`, and no
  `peerDependenciesMeta` marks it optional. Source: `package.json` in the tarball.
- Second level: `cron-parser` needs `luxon`; `rrule-temporal` needs `temporal-spec`; `serialize-error`
  needs `non-error` and `type-fest`. All are MIT. Source: `npm view <pkg> dependencies license`, 2026-10-24.
- `apps/api` already depends on `pg ^8.23.1`, so `pg` is shared rather than new.
- New packages: 7, counting `pg-boss` and the peer.
- The tarball has no `install` or `postinstall` script. Its `scripts` are `build`, `clean`,
  `prepublishOnly`, `pretest` and `test`. Source: `package.json` in the tarball.

### Schema creation, and running without `CREATE`

- Constructor options: `schema` (default `pgboss`), `migrate`, `createSchema`, `supervise`,
  `schedule` and `persistQueueStats`. Source: `dist/types.d.ts` (`DatabaseOptions`,
  `MaintenanceOptions`, `SchedulingOptions`).
- The docs describe `migrate: false` as the setting for when the user "does not have schema mutation privileges". Source: [pgboss.io/api/constructor](https://pgboss.io/api/constructor), 2026-10-24.
- The docs say `createSchema: false` stops the library issuing "the `CREATE SCHEMA` statement". Source: same page.
- With `migrate: false`, `start()` calls `check()` instead of installing anything. `check()` throws
  `pg-boss is not installed` or `pg-boss database requires migrations` when the stored schema version
  differs from the library's. Source: `dist/index.js` (`start`) and `dist/contractor.js` (`check`).
- The library exports `getConstructionPlans(schema, { createSchema })` and
  `getMigrationPlans(schema, version)`. Both return SQL text that can be applied by hand. Source:
  `dist/index.d.ts`.
- Schema version at 12.38.0: **46**. At 12.30.0 (2026-09-03) it was **40**. Source: the `pg-boss`
  key in `package.json` of each tarball, and `dist/schema.json`.
- Installation creates the tables `version`, `queue`, `schedule`, `subscription`, `bam`, `warning`,
  `job_dependency`, `instance`, `job` (`PARTITION BY LIST (name)`) and its default partition, plus
  `queue_stats` and functions including `create_queue`. Source: `dist/plans.js`.
- **DDL at runtime, outside migrations.** There are two such paths:
  (1) `createQueue` with `partition: true` runs `CREATE TABLE … ATTACH PARTITION` (default `false`);
  (2) when `persistQueueStats` is on, the supervise pass creates daily `queue_stats` partitions.
  With both off, no runtime DDL was found in `dist/`. One exception exists and is not used in
  production: `clock.js` creates a clock table, and the types document that path as active only under
  a `TestClock`. Source: `dist/plans.js` (`create_queue`, `ensureQueueStatsPartitions`) and
  `dist/boss.js` (`#supervisePass`).

### Ownership semantics

- Claim: `UPDATE … SET state = 'active', started_on = now(), heartbeat_on = now(), retry_count = …`.
  The claim increments `retry_count` on every claim after the first, and the selection uses
  `SKIP LOCKED` on standard Postgres. Source: `dist/plans.js` (fetch plan).
- **Attempt fence (upstream issue #925).** `complete`, `fail` and `touch` accept `{ id, retryCount }`
  and match on `state = 'active'` and the `id:retry_count` pair, so a stale worker's settle cannot
  land on a newer attempt. Upstream's comment calls this "The attempt fence". The fence is reset by
  the public `restore()`. Source: `dist/plans.js` (`attemptFence`).
- The fence applies **only to pg-boss's own job row**. No API hands a caller a token that can be
  checked inside another table's transaction. A caller _could_ read `pgboss.job` inside its own
  transaction, but that is a join into a third-party schema whose shape changes with each schema
  version. This is an inference from the API surface, not a documented guarantee.
- Heartbeats: `heartbeatSeconds` per queue or job, refreshed by `touch`. Expiry and missed heartbeats
  are handled by the supervise pass. Source: `dist/types.d.ts`, `dist/manager.d.ts`.
- Single flight: the queue policies `singleton`, `stately` and `exclusive` can be scoped by
  `singletonKey`, and the docs say `singleton` "only allows 1 job to be active". Group concurrency
  (`group: { id, tier }` with `GroupConcurrencyConfig`) limits active jobs per group. Source:
  `QueuePolicy` doc comment and `GroupOptions` in `dist/types.d.ts`.
- `send` returns **`Promise<string | null>`**: the new job id, or `null` when nothing was inserted
  (a policy or singleton conflict, or throttling). Source: `dist/index.d.ts`; `dist/manager.js`
  maps an empty insert to `null`.

## Applicability to us

- **Node 22 pin** (`version-pins.md`): satisfied. The `>=22.12` floor is the same floor that
  `@rgrove/parse-xml` already imposes, so it adds no new constraint.
- **ESM-only versus `apps/api`** (`module: CommonJS`, `moduleResolution: Node`). TypeScript resolves
  the types through the `types` field, and `version-pins.md` records `require(esm)` as available
  from 22.12. Nothing in `dist/` uses top-level `await` (a grep for line-initial `await` found
  none). **Not proven by running.** A spike would have to show that `nest build` output can
  `require('pg-boss')` and that Vitest can load it. That is the same class of risk that blocked
  Lingui 6 here, though the cause differs (Lingui 6 lacked a `types` path under `node10`
  resolution).
- **`crm_app` cannot `CREATE`** (least-privilege ADR, F5 of the run-ownership ADR). Therefore
  `migrate: false` and `createSchema: false`, plus a manual migration that applies
  `getConstructionPlans('pgboss', { createSchema: true })` as `crm_user` through `deploy.yml`, plus
  grants to `crm_app` on the `pgboss` relations and functions. The catalog check inspects `public`
  only for grants, so the new schema needs new catalog-check parts too.
- **Every `pg-boss` upgrade that bumps the schema version** needs a migration file
  (`getMigrationPlans`) applied before the new image starts. Otherwise `start()` throws
  `requires migrations` and the API's queue never starts. At the observed cadence (six schema
  versions in 40 days) a pinned `pg-boss` is the only sustainable policy: exact version,
  Renovate-ignored, bumped deliberately.

## What could not be established

- That `nest build` output and Vitest load `pg-boss` under `module: CommonJS`. This needs a spike.
- The exact privilege set `crm_app` needs on the `pgboss` schema. The docs do not list it; it would
  be derived from `dist/plans.js` and proven by a `crm_app` integration run.
- How `pg-boss` behaves when its supervise pass runs as a role that does not own the tables. Some
  maintenance statements may require ownership (for example `VACUUM` or `DROP` of a partition). It
  was not traced.
- Upstream changelog prose was not read. Facts come from the shipped code and the docs page.
