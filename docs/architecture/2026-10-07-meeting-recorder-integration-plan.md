# CRM ↔ Meeting Recorder Integration Plan

## Verified baseline and key decision

I double-checked this against the current heads before writing the plan:

- **CRM `main`**: `d14a3f73dcf00434fbf6238a350f0da6e78d31ca`
- **Extension `feat/external-integrations-module`**: `66e28e9f959e623d347a7c884206ecac1492d6ca`
- Current extension CI at that SHA is green.
- The extension currently accepts **HTTPS webhook endpoints only**.
- Its current V1 payload limit is **2 MiB**, request timeout **15 seconds**, automatic retry count **6**, and it already implements durable revisions/retries/supersession.
- The CRM still has one `interviews` row per recruiting process and no meeting/recording aggregate yet.
- The extension's folder presets already have **stable IDs**, and Drive history already persists `driveFolderPresetId`, which makes the folder-routing idea fit the current architecture very well.
- `recording.deleted.v1` exists in the TypeScript vocabulary but is not yet a complete sender contract/flow, so I do **not** make CRM deletion sync part of the first implementation.
- Current REVIEW behavior is not complete for later revisions, so the first CheekyCheese integration should use **AUTO through the “Save to” destination** or manual sending.

The key architectural decision for the two plans is **[Δ D46]** (revision 3):

```text
User picks a recording destination in "Save to"
at Start (remembered, confirmed when the recording ends)
"CheekyCheeseIT"
        │
        ├──── Storage subsystem
        │       └── media target: Local downloads (V1)
        │           later: CheekyCheeseIT itself (PLAN C)
        │
        └──── Integration subsystem
                └── routing intent written at Start,
                    released after the end confirmation
                        ↓
                   CheekyCheeseIT CRM
```

The destination is the **user-facing intent**, but storage and integration remain separate modules internally.

_Superseded (D46): revision 2 made a folder the intent, chosen at naming time and routed through a folder binding. A folder cannot describe a destination that owns the media itself (PLAN C), and the choice belongs before the meeting. The preset-ID bullet above stays true but no longer drives routing._

### Verification addendum (re-checked 2026-10-07)

**[Δ D01]** This revision re-checked every claim above against the code of both heads (CRM `d14a3f73`, extension `66e28e9f`), not against documentation. All baseline bullets above still hold. The facts below were missing from the first draft and change parts of the plan. Each change is marked inline with its `Δ` id and listed in the _Revision record_ at the end.

