# ADR: Least-privileged database roles — the API stops connecting as the bootstrap role

## Status

Proposed (2026-10-17). Direction approved by the owner on 2026-10-17 ("do it the right way").

## Context

A security review of PR #1017 (vacancy-sourcing queue tables) found that the API connects as
`crm_user`, the bootstrap role that also applies DDL. On the scratch catalog `crm_user` has
`rolsuper = t`; production is unverified. Grants do not bind a superuser, and a superuser can
disable any trigger. TODO: expand.

## Decision

### 1. The role model

TODO

### 2. Privileges per role, per table class

TODO

### 3. The append-only audit log under the new model

TODO

### 4. Rollout without downtime

TODO

### 5. Impact on local development, CI and the integration-test guards

TODO

### 6. Relationship to the migration-ledger ADR

TODO

## Consequences

TODO

## Rollback

TODO

## Sources

TODO