| #   | Verified fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Affects                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| F1  | No production code writes a `RecordingIntegrationIntent` today: `IntegrationRoutingRepository.put()` has no production caller. The planner and `BackgroundIntegrationRuntime.consider()` read intents, but nothing creates them.                                                                                                                                                                                                                                                                                                                     | E5, E8                     |
| F2  | `IntegrationDestination.routingDefault` is stored and displayed, but nothing turns it into routing intents, so a destination set to `auto` sends nothing automatically. ADR-0008 §16 (_materialize routing intent at recording start from destination defaults_) is designed but not implemented.                                                                                                                                                                                                                                                    | E8                         |
| F3  | Manual send (`SEND_RECORDING_TO_INTEGRATION`, planned by `planManual`) is one-shot: later local changes produce no further revisions without an AUTO intent (ADR-0008 §17).                                                                                                                                                                                                                                                                                                                                                                          | J4, J5                     |
| F4  | The `webhook-id` is `event_<uuid>` (`createIntegrationId('event')`) and equals the CloudEvent `id` (ADR-0008 §11). `source` is `urn:meeting-recorder:destination:<producerId>`, one `producer_<uuid>` per extension destination. `recording.id` and the `subject` suffix are the destination-scoped `externalRecordingId` (`recording_<uuid>`), never the local recording ID.                                                                                                                                                                        | Shared contract, C4        |
| F5  | The extension signs every attempt again with a fresh `webhook-timestamp` (same `webhook-id`, same body), times out after 15 s, and fetches with `redirect: 'manual'` and `credentials: 'omit'`.                                                                                                                                                                                                                                                                                                                                                      | C3, J7                     |
| F6  | Extension response classification (`classifyHttpFailure`): `408`, `425`, `429` and `5xx` → retrying; `3xx`, `400`, `401`, `403`, `410` and `413` → action-required; any other non-2xx → failed. At most 6 automatic attempts in total (the first send plus up to 5 retries, so the baseline's _retry count 6_ counts attempts), with full-jitter backoff capped at 30 s, 2 min, 10 min, 1 h, 6 h; a manual retry starts a fresh series; `Retry-After` is honored and clamped to 24 h; failed and action-required deliveries can be retried manually. | HTTP response contract, J6 |
| F7  | The 2 MiB cap counts UTF-8 bytes of the serialized body and is inclusive (`totalBytes <= 2 * 1024 * 1024`).                                                                                                                                                                                                                                                                                                                                                                                                                                          | C2, J10                    |
| F8  | Google Meet identity: `provider = 'google-meet'`, `meetingId` = last path segment of the Meet URL, `meetingUrl` with query and fragment stripped. Published meeting URLs are HTTPS-only; the receiver rejects non-HTTPS schemes before persistence/rendering. All three are absent when the destination policy has `meetingIdentity: false`.                                                                                                                                                                                                         | C6                         |
| F9  | `normalizeWebhookEndpoint()` requires `https:` and rejects URL credentials and fragments; it does not block private hosts or custom ports.                                                                                                                                                                                                                                                                                                                                                                                                           | Local HTTPS                |
| F10 | `standardwebhooks@1.1.1` verifies a string (a Buffer is decoded with `toString()`), hard-codes a 5-minute timestamp tolerance, throws `WebhookVerificationError`, and accepts several space-separated `v1,` signatures.                                                                                                                                                                                                                                                                                                                              | C3, contract tests         |
| F11 | CRM: interviews are hard-deleted (`InterviewsService.remove`) and would also be cascade-deleted with their senior's user row.                                                                                                                                                                                                                                                                                                                                                                                                                        | C1 Table 3                 |
| F12 | CRM: a SENIOR without an active team is denied every interview endpoint (`assertSeniorHasActiveTeam`), and `DROP` is a `role` value that `RolesGuard` rejects on the interviews controller.                                                                                                                                                                                                                                                                                                                                                          | C8                         |
| F13 | CRM: there is no Settings page; ADMIN-only screens live under `/admin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | C3, J0                     |
| F14 | CRM: production DDL ships as a manual SQL file in `apps/api/drizzle/manual/`, applied by the deploy workflow; `db:push` is a local tool and must never target the live `crm_db`. DevOps has wired `.github/workflows/deploy.yml` for the exact file `apps/api/drizzle/manual/2026-10-07_meeting_recorder_integration.sql`, and `docs/runbooks/deployment.md` mirrors the same filename.                                                                                                                                                              | C1, CRM delivery track     |
| F15 | CRM: the global `ZodExceptionFilter` answers `400` to any `ZodError`, which the extension classifies as action-required rather than as a contract failure.                                                                                                                                                                                                                                                                                                                                                                                           | C4                         |
| F16 | CRM: `PERSISTED_KEY_PREFIXES` is matched exactly against `queryKey[0]`, so `['interview-recordings', …]` is not persisted, but `['interviews', id, 'recordings']` would be.                                                                                                                                                                                                                                                                                                                                                                          | C8                         |
| F17 | CRM: production traffic passes Cloudflare and then nginx (`client_max_body_size 12m` on `/api/`) before it reaches the API.                                                                                                                                                                                                                                                                                                                                                                                                                          | J16                        |
| F18 | **[Δ D47]** The planner sends nothing until the recording is finalized (`isRecordingFinalized`: `RecordingContext.endedAt` is set), and the readiness deadline starts at the first consideration after that. An intent written at Start is therefore inert for the whole meeting.                                                                                                                                                                                                                                                                    | E5                         |
| F19 | The popup's _＋ Add destination…_ button has no handler yet. _Save to_ is `RecordingRunConfig.storageMode` (`'local'` or `'drive'`), read from the popup when Start is pressed; its initial value comes from the settings default `basic.recordingMode`.                                                                                                                                                                                                                                                                                             | E1, E4                     |
| F20 | Nothing removes a routing intent when a run is discarded or a recording is deleted: `IntegrationRoutingRepository.remove()` has no caller.                                                                                                                                                                                                                                                                                                                                                                                                           | E5                         |
| F21 | `ShareMediaSource` (`size`, `read(start, end, signal)`) and its resolver from a `PlaybackTrack` already read OPFS or Drive by byte range for sharing.                                                                                                                                                                                                                                                                                                                                                                                                | PLAN C                     |
| F22 | `ArtifactLocation` is `opfs`, `download` or `drive`, at most one replica per kind; `PlaybackSource` is `opfs`, `drive`, `remote` or `download`; the player already accepts a `refresh` function for expiring URLs.                                                                                                                                                                                                                                                                                                                                   | PLAN C                     |
| F23 | The Drive naming prompt opens only after the upload has finished (`job.status === 'completed'`), so a choice made there can only move files that are already in Drive.                                                                                                                                                                                                                                                                                                                                                                               | E7, PLAN C                 |
| F24 | OPFS is a retained media library (ADR-0006) and is never evicted automatically; a Downloads copy exposes no bytes to the extension.                                                                                                                                                                                                                                                                                                                                                                                                                  | PLAN C                     |
| F25 | Drive uploads run in the offscreen data plane (`UploadManager`); ADR-0008 §34 keeps only small webhook calls in the service worker.                                                                                                                                                                                                                                                                                                                                                                                                                  | PLAN C                     |
| F26 | CRM: `S3Service` uploads whole buffers and presigns GETs, with no multipart support, though `@aws-sdk/s3-request-presigner` is installed; `useDocumentBlob` downloads the whole file into a Blob.                                                                                                                                                                                                                                                                                                                                                    | PLAN C                     |
| F27 | CRM: the SPA's CSP (set in nginx) has no `media-src`, so it falls back to `default-src 'self'` and blocks a `<video>` served from R2; `connect-src` already allows `https://*.r2.cloudflarestorage.com`.                                                                                                                                                                                                                                                                                                                                             | PLAN C                     |
| F28 | R2 (Cloudflare documentation): parts 5 MiB–5 GiB, all parts except the last the same size, at most 10,000 parts, objects up to 4.995 TiB; unfinished multipart uploads are removed after 7 days by default; presigned URLs live from 1 s to 7 days; presigning `UploadPart` is not documented explicitly.                                                                                                                                                                                                                                            | PLAN C                     |
| F29 | Extension V1 schemas `docs/schemas/integration-recording-v1.schema.json` and `integration-recording-snapshot-cloudevent-v1.schema.json` set `additionalProperties: false` recursively. CRM V1 must reject unknown fields with `422`; additive evolution requires an explicit schema/contract revision.                                                                                                                                                                                                                                               | Shared contract, C4        |
| F30 | Published V1 keeps free-form recording content bounded by the inclusive 2 MiB UTF-8 envelope. The three identifiers persisted in PostgreSQL B-tree indexes — CloudEvent `id`, recording `id`, and `source.meetingId` — are protocol-bounded to 512 characters so a sender-valid event cannot exceed PostgreSQL index-entry limits.                                                                                                                                                                                                                   | Shared contract, C4        |
| F31 | The sender's V1 snapshot schema permits `artifacts[].viewUrl`. CRM must validate that field as part of the published input shape, then deliberately omit it from the persisted/exposed snapshot under C10 policy.                                                                                                                                                                                                                                                                                                                                    | C4, C10                    |
| F32 | Pairing is two-stage: the CRM connection is created first so it can expose a webhook URL; the extension-created `whsec_` is pasted afterwards, and `expected_source` becomes known only after the first successfully verified test/event.                                                                                                                                                                                                                                                                                                            | C1, C3                     |
| F33 | Credential encryption needs a neutral AES-256-GCM primitive parameterized by HKDF `info` and optional AAD. `CredentialsCryptoService` must be refactored through it without changing its current v2 token bytes, frozen `cheekycheese-credentials-v1` label, or v1 legacy decrypt behavior.                                                                                                                                                                                                                                                          | C1 secret storage          |
| F34 | Phase 1 is events-only: a valid test event returns `204`. The `200` capability response belongs only to future PLAN C / phase 2.                                                                                                                                                                                                                                                                                                                                                                                                                     | HTTP response contract, C5 |

---

## Shared contract between the two projects

Before discussing the individual plans, this is the interface both sides should agree on.

For V1 the CRM consumes:

```text
io.github.kstroevsky.meeting-recorder.integration.test.v1

io.github.kstroevsky.meeting-recorder.recording.ready.v1

io.github.kstroevsky.meeting-recorder.recording.updated.v1
```

over:

```http
POST /api/integrations/meeting-recorder/:connectionId/webhook

Content-Type: application/cloudevents+json

webhook-id: event_...
webhook-timestamp: ...
webhook-signature: v1,...
```

The body is the extension's current structured CloudEvent.

**[Δ D107]** The receiver contract is the published V1 schema, not a permissive approximation. The CRM mirrors `integration-recording-v1.schema.json` and `integration-recording-snapshot-cloudevent-v1.schema.json` with recursive strict-object semantics: every unknown field is a V1 contract violation and answers `422`. Forward-compatible additive fields require a new explicit schema/contract revision; V1 does not silently drop them.

**[Δ D108] [Δ D118]** The published V1 schemas do not impose per-field `maxLength`/`maxItems` bounds on free-form fields such as `provider`, `meetingUrl`, title, notes, transcript or analysis. Do not invent receiver-only truncation limits for those sender-valid values. The transport bound is the inclusive 2 MiB UTF-8 serialized envelope (F7). The exception is identifiers written to PostgreSQL B-tree indexes: CloudEvent `id`, recording `id`, and `source.meetingId` have the same published 512-character maximum in the extension JSON Schemas and CRM Zod schemas; the extension builder enforces it before delivery.

**[Δ D02]** The `webhook-id` header and the CloudEvent `id` carry the same value (`event_<uuid>`); the receiver rejects a request where they differ. `source` identifies one extension destination (`urn:meeting-recorder:destination:<producerId>`), and `recording.id` (the `subject` suffix after `recording/`) is a pseudonymous ID scoped to that destination. Deleting and re-creating the destination in the extension therefore yields a new `source` **and** new recording IDs, so the CRM sees re-sent recordings as new streams.

The CRM treats:

```text
CloudEvent source + recording.id
```

as the external recording stream identity, and:

```text
data.revision
```

as the monotonic version.

Receiver rules:

```text
new recording, revision 1
    → insert

known recording, revision > stored revision
    → replace current snapshot

revision <= stored revision
    → ignore and return 2xx

same webhook-id again
    → ignore and return 2xx
```

The CRM must never require `ready.v1` to arrive before `updated.v1`.

**[Δ D02]** Every `ready.v1` and `updated.v1` event carries the full current snapshot, never a diff. Revisions are monotonic per stream but may have gaps, because the extension supersedes a stale pending revision with a newer one. The first event the CRM sees for a stream can therefore be `updated.v1` with `revision > 1`; it is inserted exactly as `revision 1` would be.

The official Standard Webhooks JS/TS library is available as the `standardwebhooks` NPM package and verifies the original payload string/Buffer plus the three Standard Webhooks headers. I would use it rather than duplicate the verifier. [GitHub](https://github.com/standard-webhooks/standard-webhooks?utm_source=chatgpt.com)

**[Δ D02]** Add it as an exact-version dependency of `@crm/api` (`standardwebhooks@1.1.1`, verified in F10).

**[Δ D95] [Δ D113]** Record `standardwebhooks` as `1.1.1` EXACT in `.claude/rules/common/version-pins.md`, the project's single source for exact versions. Signature semantics are protocol-critical and this exact version was verified against the extension.

### HTTP response contract

**[Δ D03]** The CRM chooses status codes by how the extension's `classifyHttpFailure` treats them (F6), not by HTTP taste:

| Situation                                                                                               | CRM answers                              | Extension state                                |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Accepted: new stream, newer revision, stale or same revision, duplicate `webhook-id`, test event        | `204`                                    | delivered                                      |
| Test event, future phase 2 only when the service implements the media protocol (PLAN C)                 | `200` + capability document              | delivered; capabilities recorded               |
| Missing or repeated webhook headers, timestamp outside ±5 min, bad signature, unknown `connectionId`    | `401`                                    | action-required                                |
| Valid signature, but `source` differs from the connection's pinned source                               | `403`                                    | action-required                                |
| Valid signature, but the connection is disabled                                                         | `410`                                    | action-required                                |
| Body over 2 MiB                                                                                         | `413` (Fastify, before any handler code) | action-required                                |
| `Content-Type` is not `application/cloudevents+json`                                                    | `415`                                    | failed                                         |
| Valid signature, but the event breaks the V1 contract (schema, `webhook-id` ≠ `id`, unsupported `type`) | `422`                                    | failed; retried manually once the CRM is fixed |
| Rate limited                                                                                            | `429` with `Retry-After`                 | retrying                                       |
| Database or other server error                                                                          | `500` / `503`                            | retrying                                       |

Rules:

- The route never redirects: the extension fetches with `redirect: 'manual'`, so any `3xx` lands in action-required.
- An unknown `connectionId` gets exactly the bad-signature answer (`401`), so the endpoint reveals nothing about which connection IDs exist.
- Error bodies are `{ "code": "MEETING_RECORDER_…" }` and never echo request data.
- Duplicates, stale revisions and replays are successes (`204`), never `409`.
- **[Δ D48] [Δ D114]** Phase 1 is events-only, so its test endpoint always returns `204`. A future PLAN C / phase-2 implementation may change the test response to `200` with `Content-Type: application/json` and a capability document. Every non-test event still gets `204`.

---

## PLAN A — CheekyCheeseIT CRM

### CRM goal

Add a first-class consumer of meeting-recorder events without making the CRM's normal browser API the integration protocol.

The CRM should ultimately support this user flow:

```text
CRM Admin → Integrations
    ↓
Create "Meeting Recorder" connection
    ↓
CRM gives user webhook URL
    ↓
User connects that URL in extension
    ↓
Extension gives user signing secret
    ↓
User stores secret in CRM
    ↓
Test connection
    ↓
Connected
```

Thereafter:

```text
Google Meet interview
    ↓
extension recording
    ↓
"Save to: CheekyCheeseIT" picked at Start, confirmed at the end
    ↓
webhook
    ↓
CRM automatically matches Meet
    ↓
recording appears under interview
```

If matching fails:

```text
recording
    ↓
Unmatched recordings
    ↓
user links it once
```

Future updates then follow the link automatically.

**[Δ D49]** The destination is picked before the meeting and confirmed after it (PLAN B, E1 and E7).

---

### CRM Phase C1 — Integration domain and database

Do **not** add webhook state directly to `interviews`.

Create a dedicated module:

```text
apps/api/src/integrations/meeting-recorder/

  meeting-recorder.module.ts
  meeting-recorder.controller.ts
  meeting-recorder.service.ts

  meeting-recorder-webhook-parser.ts
  meeting-recorder-webhook-verifier.ts
  meeting-recorder-contract.ts
  meeting-recorder-matcher.ts
```

Register the module in `AppModule`.

**[Δ D04]** Alongside the module:

- shared Zod schemas and DTO types in `packages/shared/src/schemas/meeting-recorder.ts`, exported from `@crm/shared`, plus new `MEETING_RECORDER_*` codes in the shared API-error catalog;
- **[Δ D112]** one manual migration, exactly `apps/api/drizzle/manual/2026-10-07_meeting_recorder_integration.sql` (idempotent DDL, wired into `.github/workflows/deploy.yml` and mirrored in `docs/runbooks/deployment.md`), plus the matching tables in `schema.ts`; keep the workflow and runbook filenames synchronized;
- ADMIN-only connection management: `GET` and `POST /api/integrations/meeting-recorder/connections`, `PATCH .../connections/:id` (rename, enable, disable), `PUT .../connections/:id/secret` (replace the secret) and `POST .../connections/:id/reset-pairing`.

**[Δ D88]** Connection-management writes use the project's `@AdminWriteThrottle()`, and every security-relevant action is written to an audit table (Table 4).

#### Table 1: `meeting_recorder_connections`

Recommended shape:

```text
id uuid PK

name varchar

enabled boolean

signing_secret_ciphertext text nullable

expected_source varchar nullable

last_verified_at timestamp nullable
last_event_at timestamp nullable

created_by uuid nullable
created_at
updated_at
```

The endpoint can contain the opaque connection ID:

```text
/api/integrations/meeting-recorder/<connectionId>/webhook
```

The ID selects which signing secret to use.

The connection ID itself is **not authentication**.

Authentication is the Standard Webhooks signature.

**[Δ D04]** More rules for this table:

- **[Δ D111]** `signing_secret_ciphertext` and `expected_source` are nullable while unpaired. The connection must exist before a secret is available because its webhook URL is needed by the extension setup flow. After a secret is stored and the first signed test/event verifies, `expected_source` is pinned and becomes a mandatory post-pairing invariant (C3). Add `signing_secret_updated_at timestamp` for the last secret change.
- A connection that recordings reference is never hard-deleted (`interview_recordings.connection_id` is `ON DELETE RESTRICT`); it is disabled instead.
- Only ADMIN reads or changes connections. The secret is write-only: no endpoint ever returns it, and the UI shows only that it is set and when it last changed.

#### Secret storage

Do not store:

```text
whsec_...
```

in plaintext.

The CRM already has `CredentialsCryptoService` implementing AES-256-GCM using the existing `CREDENTIALS_ENC_KEY`, but the meeting-recorder integration must not call that domain service directly.

**[Δ D110]** Extract a neutral AES-256-GCM primitive parameterized by the HKDF `info` label and optional AAD, then refactor `CredentialsCryptoService` through that primitive. This refactor must preserve the existing credentials behavior exactly: current v2 ciphertext/token bytes stay byte-for-byte compatible, the credentials HKDF label remains frozen as `cheekycheese-credentials-v1`, and v1 legacy decrypt keeps working. The meeting-recorder wrapper uses its own HKDF label and the connection UUID as AAD.

**[Δ D05]** Two details the neutral primitive must get right:

- **Domain separation.** `CredentialsCryptoService` derives its key with HKDF-SHA-256 and the fixed `info` label `cheekycheese-credentials-v1`. The neutral primitive takes the label as a parameter, and webhook secrets use their own label (for example `cheekycheese-meeting-recorder-webhook-secret-v1`), so the same `CREDENTIALS_ENC_KEY` yields a different key. The existing credentials label and token format stay byte-for-byte unchanged.
- **Row binding.** Pass the connection `id` as AES-GCM additional authenticated data, so a ciphertext copied into another connection row fails to decrypt.

Validate a pasted secret before encrypting it: it must start with `whsec_` and base64-decode to 24–64 bytes, the extension's own bounds.

#### Table 2: `meeting_recorder_webhook_receipts`

```text
id

connection_id
webhook_id

event_type

received_at
```

Constraint:

```text
UNIQUE(connection_id, webhook_id)
```

This is the transport-level idempotency ledger.

Do **not** store the entire webhook body here.

**[Δ D06]** Correctness does not rest on this ledger alone: the revision guard (C5) already turns a replayed snapshot into a no-op. The ledger makes duplicates cheap to detect and visible, and it covers the test event, which has no revision. Index `received_at` and prune receipts older than 30 days in a scheduled job; pruning is safe at any age, because a replay that arrives after pruning is still harmless.

#### Table 3: `interview_recordings`

Start directly with this rather than forcing the whole future meeting-scheduling refactor:

```text
id uuid PK

interview_id uuid nullable
connection_id uuid not null

external_recording_id varchar not null

revision integer not null

title
started_at
ended_at
duration_ms

provider nullable
meeting_id nullable
meeting_url nullable

stage_at_link nullable

matched_by:
  meeting-id
  meeting-url
  manual
  unmatched

readiness jsonb

snapshot jsonb

created_at
updated_at
```

Constraints:

```text
UNIQUE(connection_id, external_recording_id)

revision > 0
```

Index:

```text
interview_id
connection_id
meeting_id
started_at
```

Use JSONB for the latest validated full V1 snapshot.

Do not immediately relationalize every transcript segment/topic.

**[Δ D07]** Amendments to this table:

- `matched_by` records how the **current link** was made: `meeting-id`, `meeting-url`, `manual`, or `unmatched`. The first draft's `external-id` value is dropped: finding an existing row by `connection_id + external_recording_id` is a lookup, not a way of linking, and an update keeps the row's `matched_by`.
- **Unmatched means `interview_id IS NULL`**; that column is the single source of truth. `interview_id` references `interviews` with `ON DELETE SET NULL`: deleting an interview (directly, or by cascade from its senior's user row) sends its recordings back to the unmatched inbox, instead of silently deleting transcripts or blocking the delete. A database `SET NULL` cannot reset `matched_by`, so readers never infer linkage from `matched_by` alone, and every API unlink path sets `matched_by = unmatched` and `stage_at_link = NULL` itself.
- `connection_id` references the connection with `ON DELETE RESTRICT`.
- Extra columns: `source varchar not null` (CloudEvent `source` of the last accepted event), `linked_by_user_id uuid nullable` and `linked_at timestamp nullable` (who linked manually, and when), and `last_event_at timestamp not null`.
- A partial index on `created_at` `WHERE interview_id IS NULL` serves the unmatched inbox.
- `snapshot` can approach 2 MiB, so list queries select summary columns only, never `snapshot`.

**[Δ D98]** Each accepted revision rewrites the whole JSONB snapshot, up to 2 MiB. The extension coalesces changes and skips identical projections, so revisions stay rare; watch table bloat in production rather than splitting the snapshot early.

#### Table 4: `meeting_recorder_audit_log`

**[Δ D88]** One row per security-relevant action, in the style of the existing user, team, project and transaction audit logs:

```text
id uuid PK

action:
  connection-created
  connection-renamed
  connection-enabled
  connection-disabled
  secret-replaced
  token-issued
  pairing-reset
  recording-linked
  recording-unlinked
  recording-purged
  media-purged

actor_user_id uuid nullable
connection_id uuid nullable
interview_recording_id uuid nullable

created_at
```

No payloads, secrets, titles or transcript text. A retention cron prunes it, modelled on `DocumentAccessLogRetentionCronService` (today the only audit-trail retention cron, 365 days; the other `*_audit_log` tables have none); the period is set together with decision O3.

---

### CRM Phase C2 — Exact raw-body receiver

The extension sends:

```text
application/cloudevents+json
```

The CRM currently has no parser for this media type.

Follow the existing CSP parser architecture.

Add something like:

```ts
registerMeetingRecorderContentTypeParser(app)
```

called from `main.ts`.

**[Δ D08]** It is also called from the receiver's integration spec, exactly like `registerCspReportContentTypeParser`, so the tests run the production parser. Match the media type with an optional parameter, as the CSP parser does: `/^application\/cloudevents\+json\s*(;.*)?$/i`.

It should use:

```ts
parseAs: 'string'
bodyLimit: 2 * 1024 * 1024
```

and return the **raw string**, not parsed JSON.

**[Δ D08]** Export the limit as `MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES = 2 * 1024 * 1024`. It must equal the extension's `INTEGRATION_MAX_PAYLOAD_BYTES`: both count UTF-8 bytes and both are inclusive (F7), so a body of exactly 2097152 bytes is accepted and one byte more is rejected with `413` before the handler runs.

Why?

Because Standard Webhooks verifies:

```text
webhook-id
+
webhook-timestamp
+
exact transmitted body
```

Parsing and reserializing JSON before verification is incorrect.

Flow:

```text
raw HTTP body
       ↓
Standard Webhooks verify
       ↓
JSON.parse()
       ↓
schema validation
       ↓
business service
```

This also fixes the current incompatibility:

```text
extension cap       2 MiB
nginx               12 MiB
Fastify default     ~1 MiB
```

The custom parser makes this route compatible with the sender without globally increasing API limits.

**[Δ D08]** A Fastify content-type parser is process-wide: any route that receives this media type gets a raw string of up to 2 MiB. Only the webhook route reads it, and the controller answers `415` when the body is not a string (another media type reached it).

---

### CRM Phase C3 — Authentication and connection setup

Controller:

```text
POST /api/integrations/meeting-recorder/:connectionId/webhook
```

should use:

```ts
@Public()
```

because this is not a browser-user JWT endpoint.

But that does **not** mean unauthenticated.

Request authentication is:

```text
connectionId
      ↓
load encrypted signing secret
      ↓
decrypt
      ↓
Standard Webhooks verify
```

**[Δ D09]** Run the checks from cheapest to most expensive and stop at the first failure:

1. exactly one value each for `webhook-id`, `webhook-timestamp` and `webhook-signature`, and the timestamp within ±5 minutes of server time; otherwise `401`;
2. load the connection by `connectionId`; unknown → `401`, the same answer as a bad signature;
3. if the connection has no signing secret yet, answer `401`; otherwise decrypt the secret and verify with `standardwebhooks`; verification failure also answers `401`;
4. connection disabled → `410`, only after a valid signature, so its state is never disclosed to strangers;
5. a source is already pinned and the event's `source` differs from it → `403`.

**[Δ D87]** Step 1, plus the check that `connectionId` is a UUID, runs in a Fastify `onRequest` hook registered in `main.ts` next to the content-type parser, acting only on the webhook path. `onRequest` runs before the body is read, unlike Nest guards: a request without valid webhook headers is rejected with `401` without buffering up to 2 MiB. The hook reads only headers and the path; the connection lookup and the signature check stay in the handler, once the raw body exists. If a Bearer header accompanies an event (phase 2), it must be valid: an invalid one gets `401` even with a valid signature.

For V1 I would **not require Bearer auth additionally**.

HMAC is sufficient.

The extension already supports Bearer/API-key auth, so it can be added later if wanted.

**[Δ D50]** The media protocol (PLAN C) changes this for media-capable connections: media calls go from the extension to the CRM, so such a connection also gets a Bearer token. The CRM generates it (32 random bytes, shown once), stores only its SHA-256 hash and compares in constant time; the `whsec_` secret stays encrypted, because verifying a signature needs the key itself. Webhook events keep the Standard Webhooks signature as their authentication; a Bearer header on them is accepted but not required.

Add a sensible dedicated rate limit, but don't use an extremely small public-form-style limit because normal retries and multiple recordings are legitimate.

**[Δ D09]** Concretely: `@RelaxableThrottle(MEETING_RECORDER_WEBHOOK_LIMIT, 60_000)` with `MEETING_RECORDER_WEBHOOK_LIMIT = 120` requests per minute (decision O6), tracked per client IP by the existing `UserAwareThrottlerGuard`, since the webhook carries no user. The throttler's `429` already sets `Retry-After`, which the extension honors.

**[Δ D09]** Never log the body, the secret, or `webhook-signature`. A rejection logs the connection ID and the response code only; a server error reaches `telemetry_errors` with a fixed message, as on the CSP endpoint.

**[Δ D09]** Browser CORS does not apply: the extension sends from its service worker under a granted host permission, so the CRM's CORS allowlist does not need the extension's origin. Gate J0 confirms this.

#### Connection setup UX

CRM admin/integration page:

**[Δ D10]** The page lives at `/admin/integrations` and is ADMIN-only (F13). The API returns the webhook _path_; the page shows `window.location.origin` plus that path, which in production reads `https://app.cheekycheese.tech/api/integrations/meeting-recorder/<id>/webhook` because nginx proxies `/api/` to the API. Actions: _Disable_ / _Enable_, _Replace secret_, _Reset pairing_. Status comes from `last_verified_at` and `last_event_at`. Every string goes through Lingui (`uk` default, `en`).

```text
MEETING RECORDER

Work recorder

Webhook URL
https://app.cheekycheese.tech/
api/integrations/meeting-recorder/<id>/webhook

[ Copy URL ]

Signing secret
[ Paste whsec_... here ]

Status
Waiting for connection test
```

Then the extension's `integration.test.v1` turns this into:

```text
✓ Connected
Last verified: now
```

On the first successfully verified event (the test event included), always persist:

```text
expected_source
```

and reject a later different `source` for the same connection unless the connection is reset.

That gives another binding layer beyond possession of the secret.

**[Δ D09] [Δ D111]** Pinning is mandatory after pairing (trust on first use), not a database `NOT NULL` invariant before pairing. Replacing the signing secret preserves `expected_source`; this supports secret rotation without changing producer identity. _Reset pairing_ (ADMIN) clears `expected_source`, `signing_secret_ciphertext` and `last_verified_at`, preserves the connection's `enabled` value, and requires a new secret. It is the documented path after the extension destination is deleted and re-created, which brings a new `source`, a new secret and new recording IDs (shared contract). A webhook received while the connection has no secret answers `401`.

---

### CRM Phase C4 — Contract validation

After signature verification, validate:

```text
specversion = 1.0

source starts with
urn:meeting-recorder:destination:

type is supported

subject starts with recording/

data.revision positive integer
```

For snapshot events validate the full V1 recording shape.

**[Δ D11]** More checks, all after the signature:

- the `webhook-id` header equals the CloudEvent `id`;
- `type` is exactly one of the three V1 strings in the shared contract, with no prefix matching;
- **[Δ D111]** if `expected_source` is already pinned, `source` must equal it (`403` otherwise, C3); when the pin is still `NULL`, the first successfully signature-verified and schema-valid test/snapshot event establishes it transactionally;
- snapshot events: `subject` equals `recording/` + `data.recording.id`; the test event: `subject` is `integration/test` and `data.test` is `true`;
- `time` is an ISO-8601 instant and `datacontenttype` is `application/json`.

**[Δ D107] [Δ D108] [Δ D109] [Δ D118]** Mirror the two published V1 schemas exactly, including recursive `additionalProperties: false`. Every content section (`note`, `notations`, `transcript`, `analysis`, `artifacts`) is optional because the sender's data policy may omit it, but present objects must match the published shape exactly. Unknown fields are rejected with `422`; additive evolution requires an explicit schema/contract revision. Free-form sender content has no receiver-only `maxLength`/`maxItems` rules and remains bounded by the inclusive 2 MiB UTF-8 envelope. The published contract itself caps the three B-tree-backed identifiers — CloudEvent `id`, recording `id`, and `source.meetingId` — at 512 characters. `artifacts[].viewUrl` is a valid published V1 input field and therefore must pass strict input validation when present; C10 then sanitizes it out before persistence/exposure. Contract failures answer `422`: catch the `ZodError` inside the webhook path, because the global `ZodExceptionFilter` would answer `400` (F15), which the extension treats as action-required.

Because the CRM already uses Zod extensively, a local Zod consumer schema is the natural implementation.

Do not trust fields because signature verification succeeded.

Signature means:

> trusted sender produced these bytes.

Schema validation means:

> the bytes represent a contract this CRM knows how to process.

These are different checks.

---

### CRM Phase C5 — Transactional ingest

For every verified request **[Δ D12]** claim first, then write conditionally; never check, then write:

```text
BEGIN

1. INSERT receipt (connection_id, webhook_id, event_type, received_at)
   ON CONFLICT DO NOTHING

2. nothing inserted?
      → duplicate → COMMIT → 204

3. SELECT the connection row FOR UPDATE; verify the authenticated secret epoch,
   then establish/verify the source pin
      → signing_secret_ciphertext differs from the ciphertext whose secret
        verified this request: ROLLBACK → 401
      → expected_source NULL: set it to this event's source
      → expected_source differs: ROLLBACK → 403

4. integration.test.v1?
      → set last_verified_at → COMMIT → 204

5. SELECT the row by (connection_id, external_recording_id) FOR UPDATE

6. row exists and stored revision >= incoming revision?
      → COMMIT (receipt kept) → 204

7. match:
      row exists and linked     → keep the link
      row exists and unmatched  → retry automatic matching (C6)
      no row                    → automatic matching (C6)

8. INSERT ... ON CONFLICT (connection_id, external_recording_id)
   DO UPDATE ... WHERE interview_recordings.revision < EXCLUDED.revision

9. set the connection's last_event_at

COMMIT

return 204
```

A concurrent request with the same `webhook-id` waits on the receipt's unique index until the first transaction ends, then inserts nothing and answers `204`. Two revisions racing to create the same new stream are settled by the conditional upsert in step 8. Two first-time events for an unpaired source serialize on the connection-row lock, so only one source can establish the pin.

**[Δ D103] [Δ D114]** Phase 1 keeps the test-event branch at `204`. Only future phase 2, after PLAN C is explicitly implemented, changes that branch to `200` with the capability document (shared contract, _HTTP response contract_).

_Superseded (D12): the first draft checked the receipt first and wrote it last, so two concurrent deliveries could both pass the check and one would then fail on the unique constraint with a 5xx._

Do not return an error for:

```text
duplicate webhook
old revision
same revision replay
```

Those are expected at-least-once delivery conditions.

---

### CRM Phase C6 — Meeting matching

Automatic matching order:

```text
1. Existing connection + externalRecordingId
      ↓
   existing row
      → update it

2. provider + meetingId exact match
      ↓
   derive comparable identity from interviews.callUrl

3. canonical meetingUrl exact match

4. exactly one result
      → attach

5. zero or multiple results
      → UNMATCHED
```

Never auto-match from:

```text
companyName similarity
recording title similarity
speaker names
time proximity alone
```

Those can become UI suggestions, but not automatic relationships.

**[Δ D13]** Matching details:

- Step 1 is a lookup, not a link: an update keeps the row's existing `interview_id` and `matched_by`.
- Google Meet comparison (F8): when `provider = 'google-meet'`, lower-case `meetingId` and compare it with the Meet code derived from `interviews.callUrl`: parse the URL, require host `meet.google.com`, take the last non-empty path segment, lower-case it. Step 3 compares canonical URLs (scheme `https`, lower-case host, no query, no fragment, no trailing slash).
- The candidate set is every interview, not scoped by RBAC: matching is a system action that shows nothing to anyone. A Meet room reused across several interviews (a recruiter's personal room) gives several results and stays unmatched, by design.
- An unmatched row is matched again on every newer accepted revision, because an interview's `callUrl` is often filled in after the call. A linked row is never re-matched.
- Auto-matching needs `meetingIdentity` in the extension's data policy; without it every recording arrives unmatched.
- Interviews are few, so a prefilter (`call_url ILIKE '%meet.google.com/%'`) plus exact parsing in code is enough; add an index only if measurements call for one.

#### Stage snapshot

At initial attachment store:

```text
stage_at_link
```

because the CRM card can later move:

```text
TECH_INTERVIEW
→ FINAL_INTERVIEW
→ CLIENT_INTERVIEW
```

while the recording remains historical.

`interviews.callUrl` is a matching hint, not historical truth.

---

### CRM Phase C7 — Unmatched recordings

Add:

```text
Interviews
    → Unmatched recordings
```

Example:

```text
UNMATCHED RECORDING

Candidate technical interview
Oct 7 · 52 minutes
Google Meet

Meeting:
meet.google.com/abc-defg-hij

Possible match:
Acme GmbH · TECH_INTERVIEW

[ Link to interview ]
```

Manual linking updates:

```text
interview_id
stage_at_link
matched_by = manual
```

Later webhook revisions find the row by:

```text
connection_id + external_recording_id
```

so they never need to match again.

**[Δ D14]** In V1 the inbox and its _Possible match_ hints are ADMIN-only. An unmatched recording belongs to no board, so the board-scoped HR rule cannot apply to it, and showing it to every HR would expose other teams' interviews (decision O1). Linking requires ADMIN plus ordinary update access to the target interview, and it writes `linked_by_user_id` and `linked_at`. ADMIN can also unlink (back to the inbox) and relink. _Possible match_ hints may use the company and time signals that C6 forbids for automatic linking; they stay hints.

---

### CRM Phase C8 — Recording APIs and RBAC

Do not add full recorder snapshots to:

```text
InterviewDto
```

The current CRM persists query keys starting with:

```text
interviews
```

to IndexedDB for 24 hours.

Putting transcripts into `InterviewDto` would unintentionally persist sensitive interview conversations in the browser cache.

Instead add:

```text
GET /api/interviews/:interviewId/recordings

GET /api/interview-recordings/:recordingId
```

In V1 (Gate J4 needs it):

```text
PATCH /api/interview-recordings/:id/link
```

for manual matching.

Use query keys such as:

```text
['interview-recordings', interviewId]

['interview-recording', id]
```

and **do not add them to `PERSISTED_KEY_PREFIXES`**.

**[Δ D15]** API rules:

- `GET /api/interviews/:interviewId/recordings` returns summaries only (title, times, provider, readiness, `matched_by`, revision), never `snapshot`; `GET /api/interview-recordings/:recordingId` returns the snapshot.
- Both answer `Cache-Control: no-store`.
- Authorization reuses the interviews module's own rules instead of re-deriving them: extract `getAccessibleSeniorIds`, `assertSeniorHasActiveTeam` and `assertUpdateAccess` into one interview-access policy that both modules call, and keep the controller-level `RolesGuard` set (ADMIN, SENIOR, HR).
- `PERSISTED_KEY_PREFIXES` matches `queryKey[0]` exactly (F16): keep `interview-recordings` and `interview-recording` as the first key element, never nest recordings under an `interviews` key, and add both names to the forbidden list of the existing persisted-key-prefixes test.

#### RBAC

A recording linked to an interview inherits that interview's access scope.

Do not invent:

```text
RecordingRole
TranscriptRole
```

separately.

Reuse the same effective rules:

```text
ADMIN
    all

SENIOR
    own board, only while in an active team

HR
    active team senior boards

JUNIOR
    no interview access

ACCOUNTANT
    no interview access

DROP
    no interview access
```

**[Δ D14]** Unmatched recordings are limited to ADMIN in V1 (C7, decision O1).

---

### CRM Phase C9 — UI

Interview detail:

```text
Acme GmbH
Technical Interview

RECORDINGS

Oct 7 · 52 min
Google Meet
Transcript ready
Analysis ready

[ Open ]
```

Recording detail:

```text
Technical interview
52 min · Oct 7

Transcript
────────────────────
...

Notes
────────────────────
08:14 Strong system design answer
22:03 Kubernetes weakness

Topics
────────────────────
React           12m
AWS              8m
PostgreSQL       6m
```

Human-entered CRM fields remain separate:

```text
notesTechStack
notesGeneral
...
```

Do not automatically overwrite them with analysis.

**[Δ D16]** UI rules:

- The recordings section lives in the existing `InterviewDetailSheet`; recording detail opens from there.
- The _Notes_ in the mock above are the payload's time-coded `notations`; the free-text `note` shows separately as _Recorder note_.
- Transcript, notes and topics render as plain text (React text nodes, never `dangerouslySetInnerHTML`). Speakers appear as names, as pseudonyms or not at all, following the sender's `transcriptSpeakers` policy.
- Pending readiness shows honestly (_Transcript pending_, _Analysis pending_) from `readiness.pending`.
- Every string goes through Lingui (`uk`, `en`); the design gate and the responsive gate apply (_CRM delivery track_).

**[Δ D97]** A transcript can come close to 2 MiB, thousands of segments. Render segments with `content-visibility: auto` first and measure; add a virtualization library only if measurements require one (the web app has none today). The detail response is gzip-compressed by nginx (`application/json` is in `gzip_types`).

Later a reviewed action could say:

```text
Suggested tech stack

React
AWS
Postgres

[ Apply to CRM notes ]
```

but that's another feature.

---

### CRM Phase C10 — Playback later

Do not make this part of initial CRM integration.

**[Δ D51]** _Initial_ means the events-only phase. CRM-owned video and its playback are PLAN C (phases M1–M6), and this section's rules still hold there: no Drive `webViewLink` export, and nothing ever creates a public share implicitly.

Current integration `artifactLinks` exports **Drive `webViewLink`**, not PR #21's published Sharing URL.

So V1 CRM policy should likely be:

```text
metadata             ✓
meetingIdentity      ✓
userNote             ✓
notations            ✓
transcript           ✓
analysis             ✓
artifactMetadata     ✓
transcriptSpeakers   names

artifactLinks        ✗
```

**[Δ D17] [Δ D109]** The field names now match `IntegrationDataPolicy` exactly; the first draft's _notes_ could mean either `userNote` or `notations`. The published V1 input schema legitimately permits `artifacts[].viewUrl`, so the receiver validates it as part of the strict signed input shape and only then deliberately removes it from the persisted/exposed CRM snapshot. Input-contract validation and storage minimization are separate stages.

Later the extension contract can explicitly expose:

```ts
playback?: {
  kind: 'published-share';
  viewUrl: string;
}
```

but only for an already explicitly published share.

The CRM integration must never implicitly publish one.

---

### CRM Phase C11 — Future meeting model

Eventually implement the CRM backlog:

```text
interviews
    ↓
interview_meetings
    ↓
interview_recordings
```

But **do not block V1 integration on it**.

Current V1 can safely be:

```text
interviews
    ↓
interview_recordings
```

because each recording retains:

```text
provider
meetingId
meetingUrl
startedAt
stageAtLink
```

Migration later is straightforward.

---

### CRM Phase C12 — Privacy, consent and retention

**[Δ D20]** Interview recordings and transcripts are personal data of candidates and interviewers. Before the first **production** connection is created:

- the `legal` agent reviews consent of all participants (who asks, and how it is evidenced), purpose, and the lawful basis for keeping transcripts in the CRM;
- retention is decided after this review (decision O3); until then nothing is purged automatically;
- deleting an interview returns its recordings to the unmatched inbox (decision O2, C1 Table 3).
- **[Δ D52]** with PLAN C, interview video joins the scope: the review covers video as personal data and how long it is kept (O3). **[Δ D86]** Where a media service stores video is that service's own decision (O9); for CheekyCheese the CRM's existing storage configuration decides, so the review looks at it as part of the CRM's own processing.

Development and joint testing use synthetic recordings only.

---

### CRM test gates

Before calling the receiver done, its own automated suite should cover:

```text
valid signed test event → 204

invalid signature → 401

tampered body → rejected

expired timestamp → rejected

missing webhook headers → rejected

application/cloudevents+json accepted

>1 MiB but <2 MiB accepted

body of exactly 2097152 bytes accepted; 2097153 bytes → 413

duplicate webhook-id → 204/no duplicate

revision 1 → stored

revision 2 → replaces revision 1

revision 1 after revision 2 → 204/no rollback

unknown type → 422

exact Meet URL → linked

ambiguous Meet URL → unmatched

missing meeting metadata → unmatched

manual link → future revisions stay linked
manual unlink → future revisions stay unmatched until an ADMIN links the recording again

HR allowed recording read

cross-team HR denied

SENIOR own board allowed

JUNIOR/DROP/ACCOUNTANT denied

transcript endpoint returns Cache-Control no-store where appropriate

recording query keys not persisted by frontend

[Δ D18]
unknown connectionId → 401, same as a bad signature
disabled connection + valid signature → 410
source differs from pinned source → 403
webhook-id header ≠ CloudEvent id → 422
wrong Content-Type → 415
route never answers 3xx
concurrent identical deliveries → 1 receipt, 1 row
concurrent revisions 2 and 3 → revision 3 stored
unmatched row + newer revision after callUrl was filled in → linked
interview deleted → its recordings unmatched, transcripts kept
HR cannot read unmatched recordings
SENIOR without an active team denied
list endpoint never returns snapshot
rate limit → 429 with Retry-After
pasted secret without whsec_ or outside 24–64 bytes → rejected
no API response ever contains the secret
extension fixtures accepted with the clock frozen at their timestamp
unknown field at any published V1 object level → 422
sender-valid long free-form strings/arrays with no published maxLength/maxItems → accepted while the serialized envelope is ≤ 2 MiB
CloudEvent id / recording id / meetingId length 512 → accepted; 513 → `422`
artifacts[].viewUrl in a valid fixture → accepted by input validation, absent from persisted/exposed snapshot
connection created without secret/source → management API succeeds; webhook → 401
replace secret → expected_source preserved
reset pairing → secret/source/last_verified_at cleared, enabled preserved; webhook → 401 until a new secret is stored
first valid snapshot event (without a prior test) → expected_source pinned and recording accepted

[Δ D104]
request without webhook headers and a 2 MiB body → 401 before the body is read
non-UUID connectionId → 401
valid signature + invalid Bearer header → 401
connection-management writes throttled (AdminWriteThrottle)
each audited action writes one meeting_recorder_audit_log row, without payload
```

---

### CRM delivery track

**[Δ D19]** How the CRM work moves through this repository's pipeline:

- **Track.** Full track. A new public endpoint, secret storage and RBAC over interview content are critical-path, so `security-reviewer` is mandatory on every PR that touches the receiver, the crypto extraction or the recording APIs.
- **Decomposition**, one task file each:
  1. schema, manual migration, shared Zod schemas and error codes;
  2. receiver (parser, verifier, ingest, test event) and the ADMIN connection endpoints (after 1);
  3. matching, recording APIs, link and unlink, interview-access extraction (after 2);
  4. ADMIN connection page (after 2);
  5. interview recordings section, recording detail, unmatched inbox (after 3);
  6. E2E specs for 4 and 5 (AutoTest).
- **UI gates** for 4 and 5: design gate (ui-ux-designer in the loop), responsive gate (mobile, tablet, laptop, large), Lingui `uk` + `en` reviewed by `copy-reviewer`, Playwright screenshots in the PR.
- **Data safety.** Integration specs and local runs use a scratch database (`DATABASE_URL` inline), never the live `crm_db`; production ships the exact manual migration `apps/api/drizzle/manual/2026-10-07_meeting_recorder_integration.sql`. `.github/workflows/deploy.yml` copies/applies that file, and `docs/runbooks/deployment.md` mirrors the same filename for deployment/rollback operations.
- **[Δ D115] Phase boundary.** This delivery track is events-only. Do not pull PLAN C media upload, video storage, playback, bearer-token media APIs or capability discovery into phase 1.
- **Merge** only on the owner's explicit "merge".

---

## PLAN B — Extension

### Extension goal

**[Δ D53]** Make the _Save to_ destination, picked when the recording starts, the user-facing routing mechanism, without merging storage and integration internals.

The user should experience:

```text
Before recording, Save to:
CheekyCheeseIT

        ↓

Files:
Local downloads (V1; later the CRM itself, PLAN C)

AND

Send structured data:
CheekyCheeseIT CRM
```

while architecture stays:

```text
RecordingDestinationProfile
   │
   ├── Storage module      (media target)
   │
   └── Integration module  (data routes)
             ↓
       RecordingIntegrationIntent, written at Start
             ↓
        Integration delivery, released after the end confirmation
```

_Superseded (D53): revision 2 routed by the folder chosen at naming time, through a folder binding._

---

### Extension Phase E1 — Recording destinations in “Save to”

**[Δ D54]** _Superseded: revision 2's `IntegrationFolderBinding` (a binding store keyed by folder preset, an IndexedDB upgrade, and binding settings on folders). Destination profiles picked at Start replace it, and nothing in the integration database changes for this phase._

Every _Save to_ entry is a recording destination profile. The type is the final one, so later phases add capabilities without migrating data:

```ts
type RecordingDestinationProfile = {
  id: string
  name: string

  mediaTarget:
    | {
        kind: 'drive'
        folderPresetId?: string
      }
    | {
        kind: 'local'
        folderPresetId?: string
      }
    | {
        kind: 'external'
        destinationId: string
      }

  dataRoutes: Array<{
    destinationId: string
    mode: 'auto' | 'review'
  }>
}
```

V1 (the events-only phase) allows exactly three shapes:

| Profile                                    | `mediaTarget`                                                                                  | `dataRoutes`                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| _Google Drive_ (built in)                  | `drive`, no preset                                                                             | none                              |
| _Local downloads_ (built in)               | `local`, no preset                                                                             | none                              |
| Integration profile, e.g. _CheekyCheeseIT_ | `local` (owner decision: local is the default media target for external integrations, for now) | exactly one route, `mode: 'auto'` |

Rules:

- Profiles live in extension settings (`chrome.storage`), next to the folder presets they may reference, and reference integration destinations by `IntegrationDestination.id`.
- `FolderPreset` stays `{ id, name }`; do not add integration fields to it. Folder presets remain storage-level concepts.
- The two built-in profiles reproduce today's `storageMode` values, so existing users see no change.
- `RecordingRunConfig` gains `destinationProfileId`; `storageMode` is derived from the profile's `mediaTarget` when Start is pressed (F19).
- The popup remembers the last pick (owner decision: remember + confirm). The pick is per recording and always visible (E3); it is not a destination-wide AUTO default (E8).
- **[Δ D119]** The popup's _Save to_ values are `drive`, `local` and `profile:<id>`. The run config always carries a profile ID, the built-ins included (`builtin:drive`, `builtin:local`); a Start without one records the built-in that matches `storageMode`. The remembered pick, built-ins included, is kept under its own `chrome.storage.local` key outside the settings object, so saving or resetting settings cannot clear it. Settings hold at most 20 profiles, and a stored profile that is not one of the V1 shapes is dropped when settings are read. An integration profile's local folder (`folderPresetId`) is optional.
- Later phases open the other shapes: Drive or local media together with data routes, several routes, `review` routes (E9) and `external` media (PLAN C).

The popup list:

```text
Save to  [ CheekyCheeseIT ▾ ]
┌──────────────────────────────────┐
│ Google Drive                     │
│ Local downloads                  │
│ CheekyCheeseIT                   │
│   Files: Local downloads         │
│   Data: CheekyCheeseIT CRM       │
│ ──────────────────────────────── │
│ ＋ Add destination…              │
└──────────────────────────────────┘
```

An integration profile whose destination is disabled, deleted or lacks its host permission stays in the list, cannot be picked, and offers _Fix connection_.

**[Δ D124]** In the popup the entry says why under its name (_Integration deleted · fix in Settings_, _Integration disabled · fix in Settings_, _Needs site access · fix in Settings_): a disabled option cannot carry an action, so _Fix connection_ is the settings page's _Destinations_ section.

---

### Extension Phase E2 — Destination lifecycle rules

**[Δ D55]** Profiles reference stable IDs (folder presets by `FolderPreset.id`, integration destinations by `IntegrationDestination.id`), never names.

_Superseded (D55): revision 2's folder-binding lifecycle (the binding sweep and route removal from bindings)._

Rules:

#### Destination renamed

Nothing else changes: the stable profile ID keeps the remembered pick and every intent attached.

#### Folder preset removed

A profile that referenced it falls back to the root of its storage (the Drive root folder or Downloads). Profiles live in settings and destinations in IndexedDB, so no single transaction covers both: resolve references when the popup lists profiles and when Start is pressed, and treat a missing destination as _unavailable_ rather than failing the recording.

#### Integration destination deleted

`IntegrationUnitOfWork.deleteDestination()` already removes the destination from routing intents and cancels unresolved deliveries. Profiles that route to it become unavailable in _Save to_, and a remembered pick of such a profile falls back to the default built-in profile. Once a destination holds media (PLAN C), deletion follows PLAN C's disconnect rules instead.

#### Destination edited

Edits (name, routes, data policy) affect **future recordings only**.

Do not mutate already-materialized recording intents: each keeps its own `allowedPolicy` and `connectionVersion` snapshot.

This preserves the existing privacy ceiling.

---

### Extension Phase E3 — Make the destination visible

**[Δ D56]** The pick decides what leaves the browser, so it is visible wherever it matters:

- **Before Start**: the _Save to_ trigger shows the profile name; integration profiles show their files target and data route on a second line (E1).
- **While recording**: the recording view shows a chip, `→ CheekyCheeseIT CRM`, under the timer.
- **At the end**: the save dialog shows _Will send to CheekyCheeseIT CRM ×_ (E7).
- **In Settings**: a _Destinations_ section lists the profiles with their files target and data routes, next to the existing _Google Drive_ folders section.

**[Δ D127]** The settings form never owns the profiles: saving or resetting it re-reads them from storage, so a profile added elsewhere while the page was open is not erased. The recording-view chip appears only for an integration profile; when the routes cannot be read it shows nothing rather than a false warning.

The CRM/webhook connectivity itself remains an Integration Destination.

So:

```text
RecordingDestinationProfile
    references
IntegrationDestination
```

not the other way around.

_Superseded (D56): revision 2's per-folder automation settings._

---

### Extension Phase E4 — Simplify integration setup

Current `IntegrationSettingsController` is developer-oriented.

Keep that functionality, but wrap it in a simpler wizard.

**[Δ D57]** The wizard opens from the popup's _＋ Add destination…_ (F19: the button exists but does nothing yet), in a full tab (the destinations section of `settings.html`), not inside the popup: Chrome closes a popup when focus moves to the host-permission prompt, and the user needs a stable page to copy the secret. The wizard ends by creating the integration destination **and** its _Save to_ profile (V1 shape: files to Local downloads, data to the new destination), so the new entry is in the popup list the next time it opens.

**[Δ D125]** The background's `CREATE_INTEGRATION` command creates the profile itself and returns it, so closing the page cannot lose it. If saving the profile fails, the integration stays, and the _Destinations_ section offers _Add destination_ for every integration without a profile (also the way to add one with a local folder). The _Destinations_ section sits above _Integrations_ and carries the `destinations` anchor.

For CheekyCheese:

```text
Connect destination

Name
[ CheekyCheeseIT CRM ]

Webhook URL
[ https://... ]

[ Connect ]
```

Chrome asks for access to that exact HTTPS host.

Then:

```text
Connected locally.

Copy this signing secret into CheekyCheeseIT:

whsec_...

[ Copy ]
```

Then:

```text
[Test connection]
```

After success:

```text
✓ CheekyCheeseIT CRM connected
```

Advanced settings can expose:

```text
data policy
request authentication
speaker privacy
payload preview
delivery details
```

but they should not dominate the normal setup.

---

### Extension Phase E5 — Recording start materializes routing

**[Δ D58]** This is the central implementation change.

_Superseded (D58): revision 2 wrote the routing intent when a recording was filed into a bound folder, after the meeting. The intent is now written when the recording starts, which is ADR-0008 §16's own materialization point._

When Start is pressed with an integration profile, the background start command (the same single message that starts capture) does this once it has assigned the recording's history ID:

```text
resolve profile
       ↓
for each data route:
  load current destination
       ↓
  snapshot:
    destination.dataPolicy
    destination.connectionVersion
       ↓
write RecordingIntegrationIntent
  + create the stream identity (externalRecordingId)
```

For AUTO:

```ts
{
  destinationId,
  mode: 'auto',
  state: 'selected',
  allowedPolicy: destination.dataPolicy,
  connectionVersion: destination.connectionVersion,
  releaseAfter: 'save-confirmed'
}
```

If the profile has no data routes (_Google Drive_, _Local downloads_): no routing intent.

Rules:

- **Inert during the meeting** (F18): the planner does nothing before the recording is finalized, and the readiness deadline starts only after that.
- **Held until confirmed.** `releaseAfter: 'save-confirmed'` is new. The planner treats the entry as inactive until the end dialog confirms (E7), which clears it; removing the route there sets `state: 'skipped'`. Nothing reaches a receiver before the user has confirmed: the _confirm_ half of "remember + confirm".
- **Discard and delete clean up** (F20): discarding the run, or deleting the recording before anything was sent, removes its routing intent and the unsent stream. **[Δ D123]** Removing a recording from the library also cancels its unresolved deliveries (`recording-removed`) when an earlier revision was already sent; a stream that was ever attempted is kept, so its identity is never reused, and telling the receiver stays E14's deletion event.
- **The stream identity is created with the intent**, so the first event and a later media upload (PLAN C) share one `externalRecordingId`.
- **Start never fails because of integration.** If writing the intent fails, capture still starts, and the recording view shows the E7 warning with _Retry automation_.
- **One message.** All of this runs inside the background start command, so a popup that closes right after Start cannot lose the intent.
- **[Δ D120]** **Kept and transactional.** The picked profile ID is stored in the recording's context (`RecordingContext.destinationProfileId`), so the end dialog, _Retry automation_ and the profile's folder (D122) resolve it later. Writing the intent is one IndexedDB transaction that re-reads each destination and merges with an existing intent, and the end confirmation is one transaction too, so a destination deleted or disabled in between is never written back.

The existing planner then takes over. After confirmation, the planner, readiness scheduler and dispatcher run unchanged; this is the first production writer of `RecordingIntegrationIntent` (F1). No new webhook path is needed.

---

### Extension Phase E6 — Add background commands

**[Δ D59]** Integration-owned operations for the destination flow:

```text
LIST_RECORDING_DESTINATIONS

SAVE_RECORDING_DESTINATION

REMOVE_RECORDING_DESTINATION

CONFIRM_RECORDING_ROUTES

RETRY_RECORDING_ROUTING

GET_RECORDING_ROUTES

LIST_HELD_RECORDING_ROUTES
```

`CONFIRM_RECORDING_ROUTES` carries the end dialog's answer (keep or remove each route); `RETRY_RECORDING_ROUTING` writes an intent that failed at Start. Profiles live in settings, but these commands belong to the integrations owner because they validate destination references.

**[Δ D118]** Implementation added two read commands: `GET_RECORDING_ROUTES` returns one recording's routes as the end dialog and the recording view show them (_held_, _released_, _skipped_ or _not scheduled_), and `LIST_HELD_RECORDING_ROUTES` returns the finished recordings whose routes still wait for an answer (E7). `GET_RECORDING_ROUTES` and `RETRY_RECORDING_ROUTING` without a recording ID mean the run in progress.

They belong to:

```text
PopupRouteOwner = integrations
```

not storage/system.

Storage says:

> recording files go here.

Integration says:

> this recording's data goes there, once confirmed.

_Superseded (D59): revision 2's folder-binding commands and its routing field on the filing command._

---

### Extension Phase E7 — Error semantics during naming

Do **not** wait for CRM HTTP delivery before closing the Save dialog.

**[Δ D60]** The end dialog is where the Start pick is confirmed:

```text
Name
[ Acme technical interview ]

Will send to CheekyCheeseIT CRM   ×

[ Save recording ]   [ Keep the default name ]
```

Answering the dialog durably commits two things: the files' delivery (Local downloads in V1) and the route confirmation (`CONFIRM_RECORDING_ROUTES`, which clears `releaseAfter`). Either button confirms (_Keep the default name_ only skips renaming); only _×_ removes the route, for this recording alone. While the dialog has not been answered (the popup was never opened), the route stays held.

**[Δ D121]** Only the two buttons are an answer; Escape and the backdrop leave the route held. The confirmation is sent only after the files step succeeded (the local file written, or the Drive name settled). The end dialog does not always appear for a local recording: its files are written at once when no local folder exists or no popup is open as they are saved, and when a dialog is left unanswered the 30-second delivery sweep writes them. Such a recording is asked about the next time the popup opens, only for its routes (_Confirm where this recording goes_, from `LIST_HELD_RECORDING_ROUTES`), once per opening. Until then it stays held: nothing is sent unconfirmed, and nothing is silently dropped.

After that:

```text
CRM delivery
```

is asynchronous and restart-safe.

Desired UX:

```text
Saved to CheekyCheeseIT

Files ✓
CRM  Sending…
```

not:

```text
Saving…
Saving…
Saving…
waiting on remote CRM…
```

**[Δ D131]** V1 keeps the rule (the dialog closes without waiting for the CRM) but defers the summary itself to E12: the popup has no notice surface yet. Until then, each integration's last delivery state is shown in Settings.

#### If saving the files fails

The route stays held: data is not released for a recording whose files were not saved. Saving again releases it, and the confirmation is idempotent.

_Superseded (D60): revision 2 skipped routing when Drive filing failed; routing no longer depends on filing._

#### If the routing intent could not be written at Start

This is rare but must be surfaced, during the recording and again in the end dialog:

```text
Recording for CheekyCheeseIT,
but automation could not be scheduled.

[ Retry automation ]
```

Do not silently pretend the CRM send was planned.

---

### Extension Phase E8 — Global AUTO should stop being the primary UX

Current `IntegrationDestination` has:

```text
routingDefault:
manual | auto | review
```

Keep it for migration/API compatibility initially.

But after folder bindings exist:

```text
folder binding
```

should be the primary automatic-routing mechanism.

New destinations should remain conservative:

```text
manual by default
```

Don't encourage:

```text
AUTO = every recording in the browser
```

as the normal user flow.

**[Δ D126]** Setup no longer offers a default routing: new integrations are created `manual`, and the integration list no longer shows the value. The field stays in storage and in the command input for compatibility, and it remains inert (F2).

Instead:

```text
CheekyCheeseIT folder
→ AUTO CRM

Therapy folder
→ REVIEW analyzer

Rest
→ nothing
```

This solves the original privacy concern naturally.

**[Δ D26]** Verified state (F2): `routingDefault` is stored and shown, but nothing turns it into routing intents, so a destination marked `auto` sends nothing today. Decision: do not implement global AUTO materialization. The settings UI stops offering `auto` and `review` as destination defaults, every destination behaves as `manual`, the field stays in storage for compatibility, and folder bindings are the only automatic routing. Gate J3 relies on this. The _Therapy → REVIEW analyzer_ example above applies once E9 is done.

**[Δ D61]** Since revision 3, _folder binding_ in this section reads _destination profile_ (E1): the profile is the primary automatic-routing mechanism. The remembered _Save to_ pick is not a destination default either: it is shown before Start, during the recording and in the end dialog, and confirmed per recording.

---

### Extension Phase E9 — REVIEW timing

Do not advertise full REVIEW behavior yet for this CRM flow.

The current planner explicitly supports first-snapshot approval but later-revision approval is still future work.

For the first CheekyCheese binding use:

```text
AUTO
```

or:

```text
no binding + manual Send
```

Once REVIEW later-revision approval is implemented, folder bindings can support it fully.

**[Δ D82]** Since revision 3, _binding_ in this section means a destination profile's data route (E1).

---

### Extension Phase E10 — Refiling after recording

**[Δ D62]** Folders no longer imply routing, so moving a recording between folders never sends anything.

Do **not** silently send the old recording to CRM just because its Drive folder changed.

Likewise moving it does not recall data already sent to CRM.

The UI should not imply that moving the Drive folder removes third-party copies.

Sending an older recording that was not routed at Start remains the manual _Send to…_ action, which is one-shot (F3).

_Superseded (D62): revision 2's refile dialog._

---

### Extension Phase E11 — Local folders

Support exactly the same mechanism for local folders.

**[Δ D63]** In V1, local storage is the media target of every integration profile (owner decision). The local save dialog keeps choosing the Downloads sub-folder, as today; the data route does not depend on that folder.

**[Δ D122]** A profile's local folder is the save dialog's starting choice, and where the files of a recording written without the dialog go, while that folder still exists; otherwise the download directory.

Example:

```text
Private AI

Local folder:
Downloads / Private AI

Automation:
localhost/private analyzer
```

However, current production webhook endpoints require HTTPS.

So until localhost HTTPS or LAN support is deliberately shipped:

```text
local folder
≠
HTTP localhost webhook
```

A local folder may still bind to any **HTTPS** destination.

The completed network spike found HTTP loopback technically possible under host access, but production intentionally still declares arbitrary HTTPS only.

Keep that boundary until a separate decision changes it.

---

### Extension Phase E12 — Recording status UI

Recording detail should eventually show both independent results:

```text
DESTINATION

CheekyCheeseIT

Storage
✓ Google Drive / CheekyCheeseIT

Automation
✓ CheekyCheeseIT CRM
Revision 2
```

Possible failure:

```text
Storage
✓ Drive

Automation
↻ CRM temporarily unavailable
Will retry automatically
```

Or:

```text
Automation
! Action required
Receiver rejected the request

[ Fix connection ]
```

Do not make integration failure turn the recording itself red/failed.

**[Δ D64]** In V1 an integration profile's storage line reads _Local downloads_; the Drive example above applies to the general profiles of M3 (PLAN C).

---

### Extension Phase E13 — Sharing remains separate

Choosing:

```text
CheekyCheeseIT
```

must not implicitly create a PR #21 share.

No call to:

```text
PUBLISH_SHARE
```

belongs in folder routing.

**[Δ D83]** Read _folder routing_ as _destination routing_ since revision 3. The same separation holds for PLAN C: a playback capability is private and short-lived, never a public share.

For now the CRM gets structured data.

Later, an explicit folder/profile option could be:

```text
Playback

○ Don't share recording
● Include existing published playback link
```

Eventually perhaps:

```text
○ Create a revocable playback link
```

but that needs explicit user consent.

---

### Extension Phase E14 — Deletion later

Do not block this integration on `recording.deleted.v1`.

The current branch doesn't yet expose a complete deletion-event sender flow.

When implemented later:

```text
remove local recording
        ↓
cancel unsent integration work
        ↓
if destination may already hold a copy:
recording.deleted.v1
```

Then add corresponding CRM support.

---

### Extension automated tests

**[Δ D65]** Add unit tests for:

```text
built-in profiles reproduce today's storageMode values
profile references survive renames (stable IDs)
missing folder preset → storage root; missing destination → profile unavailable
Start with an integration profile → intent with releaseAfter save-confirmed
Start with a built-in profile → no intent
allowedPolicy copied at Start
connectionVersion copied at Start
stream identity created with the intent
later destination policy expansion does not enlarge old intent
nothing planned before the recording is finalized
held route not released before confirmation
end dialog × → state skipped, nothing sent
discarded run → intent and unsent stream removed
intent write failure at Start → capture still starts, warning shown
remembered pick restored; unavailable pick falls back to the default
moving a recording between folders never routes
integration route failure does not mark recording failed
```

Add E2E:

```text
add destination from the popup
verify it appears in Save to

pick it, record
close the popup right after Start
stop, confirm in the end dialog
verify webhook sent

pick Google Drive, record
verify no intent, no webhook

record with the CRM picked, press × at the end
verify no webhook

delete integration
verify Save to no longer offers it
```

**[Δ D128]** The E2E drives the background through its runtime messages, as the existing integration specs do (`tests/e2e/integration-save-to.spec.ts`), and the integration CI job runs it next to the delivery spec; the popup and settings views are covered by unit tests. Added unit cases: Escape leaves the route held; a recording saved without the dialog is asked about later; a destination deleted during Start or confirmation is not written back; the profile's folder is preselected and used whenever no dialog asks.

---

## JOINT LOCAL TESTING PROTOCOL

This should be treated as a separate acceptance suite spanning both repos.

Because the extension currently requires **HTTPS**, do not plan the joint manual test around:

```text
http://localhost:3001
```

It will be rejected by `normalizeWebhookEndpoint()`.

Use HTTPS.

---

### Local environment

#### CRM

Current requirements:

```text
Node >=22.19 <23
pnpm 7.32.4
Docker
```

Start infrastructure:

```bash
docker compose up -d
```

Create the CRM API environment from:

```text
apps/api/.env.example
```

At minimum configure the existing dev values for:

```text
DATABASE_URL
REDIS_URL
JWT_SECRET
SESSION_SECRET
CREDENTIALS_ENC_KEY
```

**[Δ D30]** Point `DATABASE_URL` at a scratch database (for example `crm_recorder_test`), never the live `crm_db`, and confirm it with `SELECT current_database()` before the first command, because two Postgres servers can share port 5432 on the development machine. Pass it inline (`DATABASE_URL=... pnpm ...`), not with `export`.

After schema changes:

```bash
pnpm --filter @crm/api db:push
```

**[Δ D30]** `db:push` targets the scratch database only; production gets the manual SQL file (C1).

Then:

```bash
pnpm dev
```

or the repository's:

```bash
pnpm dev:start
```

for the full stack.

---

#### Extension

Current requirements:

```text
Node >=24
npm >=10
```

Install/build:

```bash
npm ci
npm run build
```

Then Chrome:

```text
chrome://extensions
→ Developer mode
→ Load unpacked
→ <repo>/dist
```

For a fast iterative loop:

```bash
npm run watch
```

and reload the unpacked extension after relevant rebuilds.

---

### HTTPS for the local CRM

There are two valid ways.

#### Option A — recommended for privacy: trusted local TLS

Use a local hostname such as:

```text
crm-recorder.local.test
```

mapped to:

```text
127.0.0.1
```

and a locally trusted development certificate using something like `mkcert`.

Run a reverse proxy:

```text
https://crm-recorder.local.test
       ↓
http://127.0.0.1:3001
```

The endpoint becomes:

```text
https://crm-recorder.local.test/
api/integrations/meeting-recorder/<connectionId>/webhook
```

Chrome must trust the certificate.

Do not use an untrusted/self-signed certificate; the extension intentionally does not bypass TLS errors.

**[Δ D31]** Simpler variant (F9: the extension accepts any HTTPS host and custom ports): run `mkcert -install` and `mkcert localhost`, then put a TLS reverse proxy (Caddy, for example) on `https://localhost:3443` in front of `http://127.0.0.1:3001`. No hosts-file entry is needed; Chrome asks for host permission on `https://localhost/*`.

#### Option B — HTTPS tunnel through a webhook-only proxy

Never expose local port `3001` directly. Non-production CRM enables development-only routes such as
`POST /api/auth/dev-login`; tunneling the whole API would make those routes reachable from the
public tunnel as well.

Instead, put a local reverse proxy in front of the API that accepts only:

```text
POST /api/integrations/meeting-recorder/<UUID>/webhook
```

and returns `404`/`403` for every other path and method. Tunnel that restricted proxy port:

```text
https://<temporary-host>/api/integrations/meeting-recorder/<UUID>/webhook
    ↓
webhook-only local proxy
    ↓
http://127.0.0.1:3001/api/integrations/meeting-recorder/<UUID>/webhook
```

Test transcript data still leaves the machine through the tunnel provider, so use only
synthetic/non-sensitive recordings. The webhook's Standard Webhooks signature remains mandatory;
the path restriction prevents the tunnel from becoming a public entrance to unrelated development
API routes.

---

### Joint Test 0 — Connection handshake

In CRM:

```text
Admin
→ Integrations
→ Meeting Recorder
→ New connection
```

Create:

```text
Local extension
```

Copy:

```text
https://.../api/integrations/meeting-recorder/<id>/webhook
```

In extension:

```text
Settings
→ Integrations
→ Add
```

Paste URL.

Use policy initially:

```text
metadata ✓
meetingIdentity ✓
userNote ✓
notations ✓
transcript ✓
analysis ✓
artifactMetadata ✓
artifactLinks ✗
transcriptSpeakers: names
```

Create.

Chrome asks for host permission.

Extension displays:

```text
whsec_...
```

Paste it back into CRM.

Click:

```text
Test
```

Expected:

```text
Extension:
✓ Connection test succeeded

CRM:
✓ Connected
lastVerifiedAt populated
```

**[Δ D32]** Also expected: the connection's `expected_source` is now pinned, and the request carried no CORS preflight (the CRM's CORS allowlist does not list the extension).

This is **Gate J0**.

Do not proceed until this works.

---

### Joint Test 1 — Destination in “Save to”

**[Δ D66]** In the popup: _＋ Add destination…_, then finish the wizard (J0 already connected the CRM, or connect it here).

Expected popup list:

```text
Google Drive
Local downloads
CheekyCheeseIT
  Files: Local downloads
  Data: CheekyCheeseIT CRM
```

Expected in _Settings → Destinations_: the same profile, with the CRM destination as its data route.

This is **Gate J1**.

_Superseded (D66): revision 2's folder-binding gate._

---

### Joint Test 2 — Exact Meet auto-match

Create a CRM interview:

```text
Company:
Integration Test Ltd

Stage:
TECH_INTERVIEW

callUrl:
https://meet.google.com/abc-defg-hij
```

Use that exact synthetic Meet URL/session for the extension recording where practical.

**[Δ D33]** Practical recipe: open `meet.new`, put that room's URL into the interview's `callUrl` before recording, and record a short synthetic conversation in that room. The destination policy must have `meetingIdentity` enabled.

**[Δ D67]** Before Start, pick _Save to: CheekyCheeseIT_. Record.

In the end dialog:

```text
Name:
Integration test interview

Will send to CheekyCheeseIT CRM   (kept)
```

Expected extension:

```text
Files saved to Local downloads

integration intent exists

recording.ready.v1 eventually delivered
```

Expected CRM:

```text
interview_recordings row created

interview_id automatically points to test interview

matched_by = meeting-id or meeting-url

revision = 1
```

UI:

```text
Integration Test Ltd

Recordings
Integration test interview
```

This is **Gate J2**.

---

### Joint Test 3 — Privacy test: a destination without the CRM

Record another call.

**[Δ D68]** Pick in _Save to_:

```text
Google Drive
```

Expected:

```text
Drive upload as today
```

and:

```text
NO CRM routing intent
NO webhook
NO CRM row
```

This is one of the most important acceptance tests.

It proves:

> choosing the destination controls external routing.

Evidence for _NO CRM routing intent_: no `routingIntents` row and no delivery row for this recording in the extension's `meeting-integrations` IndexedDB.

This is **Gate J3**.

---

### Joint Test 4 — Unmatched recording

Record a meeting whose URL is absent from CRM.

**[Δ D69]** Before Start, pick in _Save to_:

```text
CheekyCheeseIT
```

and keep the route in the end dialog. Expected:

```text
webhook succeeds
```

but CRM row:

```text
interview_id = null
matched_by = unmatched
```

UI:

```text
Unmatched recordings
1
```

Link manually to an interview.

**[Δ D35]** Link as ADMIN, because the inbox is ADMIN-only (D14). The note edit yields `updated.v1` only because this recording has an AUTO intent from its _Save to_ destination; a manual send is one-shot (F3).

Then modify the recording in the extension—for example change its note.

Expected:

```text
recording.updated.v1
revision 2
```

and CRM updates the already linked row without matching again.

This is **Gate J4**.

---

### Joint Test 5 — Revision semantics

Starting from a linked recording:

```text
revision 1
```

change something included in the policy:

```text
recording note
notation
analysis completion
```

Expected:

```text
revision 2
```

CRM:

```text
same interview_recordings.id
same external_recording_id

revision:
1 → 2

snapshot replaced
```

No duplicate recording.

This is **Gate J5**.

---

### Joint Test 6 — Receiver outage/retry

Stop the CRM API.

Create/send a CheekyCheese recording.

Expected extension:

```text
delivery retrying
```

Restart CRM.

Expected:

```text
delivery eventually succeeds
```

CRM contains exactly one recording.

No duplicate because of:

```text
webhook receipt
+
external recording revision
```

This validates the actual integration between CRM idempotency and extension retries.

**[Δ D36]** Keep the outage short, about a minute. Automatic retries are bounded (6 attempts with full jitter, F6); a delivery that exhausts them becomes _failed_, and the gate still passes if a manual retry then stores the recording exactly once.

This is **Gate J6**.

---

### Joint Test 7 — Browser restart recovery

With CRM unavailable:

```text
send recording
```

wait until delivery becomes:

```text
retrying
```

close Chrome completely.

Restart CRM.

Restart Chrome.

Expected:

```text
IntegrationScheduler reconstructs durable work

same eventId/body retry happens

CRM stores it once
```

**[Δ D36]** The retried request carries a new `webhook-timestamp` and signature with the same `webhook-id` and body (F5).

This is **Gate J7**.

---

### Joint Test 8 — Receiver duplicate

In CRM integration tests, or using a local capture/replay helper, send the same:

```text
webhook-id
body
headers
```

twice within the timestamp window.

Expected:

```text
204
204
```

Database:

```text
1 receipt
1 recording state
```

No 409.

This is **Gate J8**.

---

### Joint Test 9 — Out-of-order revisions

Receiver integration test:

```text
revision 2
then
revision 1
```

Expected final CRM state:

```text
revision = 2
```

Second request returns success but makes no downgrade.

This is **Gate J9**.

---

### Joint Test 10 — Payload boundary

CRM integration tests should send:

```text
~1.2 MiB valid CloudEvent
```

Expected:

```text
accepted
```

This specifically proves the old Fastify 1 MiB default problem is solved.

Then:

```text
>2 MiB
```

Expected:

```text
413
```

Extension behavior:

```text
action-required
not automatic endless retry
```

**[Δ D37]** Test the exact boundary: 2097152 bytes accepted, 2097153 bytes → `413`. The extension never sends an oversized body (its pre-send guard raises `IntegrationPayloadTooLargeError`), so the `413` path is a CRM-side test, and the extension's reaction to a `413` (action-required) is covered by its classifier tests.

This is **Gate J10**.

---

### Joint Test 11 — Destination rename

**[Δ D70]** Rename the _Save to_ destination:

```text
CheekyCheeseIT
```

to:

```text
Recruiting
```

without changing its profile ID.

Record again with _Save to: Recruiting_.

Expected:

```text
same CRM route still applies
the remembered pick shows the new name
```

This proves the correct identity is:

```text
RecordingDestinationProfile.id
```

not the destination name.

This is **Gate J11**.

---

### Joint Test 12 — Removal in the end dialog

**[Δ D71]** Record with _Save to: CheekyCheeseIT_. In the end dialog press _×_ on _Will send to CheekyCheeseIT CRM_, then save.

Expected:

```text
files saved to Local downloads
intent entry state = skipped
NO webhook
NO CRM row
```

Repeat without pressing _×_:

```text
CRM delivery planned
```

Also move an older recording between Drive folders and verify that nothing is sent (E10).

**[Δ D129]** Then record with _Save to: CheekyCheeseIT_ and close the popup before _Stop_; the files are written at once, without a dialog. Expected: NO webhook and NO CRM row until the popup is opened again and _Confirm where this recording goes_ is answered with a button; pressing Escape there sends nothing either.

This is **Gate J12**.

_Superseded (D71): revision 2's refile-dialog gate._

---

### Joint Test 13 — Integration deletion

Delete:

```text
CheekyCheeseIT CRM
```

Expected:

```text
integration credentials removed

Save to no longer offers CheekyCheeseIT; a remembered pick falls back to the default destination

pending deliveries canceled

folder itself remains

recordings remain

Drive files remain
```

Absolutely no storage deletion.

**[Δ D72]** The profile itself stays visible as _unavailable_ until the user removes it (E2).

**[Δ D39]** The CRM side is unaffected: the CRM connection stays until an ADMIN disables it, and sends from a re-created destination need _Reset pairing_ (C3).

This is **Gate J13**.

---

### Joint Test 14 — Sharing separation

Choose:

```text
CheekyCheeseIT
```

for a recording.

Expected:

```text
CRM event sent
```

but:

```text
no new PR #21 share
no PUBLISH_SHARE call
no public share URL
```

Then explicitly publish the recording using Sharing.

Expected:

```text
share created independently
```

No integration side effect unless a later explicit feature adds one.

This is **Gate J14**.

---

### Joint Test 15 — Generic/personal destination proof

This test matters because we don't want to accidentally build a CRM feature disguised as an integration framework.

Create another HTTPS receiver:

```text
Personal Journal
```

or n8n.

**[Δ D73]** Create a _Save to_ destination:

```text
Ideas
```

Its data route:

```text
Ideas
→ Personal Journal
```

Pick it and record:

```text
Ideas
```

Expected:

```text
same integration machinery
same CloudEvent
same signatures
same revisions
```

with **zero CheekyCheese-specific extension code**.

If this works, the architecture passes its most important design test.

This is **Gate J15**.

---

### Joint Test 16 — Production smoke through the real perimeter

**[Δ D40]** After the migration is deployed and the privacy review (C12) is done, and before any real interview is routed:

1. ADMIN creates a production connection for a test extension profile.
2. Run J0 against `https://app.cheekycheese.tech`.
3. **[Δ D74]** Record a short synthetic Meet call with _Save to: CheekyCheeseIT_ and confirm in the end dialog.

Expected: `204` from the API itself (not a Cloudflare challenge page, not an nginx `413`), the recording visible in the CRM, nothing new in `telemetry_errors`. Then disable the test connection or keep it as a canary.

This is **Gate J16**.

---

### Joint Test 17 — Discarded recording

**[Δ D75]** Record with _Save to: CheekyCheeseIT_, then discard the run.

Expected: no routing intent and no stream left in `meeting-integrations`, no webhook, no CRM row.

This is **Gate J17**.

---

### Joint Test 18 — Long meeting

Record with the CRM picked for longer than the readiness timeout (`INTEGRATION_READY_TIMEOUT_MS`).

Expected: nothing is sent while recording (F18); `ready.v1` arrives only after the end dialog is confirmed.

This is **Gate J18**.

---

### Local acceptance evidence — 2026-10-07

The phase-1 implementation is locally complete. The prescribed behaviors are covered by the following automated evidence; **J16 remains intentionally open because it can only be closed after the migration and privacy review reach the real production perimeter**.

| Gates                 | Automated evidence                                                                                                                                                                                                                                                                     | Result                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| J0                    | Extension setup/test-connection coverage plus `meeting-recorder-receiver.integration.spec.ts`, which ingests the extension-produced test fixture into real Postgres and asserts `expectedSource` pinning and `lastVerifiedAt`                                                          | Pass locally                |
| J1, J3, J12, J13, J14 | `tests/e2e/integration-save-to.spec.ts`: connected destination appears under _Save to_, built-ins create no route, end-dialog removal suppresses delivery, deleted integrations become unavailable, and a successful integration delivery creates no public-share publication          | Pass in Chromium            |
| J2, J4, J5, J8, J9    | `meeting-recorder-receiver.integration.spec.ts` against guarded Postgres 16 `crm_qa`: exact Meet auto-match, unmatched → manual link → revision 2 with link preserved, one stable row across revisions, duplicate receipt idempotency, and revision-2 → revision-1 downgrade rejection | Pass against real Postgres  |
| J6, J7                | `tests/e2e/integration-delivery.spec.ts`: 503/network retry, lost-response recovery, same event identity/body, Chrome restart recovery, fresh Standard Webhooks timestamp/signature; receiver idempotency is independently exercised against real Postgres                             | Pass in Chromium + Postgres |
| J10                   | `meeting-recorder-webhook-parser.spec.ts` pins 2,097,152-byte acceptance and 2,097,153-byte `413`; extension contract/planner/dispatcher tests cover pre-send size rejection and non-retryable/action-required handling                                                                | Pass locally                |
| J11                   | `RecordingDestinationsRuntime.test.ts` proves rename updates the display name while preserving the same profile ID and remembered selection                                                                                                                                            | Pass locally                |
| J15                   | The integration E2Es use arbitrary local HTTPS receiver destinations through the same generic destination, serializer, signer and delivery machinery; the integration implementation has no CheekyCheese-specific sender path                                                          | Pass locally                |
| J17                   | `RecordingController.destinations.test.ts` and routing-service coverage remove held routing on discard and cancel unsent work                                                                                                                                                          | Pass locally                |
| J18                   | `IntegrationEventPlanner.test.ts` proves no automatic readiness before finalization/while a route is held; `integration-save-to.spec.ts` proves no webhook leaves before end-dialog confirmation                                                                                       | Pass locally                |
| J16                   | Production Cloudflare/nginx smoke against `https://app.cheekycheese.tech`, after migration deployment and privacy review                                                                                                                                                               | **Pending production**      |

Security re-check on 2026-10-08 closed four implementation findings and one documentation hazard
before this evidence was finalized: manual ADMIN unlink now suppresses future automatic re-linking;
write-only signing secrets never enter TanStack mutation persistence; B-tree-backed sender
identifiers are bounded to 512 characters in both sender and receiver contracts, with the upper
bound exercised against real PostgreSQL; and meeting identity URLs are HTTPS-only before they can
be persisted or rendered as browser links. The development-tunnel instructions above were also
restricted to a webhook-only proxy so `/api/auth/dev-login` is never exposed by the documented
setup.

The scan's proposed connection-ownership restriction was re-checked against the accepted V1 trust
model and is intentionally not applied: an enabled recorder connection is an organization-wide
trusted producer, so exact Meet matching remains global while reads still pass through the
interview access policy. If recorder connections become team/owner-scoped later, matching must be
scoped at the same boundary.

The cross-repository fixture bridge below is also implemented. The extension fixture publication is commit `4431290cf215c4f76ef17dd22b0580493caa7eb1`; the CRM manifest pins that commit and the SHA-256 of every exact payload. The CRM test passes those unmodified bytes through the production raw-body parser, Standard Webhooks verifier and shared event schema, and proves a schema-valid byte tamper returns `401` at the verifier seam.

---

### Cross-repository contract tests

I would add a small explicit contract bridge between the repos.

Extension should generate checked fixtures using its real production serializer:

```text
fixtures/
  integration-test-v1.json
  recording-ready-v1.json
  recording-updated-v1.json
```

Also save:

```text
webhook-id
webhook-timestamp
webhook-signature
test whsec secret
```

for verification fixtures.

Then the CRM has contract tests that ingest those exact fixtures.

The important invariant is:

```text
fixture created by extension production serializer
               ↓
CRM production verifier/parser
               ↓
accepted without transformation
```

Do not manually maintain two unrelated example payloads.

**[Δ D41]** Mechanics:

- The extension repository owns a fixture generator that runs the production serializer and `signStandardWebhook` with a fixed test secret and fixed timestamps, plus a test that regenerates the fixtures and fails on any diff.
- The CRM vendors a copy under `apps/api/src/integrations/meeting-recorder/__fixtures__/` with a manifest recording the extension commit SHA and each file's SHA-256.
- The CRM contract tests freeze the clock at each fixture's `webhook-timestamp` (`standardwebhooks` hard-codes a 5-minute tolerance, F10), feed the exact bytes through the production parser, verifier and schema, and include one tampered fixture that must fail with `401`.

---

## PLAN C — External media storage (CRM-owned video)

**[Δ D76]** Phase 2. It starts once the events-only phase (PLANS A and B, gates J0–J18) is in production. Source: the owner's media proposal of 2026-10-07, checked against both codebases and Cloudflare's R2 documentation (F21–F28). Corrections are marked **Correction**.

### Why the existing player fits

The extension's player resolves each track to a URL and hands it to `<video>`; it does not care where the bytes live:

```text
Recording
   │
   ├── OPFS
   │      ↓
   │   object URL
   │
   ├── Drive
   │      ↓
   │   background authorizes access
   │      ↓
   │   temporary media URL
   │
   └── remote
          ↓
      HTTP media URL

              ↓
          <video src>
```

For CRM-owned media:

```text
Recording history
      │
      │ stable reference
      ▼
CheekyCheeseIT artifact
      │
      │ request playback capability
      ▼
CheekyCheese API
      │
      │ short-lived presigned GET
      ▼
Cloudflare R2
      │
      ▼
<video src="...">
```

The extension never persists a presigned URL; history persists a stable reference:

```ts
type ArtifactLocation =
  | ...
  | {
      kind: 'external';

      destinationId: string;
      artifactId: string;

      uploadedAt: number;
    };
```

No R2 object key, no bucket name, no presigned URL, no CRM-internal database ID.

**Correction:**

- The proposal named the first field `connectionId`. In the extension this is the `IntegrationDestination.id`, while the CRM uses _connection ID_ for its own UUID in the webhook URL; `destinationId` keeps the two apart.
- `ArtifactLocation` allows at most one replica per kind (F22). External replicas are keyed by `destinationId` instead (at most one per destination), so a CRM copy and a private-archive copy can coexist.

The extension keeps the library entry, title, transcript, notes, analysis and the destination reference; the media service owns the video bytes. Cloudflare R2 serves ranged `GetObject` requests, so native playback fetches only the ranges it needs.

### External Media Storage Protocol V1

A destination supports events, media, or both:

```text
n8n
    events ✓
    media  ✗

CheekyCheese
    events ✓
    media  ✓

Private archive server
    events optional
    media  ✓

Personal AI service
    events ✓
    media maybe
```

The extension gets no CheekyCheese-specific uploader or player (no `CheekyCheeseUploader.ts`, no `CheekyCheesePlayback.ts`). Paths below are relative to the capability document's `apiBase`.

**Create an upload**: `POST {apiBase}/v1/uploads`

```json
{
  "clientTransferId": "transfer_...",
  "recordingId": "recording_...",
  "artifact": {
    "role": "tab-recording",
    "filename": "technical-interview.webm",
    "mimeType": "video/webm",
    "bytes": 1482910042
  }
}
```

Response:

```json
{
  "artifactId": "media_...",
  "uploadId": "upload_...",
  "state": "uploading",
  "strategy": "multipart-put-v1",

  "partSize": 33554432,
  "maxConcurrency": 3
}
```

**Correction:** `recordingId` is the stream's `externalRecordingId` (`recording_<uuid>`), the same pseudonymous ID the CloudEvents carry as `recording.id`, so the service joins media to the recording without ever seeing a local ID; this is why E5 creates the stream identity at Start. `clientTransferId` makes _create_ idempotent: a repeated create while active gets the same `uploadId`. For an expired/aborted session, repeating create with the same `clientTransferId` returns a **new uploadId for the same artifactId**. For a completed artifact it returns `{ "artifactId": "media_...", "state": "ready" }`. Different immutable upload metadata for the same transfer ID is a `409`.

The service chooses the part size; the extension does not assume R2 or S3. **Correction (F28):** `partSize` is binding, not advisory: every part except the last is exactly `partSize` bytes, because R2 rejects uneven parts. The service picks it so that each part is at least 5 MiB and the upload needs at most 10,000 parts; 32 MiB covers recordings up to about 312 GiB.

**Get a part URL**: `POST {apiBase}/v1/uploads/<uploadId>/parts/17`

```json
{
  "method": "PUT",
  "url": "https://temporary-storage-url...",
  "headers": {},
  "expiresAt": "..."
}
```

The extension reads exactly that byte range, `PUT`s it directly to storage and records the returned `ETag`. Part URLs are never persisted; when one has expired (storage answers `403`), the extension asks for a new one.

**Resume**: `GET {apiBase}/v1/uploads/<uploadId>`

```json
{
  "state": "uploading",
  "artifactId": "media_...",

  "uploadedParts": [
    {
      "partNumber": 1,
      "etag": "..."
    },
    {
      "partNumber": 2,
      "etag": "..."
    }
  ]
}
```

After a browser restart, parts 1–16 stay uploaded and the transfer continues at part 17: no multi-gigabyte restart. The server reconciles the part list against storage's paginated ListParts, which is authoritative. **Correction (F28):** R2 removes unfinished multipart uploads after 7 days by default; an expired upload returns `410`, so the extension calls _create_ again with the same transfer ID and restarts from part 1 with a new upload ID and the **existing** artifact ID.

**Complete**: `POST {apiBase}/v1/uploads/<uploadId>/complete`, with the ordered, consecutive part ETags as the request body:

```json
{
  "parts": [
    { "partNumber": 1, "etag": "\"part-1-etag\"" },
    { "partNumber": 2, "etag": "\"part-2-etag\"" }
  ]
}
```

The backend checks every ETag against actual uploaded parts (ListParts) before completing. `ETag` is opaque, including its quotes; no reformatting is allowed. Response:

```json
{
  "artifactId": "media_...",
  "state": "ready"
}
```

Before answering `ready`, the service checks the stored object's size against the declared `bytes`. Completion is retriable after a lost response: persist a `completing` state, reconcile HEAD when the provider's multipart session disappears, and return the existing artifact in `ready` once HEAD verifies it. Only then does the extension persist `ArtifactLocation.external` as a playable location. The normative details are in the extension's `docs/adr/0009-external-media-storage-protocol-v1.md`.

**Playback capability**: `POST {apiBase}/v1/artifacts/<artifactId>/playback`

```json
{
  "url": "https://temporary-private-url...",
  "expiresAt": "..."
}
```

The URL is opaque to the extension: an R2 or S3 presigned GET, an authenticated CDN URL, a token URL on a private nginx. It must support HTTP Range requests.

**Errors**, all endpoints: `401` bad or missing credential; `403` the upload or artifact belongs to another connection; `404` unknown ID; `409` upload in the wrong state; `410` upload expired; `413` declared `bytes` above the service's limit; `422` invalid request. `429` and `5xx` are retried with backoff.

### Capability discovery

A plain webhook keeps answering the test event with `204`: an events-only destination. A media-capable service answers `200` with:

```json
{
  "protocol": "io.github.kstroevsky.meeting-recorder.service.v1",

  "capabilities": {
    "events": {
      "version": 1
    },

    "media": {
      "version": 1,
      "apiBase": "https://crm.example.com/api/integrations/meeting-recorder/media",

      "upload": {
        "strategy": "multipart-put-v1",
        "origins": ["https://<storage-origin>"]
      },

      "playback": {
        "strategy": "refreshable-url-v1"
      }
    }
  }
}
```

**Correction (security):**

- `apiBase` must share the origin of the configured webhook endpoint; otherwise the extension ignores the media capability, so the Bearer token never travels to an origin the user did not approve.
- `upload.origins` need Chrome host permission, requested with a visible prompt that names them. With it, the extension's `PUT`s are not subject to CORS and can read the `ETag` header.
- The document is read again on every _Test connection_; unknown capability versions are ignored, not rejected.
- **[Δ D91]** `upload.origins` entries must be exact origins (`https`, host, optional port) with no wildcard; any other entry makes the extension ignore the media capability. Every part URL must be `https:` on one of the granted origins, and every playback URL must be `https:`; anything else fails the transfer or the playback instead of being fetched.

### Authentication for media

Media calls go from the extension to the service, so a media-capable destination requires request authentication over HTTPS: Bearer (recommended for CheekyCheese) or API key. Webhook events additionally keep the Standard Webhooks signature. The CRM stores the Bearer token **hashed** and the `whsec_` secret **encrypted** (C3). A connection's credential reaches only the uploads and artifacts that connection created.

**[Δ D89]** Revocation and offboarding:

- A connection disabled in the CRM answers every media call with `410`, playback capabilities included, not only webhooks (C3). Disabling the connection of a recruiter who left stops their uploads and the extension-side playback of their uploads at once; CRM users keep seeing those recordings through interview RBAC.
- _Replace token_ (`PUT .../connections/:id/token`, ADMIN) issues a new Bearer token and invalidates the old one immediately; the extension then needs the new token, which is a connection change (ADR-0008 §20).
- Both actions are audited (Table 4).

**[Δ D92]** Media endpoints have their own limits, keyed by the token's connection rather than by IP: 600 requests per minute, at most 4 concurrent uploads per connection, plus decision O11's size limit and a per-connection storage quota set with it. A 2 GiB recording in 32 MiB parts needs about 70 calls.

### CheekyCheese as the reference media provider

Do not reuse the document pipeline: `S3Service` uploads whole buffers (F26), which suits 10 MB documents and not a 2 GB WebM. The CRM API is only the control plane:

```text
Extension                 CRM                  R2
    │                       │                   │
    │ create upload         │                   │
    ├──────────────────────►│                   │
    │                       │ create multipart  │
    │                       ├──────────────────►│
    │                       │                   │
    │ upload instructions   │                   │
    │◄──────────────────────┤                   │
    │                                           │
    │ PUT part 1 ──────────────────────────────►│
    │ PUT part 2 ──────────────────────────────►│
    │ PUT part 3 ──────────────────────────────►│
    │                                           │
    │ complete              │                   │
    ├──────────────────────►│                   │
    │                       │ complete multipart│
    │                       ├──────────────────►│
```

CRM and R2 credentials never reach the extension. Presigned URLs are temporary capabilities, treated like bearer tokens: never logged, never persisted.

Module:

```text
apps/api/src/integrations/meeting-recorder/media/

  recording-media-storage.service.ts
  recording-media-upload.service.ts
  recording-media.controller.ts
```

`recording-media-storage.service.ts` adds what `S3Service` lacks (`CreateMultipartUpload`, presigned `UploadPart`, `ListParts`, `CompleteMultipartUpload`, `AbortMultipartUpload`, presigned ranged `GetObject`), reusing the existing S3 client configuration. Video is not a CRM document.

Tables:

```text
recording_media_artifacts

id
connection_id
external_recording_id
role
mime_type
bytes
storage_key
status
created_at
completed_at
```

```text
recording_media_uploads

id
artifact_id
client_transfer_id
storage_upload_id
part_size
status
created_at
updated_at
```

**Correction:** artifacts carry `connection_id` + `external_recording_id` rather than a foreign key to `interview_recordings`: media can finish before the first event creates the recording row, and the two join when both exist. Add `UNIQUE(connection_id, client_transfer_id)` **to the artifacts table**, not to uploads. Every expired/aborted upload attempt requires a new upload row and `uploadId` for the same logical artifact and transfer ID. `storage_key` stays internal; the extension only ever sees `artifactId`.

**[Δ D90]** Input rules for _create_:

- `role` is one of `tab-recording`, `microphone-recording`, `self-video`. The base media type of `mimeType` (parameters such as `codecs` ignored) is one of `video/webm`, `video/mp4`, `audio/webm`, `audio/mp4`, the formats the extension records. Anything else gets `422`, and the object is stored with the allowlisted type.
- `filename` is metadata only: at most 255 characters, control characters stripped, never part of a storage key or an unescaped header.
- Storage keys are generated from IDs only: `meeting-recordings/<connectionId>/<artifactId>/<role>`.
- A repeated create with the same `clientTransferId` but different `artifact` fields gets `409`.
- Presigned GETs set `response-content-type` to the stored type and `response-content-disposition` to `inline`, without a filename.

**[Δ D94]** Never log a presigned URL, a token, a filename or a title. Map S3 client errors to fixed messages before they reach logs or `telemetry_errors`: their text can contain signed URLs.

**[Δ D99]** Storage isolation and cleanup. Recordings live under their own prefix, `meeting-recordings/`, in the CRM's bucket or a bucket of their own (the CRM's choice, decision O9). The prefix is **not** added to the managed prefixes of `DocumentsReconciliationService`, which would treat recording objects as orphaned documents. The media module reconciles its own prefix instead: it reports objects without a `ready` artifact row after a grace window, and aborts stale multipart uploads (`ListMultipartUploads`, `AbortMultipartUpload`), with R2's 7-day cleanup as the backstop. A purge (decision O3's tombstone) deletes the media objects too.

CRM playback:

```text
authenticated CRM user
        ↓
Interview RBAC
        ↓
GET recording playback capability
        ↓
presigned R2 GET
        ↓
<video src>
```

Do **not** use `useDocumentBlob()` for recordings: it downloads the whole file into a Blob first (F26). Use `<video src="presigned-url">` and let the browser issue Range requests. **Correction (F27):** add `media-src 'self' https://*.r2.cloudflarestorage.com` to the SPA's CSP in nginx, or the browser blocks the video. Playback follows the recording's interview scope (C8); unmatched recordings play for ADMIN only.

**[Δ D102]** The CRM-user endpoint is `POST /api/interview-recordings/:recordingId/media/:artifactId/playback`: JWT, the recording's interview scope, `Cache-Control: no-store`, answering `{ url, expiresAt }`. On the web it is called with the key `['interview-recording-playback', artifactId]`, which is never persisted.

### Extension data plane

**Extract `ShareMediaSource` into a neutral `ArtifactByteSource`** (F21); there is now a second consumer:

```text
src/media/ArtifactByteSource.ts
src/media/ArtifactByteSourceResolver.ts
```

```ts
export type ArtifactByteSource = {
  size: number

  read(start: number, end: number, signal?: AbortSignal): Promise<Blob>
}
```

```text
                      ArtifactByteSource
                      ▲                ▲
                      │                │
                Sharing          External upload
```

Sharing keeps working through the extracted abstraction. A recording whose only copy is in Downloads cannot be uploaded (F24); its transfer reports _Source not available_.

**Correction (F25):** transfers run in the offscreen data plane next to Drive uploads, not in the service worker, because a multi-gigabyte transfer outlives the service worker's request limits. Transfer state is durable (IndexedDB): `uploadId`, part size, completed part numbers and their ETags. Parts retry individually, transfers resume after a restart, concurrency is bounded by `maxConcurrency`, and no presigned URL is ever persisted.

**[Δ D96]** Memory ceiling. The extension accepts a `partSize` between 5 MiB and 256 MiB and keeps the bytes in flight (`partSize × concurrency`) at or below 256 MiB by lowering concurrency; a service asking for more gets _Unsupported upload parameters_ instead of an out-of-memory crash (R2 alone would allow 5 GiB parts). OPFS parts are file-backed `Blob` slices and cost no memory; Drive-sourced parts are downloaded into memory, which is why the ceiling exists.

**Playback.** `PlaybackSource` gains a stable external source:

```ts
{
  kind: 'external'
  destinationId: string
  artifactId: string
}
```

It is never turned into `{ kind: 'remote', url }` in the persisted manifest. The track resolver goes background → destination media client → playback capability → temporary URL, and returns `{ url, refresh }`. `PlayerController` already handles `refresh` (F22), so an expired URL is replaced and playback continues close to where it stopped.

### Destination profiles own the media target

Once a service owns the media, a folder cannot describe the destination; the profile from E1 can:

```text
Rest
  Media: Google Drive / Rest
  Send data: nothing

Therapy
  Media: Google Drive / Therapy
  Send data: Private analyzer

CheekyCheeseIT
  Media: CheekyCheeseIT
  Send data: CheekyCheeseIT
```

The user still just picks _Save to: CheekyCheeseIT_, and nobody has to think about R2, multipart uploads, webhooks or CloudEvents:

```text
Acme technical interview

Saving to CheekyCheeseIT…

Video       37%
Transcript  Ready
Analysis    Processing
```

then _Saved to CheekyCheeseIT ✓_ with _Play_.

### Choose before durable delivery

Today the Drive naming prompt opens only after the upload has finished (F23), so a destination chosen there can only move files that are already in Drive. CRM-owned media needs:

```text
Capture stops
      ↓
final media safely retained in OPFS
      ↓
Name + destination (the Start pick, confirmed)
      ↓
destination determines delivery
      │
      ├── Drive
      ├── Downloads
      └── External media service
```

OPFS becomes the staging layer (it is already a retained library, F24), and the destination is confirmed before durable external delivery. Because the destination was picked at Start (E1), the end dialog usually just confirms it.

**[Δ D93]** Privacy ceiling for media. Sending video to a third-party service is an export, exactly like events: the decision is captured in the intent at Start (from the profile's `mediaTarget`), held until the end confirmation (`releaseAfter`), and never added afterwards by a later profile edit. When a profile's media target and data route are the same service (_CheekyCheeseIT_), the end dialog shows one toggle for both, _Will send to CheekyCheeseIT ×_, so the CRM never receives video without its recording data, or the reverse.

**[Δ D100]** **Correction:** because the destination is picked at Start, the media target is known before capture ends. Drive and local delivery therefore start right after capture, as today, so a Drive user who never opens the popup is not left with recordings that never upload. Only delivery to a third-party service waits for the end confirmation, and M4 shrinks to _changing_ the destination in the end dialog before that delivery.

### Storage ownership rules

With the CRM as media owner, OPFS is the staging and recovery copy and the CRM the durable owner:

```text
capture
    ↓
OPFS complete
    ↓
CRM multipart upload
    ↓
CRM confirms complete
    ↓
external ArtifactLocation persisted
    ↓
verify playable/remote ready
    ↓
OPFS may be released
```

Never start an upload, delete OPFS and hope. If the upload fails:

```text
CheekyCheeseIT
Upload failed

Recording safely retained locally.

[ Retry ]
```

**Correction (F24):** OPFS copies are never evicted automatically today, so releasing one after a verified upload is a new, explicit step: keep the copy by default and offer _Free up space_ once the remote copy is verified playable (decision O10).

Later a profile may add a backup (_Primary media: CheekyCheeseIT_, _Backup: Google Drive_). Playback then prefers OPFS while it is retained, then the primary external owner, then the Drive backup.

### Disconnect and deletion semantics

Deleting an integration today removes its credentials. If 17 recordings exist only in CheekyCheeseIT, they would become unplayable from the extension. With external media, _Delete integration_ becomes:

```text
Disconnect CheekyCheeseIT?

17 recordings are stored there.

Disconnecting will not delete them from CheekyCheeseIT,
but they will no longer be playable from this extension.

[ Cancel ]
[ Disconnect ]
```

and _Disable automation_ (no future uploads or events, but the credentials needed to play existing recordings stay) is offered separately from _Disconnect service_.

Deletion is split the same way. _Remove from extension_ removes the local library entry and keeps the CRM recording; _Delete from CheekyCheeseIT too_ needs an explicit remote deletion capability, deferred together with `recording.deleted.v1` (E14). The CRM's own retention rules win (O3).

**Correction:** ship these semantics with M2, the first phase in which a recording plays from an external copy, not at the end of the rollout. A disconnect that strands recordings must be impossible before CRM-only storage (M5) exists.

### Rollout phases

| Phase  | Behaviour                                                                           | Why                                                                               |
| ------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **M1** | CRM receives an additional media replica                                            | Proves the media protocol, upload and playback without disturbing current storage |
| **M2** | Extension plays the CRM copy; safe disconnect and deletion semantics                | Proves remote playback and refresh; nothing can be stranded                       |
| **M3** | General destination profiles: Drive or local media with data routes, several routes | Unifies Drive, local and external UX                                              |
| **M4** | The end dialog can still change the destination before third-party delivery         | Lets the user override the Start pick; Drive and local delivery are not delayed   |
| **M5** | CRM-only storage supported                                                          | No mandatory second copy                                                          |
| **M6** | Publish the media protocol and a tiny reference receiver                            | Other systems implement the same capability                                       |

M1's second copy is transitional: the CheekyCheese end state is _extension index + CRM-owned media_, not two copies forever. **Correction:** in V1 the CheekyCheeseIT profile stores files in Local downloads (owner decision), so M1 uploads its replica from the retained OPFS copy, not from Drive; a recording whose only copy is in Downloads cannot replicate.

### Media release gates

Before production, on **real** R2 rather than mocks or a local S3 clone:

```text
real Chrome extension
     ↓
real presigned UploadPart
     ↓
real R2
     ↓
complete
     ↓
presigned ranged playback
```

Cloudflare does not document presigned `UploadPart` explicitly (F28), so this gate is mandatory. Media gates:

```text
JM0  test event → 200 + capability document; apiBase on the webhook origin; host permission granted for upload origins
JM1  the real-R2 run above passes
JM2  a ≥ 1 GiB synthetic recording uploads in parts of exactly partSize, the last part smaller
JM3  Chrome closed mid-upload → resumes at the first missing part
JM4  expired part URL → new URL requested, upload continues
JM5  expired upload → new upload from part 1, no duplicate artifact
JM6  extension playback with a short-lived URL → refreshed, continues near where it stopped
JM7  CRM playback in the browser: Range requests, no CSP violation
JM8  CRM RBAC: cross-team HR gets no playback capability; a connection cannot read another connection's artifact
JM9  disconnect dialog shows the right count; Disable automation keeps playback working
JM10 Remove from extension leaves the CRM recording and its media intact
JM11 OPFS released only after the remote copy is verified playable
JM12 the reference receiver (M6) passes JM0–JM6 with zero extension changes
JM13 connection disabled in the CRM → every media call 410, playback included
JM14 role or base mimeType outside the allowlist → 422; stored type never client-supplied
JM15 a filename with control characters or quotes never reaches a header or a storage key
JM16 partSize outside 5–256 MiB → Unsupported upload parameters, no crash
JM17 document orphan reconciliation never lists meeting-recordings/; media reconciliation aborts a stale multipart upload
JM18 media endpoints throttled per connection; a 5th concurrent upload is refused
JM19 same-service profile: one × in the end dialog stops both video and data
```

### Implementation order for phase 2

1. **Keep the structured webhook integration and the CRM receiver plan.** Nothing about the CloudEvents and Standard Webhooks work is invalidated.
2. **Extract `ShareMediaSource` into a neutral `ArtifactByteSource`.** Sharing keeps working through it.
3. **Define External Media Storage Protocol V1**: create, resume, part, complete and playback semantics, opaque artifact IDs, authentication, capability discovery. No R2 concept appears in the protocol.
4. **Implement CheekyCheese as the reference media provider**: multipart R2 upload, durable upload state, presigned playback, CRM RBAC playback, the CSP `media-src` change. Run the real-R2 gate before calling it done.
5. **Implement extension media transfers as a long-running data plane** in the offscreen document: durable state, part retries, resume, bounded concurrency, no persisted presigned URLs.
6. **Add `ArtifactLocation.external` and external playback resolution**, so a CRM-owned recording plays in the existing player exactly like a Drive one.
7. **Validate as an additional replica first** (M1), while the profile's own storage stays.
8. **Ship safe disconnect and deletion semantics** with M2. _(Moved up from the proposal's step 11.)_
9. **Generalize `RecordingDestinationProfile`** (M3): Drive and local presets are represented through it, and external services become real storage targets.
10. **Confirm the destination before third-party delivery** (M4): capture finalizes into OPFS, the Start pick is confirmed or changed, and only then does delivery to an external service begin; Drive and local delivery start right after capture, as today.
11. **Enable true CRM-owned mode** (M5): OPFS is staging and recovery only; Drive is not required.
12. **Publish the protocol and a tiny reference implementation** (M6), so another CRM, ATS, private server or personal archive can store video by implementing the same endpoints, without extension changes.

Once the media protocol is proven, the setup can become a one-time connection code: the CRM generates it, the user pastes it once into _＋ Add destination…_, and the extension receives the endpoint, a credential and the capabilities, then registers its signing secret back over the authenticated connection.

**[Δ D101]** Phase 2 runs on the same track as phase 1 (_CRM delivery track_): media endpoints, presigned URLs and token storage are critical-path, so `security-reviewer` is mandatory on those CRM PRs; the protocol ADR (decision O8) is written before step 3 starts; the extension work follows the extension repository's own review process.

### Phase 2 implementation reconciliation — 2026-10-09

**[Δ D132–D143]** This is the current PLAN C implementation contract after re-checking the extension at `6f2ba4f` and the CRM at `56820170` against the implementation and the continuation analysis in `docs/plans/2026-10-09-crm-media-continuation-plan.md`. Where an older PLAN C sentence conflicts with this section, this section wins. The real Chrome → CRM → R2 → CRM-browser gate is still required before M1/M2 are called production-proven.

- **[Δ D132] Start-time media authorization pins the storage perimeter.** A selected route snapshots `producerId`, webhook `endpoint`, media `apiBase`, `connectionVersion` and the exact ordered `upload.origins` list at recording Start. Resumed/reconciled work must match all of those values. A later profile/capability edit cannot expand historical media consent. Legacy intents that do not contain the pinned upload origins fail closed to data-only delivery. Bearer-token rotation is allowed because the secret itself is not persisted in the recording intent; the live grant must still match the pinned receiver identity.
- **[Δ D133] Durable transfer identity is separate from mutable history metadata.** One logical recording/file/destination authorization owns one random `clientTransferId`. The journal keeps the original upload request, OPFS source locator and receiver owner immutable across duplicate enqueue, rename, crash and retry. The upload byte count comes from the retained OPFS file at enqueue time rather than optional history metadata. A lost enqueue response returns the same transfer/request instead of creating another remote artifact.
- **[Δ D134] Ready-result replay is source-free.** After CRM has verified the object, the journal enters `verifying-capability`, then `ready-unacknowledged`. Playback-capability verification and replay of a completed result no longer require reopening the source bytes. The result remains durable until recording history has stored `ArtifactLocation.external` and explicitly acknowledges it; acknowledgement is tombstoned so a repeated reconciliation cannot create another artifact.
- **[Δ D135] Retry classification is code-aware.** Network `TypeError`, `429`, `5xx`, and the structured `409` code `MEDIA_UPLOAD_COMPLETING` are transient. Only that specific `409` receives completion retry/durable `retry-wait`; permanent conflicts such as `MEDIA_OBJECT_MISMATCH` do not. The client parses only a bounded `[A-Z0-9_]{1,128}` error code and otherwise treats HTTP status as authoritative for generic receivers. Signed-part `403`, and a storage-network failure that can represent an expired opaque presigned response, cause bounded re-signing; `410` retires the provider attempt and recreates it with the same logical transfer/artifact.
- **[Δ D136] The offscreen queue is the transfer owner.** Its persisted states are `queued/uploading/verifying-capability/retry-wait/action-required/ready-unacknowledged/acknowledged/canceled` (plus the legacy-compatible `pending`). It preserves active work across service-worker/browser recovery, holds critical work open while needed, performs bounded durable retries, exposes progress/retry state to the library UI and never persists Bearer credentials or presigned URLs.
- **[Δ D137] CRM create/complete concurrency is serialized around the connection.** Create/restart/quota checks take the connection row lock; the four-upload cap counts both live `uploading` attempts and recent `completing` attempts. Media request throttling uses one connection-wide bucket across handlers rather than a separate quota per route. A stale completion attempt cannot overwrite a newer attempt.
- **[Δ D138] Completion recovery has an explicit lease.** CRM can recover a lost `CompleteMultipartUpload` response by HEAD-verifying the expected object. While the completion lease is live it returns `MEDIA_UPLOAD_COMPLETING`; after the lease expires without a verified object, status returns `MEDIA_UPLOAD_EXPIRED` so the client can recreate the attempt. A missing provider multipart session also retires the DB attempt before idempotent recreation.
- **[Δ D139] CRM playback and extension authorization have different offboarding semantics.** Disabling a CRM connection revokes Bearer media control-plane calls and extension-side playback, while authenticated CRM users retain historical playback through interview RBAC. Extension _Disable automation_ stops future/pending exports while preserving credentials needed for existing extension playback; destructive _Disconnect service_ remains a separate user-confirmed action.
- **[Δ D140] The Phase-2 schema is part of deployment, not an out-of-band prerequisite.** `apps/api/drizzle/manual/2026-10-08_meeting_recorder_media.sql` is required, copied and applied by the production deployment before the media API is deployed, and the DDL wiring checker covers it. The receiver PostgreSQL integration guard asserts the Phase-2 media columns as part of its test precondition.
- **[Δ D141] Media cleanup is conservative and converges provider/DB state.** The media reconciler aborts stale multipart sessions only after claiming the corresponding stale DB attempt, skips live/recent/ready work, and separately reports completed orphan-object candidates after a grace period. Completed-orphan reporting is redacted (hashed object reference plus size/time) and does not automatically delete those objects.
- **[Δ D142] Provisioning/playback UX was tightened.** ADMIN can issue the one-time media token; replacing an existing token requires destructive confirmation because the old token is revoked immediately. CRM exposes ready media descriptors through typed schemas/client calls. Browser playback uses native ranged media, refreshes expiring capabilities, and the production CSP allowlists only `self` plus `https://*.r2.cloudflarestorage.com` for media; the API Helmet policy carries the same narrow media source while nginx remains the SPA policy boundary.
- **[Δ D143] Remote-ready is not release-ready.** A successful HEAD plus issued playback capability proves storage/provider readiness but does not prove actual browser playback, seeking, refresh or auxiliary tracks. R0 therefore remains the real private-R2 pilot (JM0–JM10 and JM13–JM19 as applicable), with no local source release. Explicit _Free up space_ is R1 and is enabled only after real remote playback has been verified and release/recovery journaling is proven. M3–M6 follow only after those M1/M2 gates.

### End state

```text
SAVE TO

Rest
  Google Drive

Therapy
  Google Drive
  Private analyzer

CheekyCheeseIT
  Video owned by CheekyCheeseIT
  Transcript → CheekyCheeseIT
  Notes → CheekyCheeseIT
  Analysis → CheekyCheeseIT

Personal Archive
  Video owned by my server
```

```text
                     Recording
                         │
                  retained staging
                      OPFS
                         │
                 destination profile
                         │
       ┌─────────────────┼──────────────────┐
       │                 │                  │
       ▼                 ▼                  ▼
     Drive             Local          External Media
                                           │
                                  generic Media Protocol
                                           │
                         ┌─────────────────┼──────────────┐
                         ▼                 ▼              ▼
                   CheekyCheese       another CRM    private server
                         │
                         ▼
                    R2 / S3 / etc.
```

Playback goes through the same player:

```text
recording
   ↓
resolve best playable source
   ↓
OPFS / Drive / external capability
   ↓
native <video>
```

External media storage is a generic storage capability, not a CheekyCheese feature, and once a service owns media the user-facing abstraction is the recording destination, not the folder.

Sources (checked 2026-10-07): [R2 multipart objects](https://developers.cloudflare.com/r2/objects/multipart-objects/), [R2 upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/), [R2 limits](https://developers.cloudflare.com/r2/platform/limits/), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

---

## Decisions

**[Δ D21]** The plan proceeds on each recommendation below until the owner answers. None of them blocks the first PRs.

**[Δ D84]** Owner answers, 2026-10-07: O1–O8 and O10–O13 are accepted as recommended (O5 stays obsolete); O9 is decided differently, see its row. References elsewhere to these items now point to decisions.

| #   | Question                                                         | Recommendation                                                                                                                                                                                                                                | Reversible?                      |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| O1  | Who sees the unmatched inbox?                                    | ADMIN only in V1; later scope it to the connection's owner.                                                                                                                                                                                   | Yes                              |
| O2  | What happens to recordings when an interview is deleted?         | They return to the unmatched inbox (`ON DELETE SET NULL`); the alternative, cascade delete, destroys transcripts.                                                                                                                             | The default is; a cascade is not |
| O3  | How long are transcripts kept, and how are they purged?          | Decide after the legal review. Implement purge as a tombstone (snapshot cleared, row kept), so a later revision is acknowledged and discarded instead of re-creating the recording.                                                           | No: deletion is final            |
| O4  | One connection per recruiter?                                    | One connection per extension installation, named after its owner; `created_by` stays informational in V1.                                                                                                                                     | Yes                              |
| O5  | Refile dialog default                                            | **[Δ D77]** Obsolete since revision 3: moving files never routes (D62).                                                                                                                                                                       | —                                |
| O6  | Webhook rate limit                                               | 120 requests per minute per client IP.                                                                                                                                                                                                        | Yes                              |
| O7  | Speaker names in CRM transcripts                                 | `names` if the legal review agrees; otherwise `pseudonyms`.                                                                                                                                                                                   | Yes, for future revisions        |
| O8  | How to record the destination decision in the extension          | Amend ADR-0008: §16's materialization at Start stands; add destination profiles, the remembered pick with end confirmation (`releaseAfter`), and local media for integration profiles in V1. Record the media protocol (PLAN C) as a new ADR. | Yes                              |
| O9  | Where does the R2 bucket for interview video live?               | **Owner decision:** it depends only on the integrated system. The protocol says nothing about storage location: each media service decides for itself, and for CheekyCheese the CRM's existing storage configuration decides.                 | —                                |
| O10 | When may the extension release its OPFS copy after a CRM upload? | Keep it by default; offer _Free up space_ once the remote copy is verified playable.                                                                                                                                                          | Yes                              |
| O11 | Largest recording the CRM accepts                                | Decide together with storage cost; the protocol's `413` covers the limit.                                                                                                                                                                     | Yes                              |
| O12 | Lifetime of presigned URLs                                       | Part PUT 15 minutes, playback 30 minutes, both refreshed on demand.                                                                                                                                                                           | Yes                              |
| O13 | Does skipping the end dialog release the route?                  | Either button confirms; only _×_ removes the route; an unanswered dialog keeps it held (E7). **[Δ D121]** Escape is not an answer, and a recording saved without the dialog is asked about when the popup next opens.                         | Yes                              |

---

## Recommended implementation order across both repositories

I would interleave the work rather than finish one project completely first.

| Step | Extension                                                 | CRM                                                | Joint gate     |
| ---- | --------------------------------------------------------- | -------------------------------------------------- | -------------- |
| 0    | ADR-0008 amendment (O8)                                   | Owner answers O1–O7 or accepts the recommendations | —              |
| 1    | No change                                                 | Connection + DB schema                             | —              |
| 2    | Existing test event                                       | Raw parser + verifier                              | J0             |
| 3    | Existing manual send                                      | Ingest + idempotency + revision                    | manual payload |
| 4    | Destination profiles + _＋ Add destination…_ wizard       | Matching                                           | J1/J2          |
| 5    | Routing intent at Start, held until confirmed             | Unmatched storage                                  | J3/J4          |
| 6    | Existing updates/retries                                  | Recording UI/API                                   | J5             |
| 7    | Scheduler already exists                                  | Receiver restart-safe behavior                     | J6/J7          |
| 8    | End-dialog confirmation and removal                       | —                                                  | J12            |
| 9    | Profile fallback on destination deletion; discard cleanup | —                                                  | J13/J17        |
| 10   | —                                                         | Full RBAC/privacy review                           | security gate  |
| 10a  | —                                                         | Privacy and legal review (C12)                     | legal gate     |
| 11   | Generic personal receiver                                 | —                                                  | J15            |
| 12   | Later playback contract                                   | Later viewer link                                  | future         |
| 13   | Test extension profile                                    | Production connection                              | J16            |
| 14   | PLAN C, phase 2 (its own order)                           | Reference media provider                           | JM0–JM12       |

**[Δ D42]** Rows 0, 10a and 13 are new. Row 13 comes before any real interview is routed, not after the deferred row 12.

**[Δ D78]** Rows 4, 5, 8 and 9 now describe the destination flow; row 14 is new.

---

## Things I would explicitly _not_ implement in this pass

On the extension side:

```text
CheekyCheese-specific transport
CRM interview IDs in generic payload
global mapping language
automatic public share creation
media upload to CRM (phase 2: PLAN C)
HTTP localhost support
full REVIEW-later-revision behavior
recording.deleted until sender flow is implemented
global AUTO materialization from routingDefault
signing-secret rotation without re-creating the destination
folder bindings (a folder that routes to a destination)
Drive media together with a data route in one profile (M3)
several data routes per profile (M3)
```

On the CRM side:

```text
full interview_meetings scheduling redesign
video storage (phase 2: PLAN C)
AI → notes automatic overwrites
browser JWT auth for webhook
full webhook-body archive
transcript inside InterviewDto
public playback through raw Drive links
HR- or owner-scoped unmatched inbox
automatic purge or retention jobs before decision O3
re-matching when an interview's callUrl changes
accepting two secrets during a rotation window
```

**[Δ D43]** The last two lines of each list are new deferrals.

**[Δ D79]** _This pass_ is the events-only phase: media upload and video storage are planned as phase 2 (PLAN C). Folder bindings and the general profile shapes are new deferrals.

Those would expand the scope without helping the first useful integration.

---

## Final architecture after both plans

The final system should look like this:

```text
                       USER
                        │
     picks "CheekyCheeseIT" in Save to at Start
                        │
                        ▼
          RecordingDestinationProfile.id
                        │
          ┌─────────────┴─────────────┐
          │                           │
          ▼                           ▼
   STORAGE DOMAIN              INTEGRATION DOMAIN
          │                           │
   media target                  data routes
          │                           │
          ▼                           ▼
Local downloads (V1)        RecordingIntegrationIntent
CRM-owned (PLAN C)          held until confirmed
                                  │
                                  ▼
                         IntegrationEventPlanner
                                  │
                                  ▼
                           durable delivery
                                  │
                                  ▼
                     Standard Webhooks + CloudEvent
                                  │
                                  ▼
                    CheekyCheese CRM receiver
                                  │
                     ┌────────────┴────────────┐
                     ▼                         ▼
              exact Meet match             unmatched
                     │                         │
                     ▼                         ▼
                Interview               manual linking
                     │
                     ▼
          transcript / notes / topics
```

And separately:

```text
Recording
    │
    └── explicit user Share action
              ↓
         PR #21 Sharing
              ↓
       public/revocable viewer
```

No hidden connection between those paths.

**[Δ D44]** The diagram now uses the real type name, `RecordingIntegrationIntent`.

After the double-check, this is the implementation direction I would choose. **[Δ D80]** Choosing the destination at Start returns to ADR-0008 §16's own materialization point rather than breaking the ADR: it gives the integration subsystem an explicit, visible source of user intent before the meeting, confirmed after it, while preserving all the reliability/privacy machinery that is already implemented.

## Revision record

**[Δ D45]** Revision 2 (2026-10-07) is the pasted first draft plus the changes below, applied as patches. Heading levels were normalized first (no text changed). Nothing else in the first draft was altered.

| Δ   | Section               | Change                                                                                                                           |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| D01 | Verified baseline     | Verification addendum: facts F1–F17 from the code of both heads                                                                  |
| D02 | Shared contract       | `webhook-id` = CloudEvent `id` = `event_…`; destination-scoped identities; full-state revisions with gaps; exact-version library |
| D03 | Shared contract       | HTTP response contract mapped to the extension's classifier                                                                      |
| D04 | C1, Table 1           | Shared schemas, manual migration, ADMIN connection endpoints; pinned source; no hard delete; write-only secret                   |
| D05 | Secret storage        | HKDF domain separation, connection ID as AAD, secret format validation                                                           |
| D06 | Table 2               | Receipts are not the only guard; 30-day pruning                                                                                  |
| D07 | Table 3               | `external-id` dropped from `matched_by`; unmatched ⇔ `interview_id IS NULL`; FK behavior; extra columns; inbox index             |
| D08 | C2                    | Parser registered in tests too; media-type regex; exact inclusive byte limit; process-wide parser                                |
| D09 | C3                    | Ordered checks; unknown connection = `401`; rate limit 120/min; mandatory source pinning; logging; CORS                          |
| D10 | CRM goal, C3 UX       | `/admin/integrations` instead of a non-existent Settings page                                                                    |
| D11 | C4                    | `webhook-id` = `id`, exact types, subject rules, sender bounds, `422` mapping                                                    |
| D12 | C5                    | Race-safe claim-then-conditional-upsert (supersedes check-then-write)                                                            |
| D13 | C6                    | Meet-code derivation, unscoped candidate set, re-match while unmatched                                                           |
| D14 | C7, C8                | ADMIN-only unmatched inbox; link endpoint in V1                                                                                  |
| D15 | C8                    | Summary vs detail endpoints, `no-store`, shared access policy, exact persistence rule; teamless SENIOR                           |
| D16 | C9                    | Placement, notes vs notations, plain-text rendering, readiness, i18n and design gates                                            |
| D17 | C10                   | Exact data-policy field names; `viewUrl` dropped                                                                                 |
| D18 | CRM test gates        | Exact codes and boundary; 17 new cases                                                                                           |
| D19 | CRM delivery track    | Track, decomposition, UI and data-safety gates                                                                                   |
| D20 | C12 (new)             | Privacy, consent and retention gate before production                                                                            |
| D21 | Open decisions (new)  | O1–O8 with recommendations                                                                                                       |
| D22 | E1                    | Compound key path, upgrade test, `review` hidden                                                                                 |
| D23 | E2                    | Orphan sweep across storage and IndexedDB; `deleteDestination()` details                                                         |
| D24 | E5                    | Materialize in the background filing command; additive; first writer; ADR amendment                                              |
| D25 | E6                    | `MATERIALIZE_…` only for _Retry automation_                                                                                      |
| D26 | E8                    | `routingDefault` is inert today; no global AUTO                                                                                  |
| D27 | E10                   | No preselected option; dialog placement; `routing` field                                                                         |
| D28 | E7                    | Filing retry re-runs idempotent materialization                                                                                  |
| D29 | Extension tests       | New unit and E2E cases                                                                                                           |
| D30 | Local environment     | Scratch database; `db:push` scope                                                                                                |
| D31 | HTTPS option A        | `localhost` variant with mkcert                                                                                                  |
| D32 | J0                    | Admin path, exact policy names, pinned source, no preflight                                                                      |
| D33 | J2                    | `meet.new` recipe                                                                                                                |
| D34 | J3                    | Precondition and evidence                                                                                                        |
| D35 | J4                    | ADMIN links; why `updated.v1` happens                                                                                            |
| D36 | J6, J7                | Bounded retries; re-signed retries                                                                                               |
| D37 | J10                   | Exact boundary; where the `413` path is tested                                                                                   |
| D38 | J12                   | No preselected option                                                                                                            |
| D39 | J13                   | Binding route removal; CRM side unaffected                                                                                       |
| D40 | J16 (new)             | Production smoke through Cloudflare and nginx                                                                                    |
| D41 | Contract tests        | Generator, vendored fixtures with provenance, frozen clock, tampered case                                                        |
| D42 | Implementation order  | Rows 0, 10a, 13                                                                                                                  |
| D43 | Not in this pass      | New deferrals                                                                                                                    |
| D44 | Final architecture    | Real type name `RecordingIntegrationIntent`                                                                                      |
| D45 | Revision record (new) | This table                                                                                                                       |

**[Δ D81]** Revision 3 (2026-10-07). The owner moved the destination choice to the start of the recording (_＋ Add destination…_ in _Save to_), chose local files for integration destinations for now and _remember + confirm_, and proposed CRM-owned video. Revision 3 is revision 2 plus the changes below. Revision-2 changes D22–D25, D27–D29 and D38 are superseded by D54–D62, D65 and D71.

| Δ   | Section                | Change                                                                                   |
| --- | ---------------------- | ---------------------------------------------------------------------------------------- |
| D46 | Verified baseline      | Key decision: destination picked in _Save to_ at Start; folder intent superseded         |
| D47 | Verification addendum  | Facts F18–F28                                                                            |
| D48 | HTTP response contract | Test event may answer `200` + capability document                                        |
| D49 | CRM goal               | Runtime flow starts from the _Save to_ pick                                              |
| D50 | C3                     | Bearer token for media calls, stored hashed                                              |
| D51 | C10                    | Pointer to PLAN C                                                                        |
| D52 | C12                    | Video and bucket location in the privacy review                                          |
| D53 | Extension goal         | Destination profiles instead of folders                                                  |
| D54 | E1                     | `RecordingDestinationProfile`, V1 shapes, popup list; folder bindings superseded         |
| D55 | E2                     | Destination lifecycle rules                                                              |
| D56 | E3                     | Visibility before, during and after recording                                            |
| D57 | E4                     | Wizard opens from _＋ Add destination…_ in a full tab                                    |
| D58 | E5                     | Intent written at Start, held until confirmed; discard cleanup; stream identity at Start |
| D59 | E6                     | New commands                                                                             |
| D60 | E7                     | End dialog confirms or removes the route                                                 |
| D61 | E8                     | The remembered pick is not a global default                                              |
| D62 | E10                    | Refile dialog superseded                                                                 |
| D63 | E11                    | Local files for integration profiles                                                     |
| D64 | E12                    | Storage line in V1                                                                       |
| D65 | Extension tests        | New unit and E2E cases                                                                   |
| D66 | J1                     | Destination in _Save to_                                                                 |
| D67 | J2                     | Pick at Start, confirm at the end                                                        |
| D68 | J3                     | Privacy test with a destination without the CRM                                          |
| D69 | J4                     | Pick at Start                                                                            |
| D70 | J11                    | Destination rename                                                                       |
| D71 | J12                    | Removal in the end dialog                                                                |
| D72 | J13                    | Profile fallback                                                                         |
| D73 | J15                    | Generic destination profile                                                              |
| D74 | J16                    | _Save to_ wording                                                                        |
| D75 | J17, J18 (new)         | Discarded recording; long meeting                                                        |
| D76 | PLAN C (new)           | External media storage: protocol, CRM provider, data plane, phases M1–M6, gates JM0–JM12 |
| D77 | Open decisions         | O5 obsolete, O8 amended, O9–O13 new                                                      |
| D78 | Implementation order   | Rows 4, 5, 8, 9 rewritten; row 14 new                                                    |
| D79 | Not in this pass       | Phase-2 pointers; new deferrals                                                          |
| D80 | Final architecture     | Diagram and closing statement follow the destination model                               |
| D81 | Revision record        | This table                                                                               |
| D82 | E9                     | _Binding_ now means a profile's data route                                               |
| D83 | E13                    | Destination routing; playback capabilities are never shares                              |

**[Δ D106]** Revision 4 (2026-10-07): the owner accepted the recommendations except O9 (storage location belongs to the integrated system) and asked for a security, performance and architecture audit. Revision 4 is revision 3 plus:

| Δ    | Section                         | Change                                                                                                             |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D84  | Decisions                       | Owner answers recorded; O9 decided as _the integrated system's concern_                                            |
| D85  | C3, C7, C8, C12, PLAN C         | _Open decision_ references now name decisions                                                                      |
| D86  | C12                             | Storage location follows O9                                                                                        |
| D87  | C3                              | Header and timestamp prechecks before the body is read; invalid Bearer rejected                                    |
| D88  | C1, Table 4 (new)               | Admin write throttle; audit log table                                                                              |
| D89  | PLAN C authentication           | Disabled connection revokes media and playback; token replacement; offboarding                                     |
| D90  | PLAN C provider                 | Role and MIME allowlists, filename rules, ID-only storage keys, `409` on conflicting create, safe response headers |
| D91  | PLAN C capability discovery     | Exact upload origins; HTTPS and origin checks on part and playback URLs                                            |
| D92  | PLAN C authentication           | Per-connection rate limit, concurrent-upload cap, quota                                                            |
| D93  | PLAN C delivery                 | Video export follows the same intent, hold and privacy ceiling as events; one toggle for a same-service profile    |
| D94  | PLAN C provider                 | No secrets, URLs, filenames or titles in logs; S3 errors mapped                                                    |
| D95  | Shared contract                 | Version pin recorded in the project's pin file                                                                     |
| D96  | PLAN C data plane               | Part-size range and in-flight memory ceiling                                                                       |
| D97  | C9                              | Transcript rendering performance; gzip verified                                                                    |
| D98  | Table 3                         | Snapshot write amplification accepted and watched                                                                  |
| D99  | PLAN C provider                 | Dedicated prefix outside the document reconciler; own reconciliation; purge deletes media                          |
| D100 | PLAN C delivery, rollout, order | Drive and local delivery not delayed; M4 narrowed                                                                  |
| D101 | PLAN C order                    | Phase 2 on the same review track                                                                                   |
| D102 | PLAN C provider                 | CRM-user playback endpoint                                                                                         |
| D103 | C5                              | Phase-2 test event answer                                                                                          |
| D104 | CRM test gates                  | 5 new cases                                                                                                        |
| D105 | Media gates                     | JM13–JM19                                                                                                          |
| D106 | Revision record                 | This table                                                                                                         |

**[Δ D117]** Revision 6 (2026-10-07): reconciled the implementation with pairing-state concurrency. D01–D116 remain historical records; the entries below supersede only the affected current guidance.

| Δ    | Section                         | Change                                                                                                                                                                                                                        |
| ---- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D107 | Shared contract, C4             | Published V1 schemas are recursively strict; unknown fields fail with `422`; additive evolution requires an explicit contract revision                                                                                        |
| D108 | Shared contract, C4             | Removed invented per-field/array bounds; the 2 MiB UTF-8 envelope is the transport bound and persistence must not truncate sender-valid values                                                                                |
| D109 | C4, C10                         | `artifacts[].viewUrl` is valid input, then deliberately removed from the persisted/exposed snapshot                                                                                                                           |
| D110 | C1 secret storage               | Neutral AES-256-GCM primitive with parameterized HKDF info and optional AAD; credentials v2 bytes, frozen label and legacy v1 decrypt preserved                                                                               |
| D111 | C1, C3, C4, C5                  | Secret/source nullable while unpaired; no-secret webhook `401`; first valid test/event pins source; secret replacement preserves pin; reset clears pairing state while preserving enabled                                     |
| D112 | F14, C1, CRM delivery track     | Exact manual SQL filename and deploy workflow wiring recorded; production requires synchronized deployment/rollback runbook mirror                                                                                            |
| D113 | Shared contract, version pins   | `standardwebhooks` `1.1.1` EXACT with protocol-critical rationale                                                                                                                                                             |
| D114 | HTTP response contract, C5      | Events-only phase 1 test remains `204`; capability `200` is future PLAN C / phase 2 only                                                                                                                                      |
| D115 | CRM delivery track              | Phase 1 explicitly excludes PLAN C media/video/playback/capability work                                                                                                                                                       |
| D116 | Revision record, CRM test gates | Revision-5 history and regression cases for strict schema, pairing lifecycle and storage minimization                                                                                                                         |
| D117 | C5                              | Bind ingest to the exact encrypted signing-secret value used for successful verification; a concurrent secret replace/reset makes a new delivery fail `401`, while an already-claimed duplicate still short-circuits to `204` |
| D118 | Shared contract, C4             | Bound B-tree-backed CloudEvent `id`, recording `id`, and `source.meetingId` to 512 characters in both published sender schemas/builders and CRM validation; keep free-form content governed by the 2 MiB envelope             |

**[Δ D130]** Revision 7 (2026-10-07): the extension's phase-1 destination flow (E1–E8) was implemented on the extension branch `feat/save-to-destinations`, and the implementation found the gaps below. Revision 7 is revision 6 plus these changes; the CRM side's behaviour is unchanged, and the joint protocol gains one case.

| Δ    | Section                   | Change                                                                                                  |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| D118 | E6                        | `GET_RECORDING_ROUTES` and `LIST_HELD_RECORDING_ROUTES`; no recording ID means the run in progress      |
| D119 | E1                        | Select values, built-in IDs in the run config, the remembered pick outside settings, the 20-profile cap |
| D120 | E5                        | Profile ID kept in the recording context; intent write and confirmation are single transactions         |
| D121 | E7, O13                   | Only the buttons answer; a recording saved without the dialog is asked about later                      |
| D122 | E11                       | The profile's local folder is preselected and used when no dialog asks                                  |
| D123 | E5                        | Library removal cancels unresolved deliveries; attempted streams are kept                               |
| D124 | E1                        | Unavailable entries say why; the fix lives in Settings                                                  |
| D125 | E4                        | `CREATE_INTEGRATION` creates the profile; _Add destination_ for integrations without one                |
| D126 | E8                        | Setup no longer offers a default routing                                                                |
| D127 | E3                        | The settings form never owns the profiles; the chip shows nothing when unsure                           |
| D128 | Extension automated tests | Message-level E2E in CI; new unit cases                                                                 |
| D129 | Joint Test 12             | The popup closed before _Stop_                                                                          |
| D131 | E7                        | The post-save summary waits for E12                                                                     |
| D130 | Revision record           | This table                                                                                              |

**[Δ D143]** Revision 8 (2026-10-09): reconciled PLAN C with the implemented Phase-2 foundations after the continuation audit and subsequent fixes. The source of truth for current media behavior is the _Phase 2 implementation reconciliation — 2026-10-09_ section above; older PLAN C prose remains useful historical design context where it does not conflict with these entries. The historic Revision-7 `D118` collision is left unchanged to avoid silently renumbering already-referenced phase-1 decisions; new identifiers continue from `D132`.

| Δ    | Section                            | Change                                                                                                                                  |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| D132 | PLAN C authorization               | Pin producer/endpoint/apiBase/connection version/exact upload origins at Start; legacy media authorization fails closed                 |
| D133 | PLAN C durable queue               | Stable logical transfer identity; immutable request/source ownership; actual OPFS byte size; duplicate enqueue returns original request |
| D134 | PLAN C durable queue               | Source-free capability verification and ready-result replay until durable history acknowledgement                                       |
| D135 | PLAN C retry semantics             | Structured error-code handling; only `MEDIA_UPLOAD_COMPLETING` 409 is transient; bounded signed-URL/network retry                       |
| D136 | PLAN C offscreen runtime           | Durable queue states, bounded retries, critical-work ownership, UI progress/retry exposure                                              |
| D137 | PLAN C CRM provider                | Connection-serialized create/restart/quota, aggregate media throttle, completing attempts count toward the four-upload cap              |
| D138 | PLAN C CRM provider                | Completion lease, HEAD recovery, missing provider-session retirement and stale-attempt protection                                       |
| D139 | PLAN C disable/disconnect/playback | CRM RBAC playback survives connection disable; extension Disable and Disconnect remain separate semantics                               |
| D140 | PLAN C deployment                  | Phase-2 media migration wired and checked before API deployment; PostgreSQL integration guard asserts required media schema             |
| D141 | PLAN C reconciliation              | DB/provider convergence for stale multipart work plus redacted, non-destructive completed-object orphan reporting                       |
| D142 | PLAN C provisioning/playback/CSP   | Confirm token replacement, typed ready-media descriptors, ranged playback refresh, narrowly allowlisted R2 media CSP                    |
| D143 | PLAN C rollout                     | R0 real-R2/browser proof before source release; R1 explicit verified _Free up space_; M3–M6 remain gated                                |
