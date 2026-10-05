# Spec: the DROP role, drop commands, and the financial pass-through

Status: agreed by the owner. UI/implementation language: Russian. Principle #1: **do not break the current senior logic**.

## 1. Goal and the main principle

Introduce a "drop" user — a financial pass-through through whose accounts money flows for projects and who takes a small share (default 5%). The senior works "under the drop". The senior's team and the entire existing financial/archive flow of the senior — **unchanged**. The drop is added strictly additively.

## 2. Glossary

- **Senior team** — an existing entity, the logic does NOT change.
- **Drop (DROP)** — a new role; a financial pass-through; does NOT participate in interviews.
- **Drop team** — a full-fledged team (HR + accountant) + drop-owner + optionally 1 senior; created when the drop is created (mandatory).
- **Drop project** — a project with `projects.dropId`; money arrives to the drop, distribution includes the drop's share.

## 3. Data model (additive)

- `role` enum += `'DROP'`.
- `users` += `drop_share_percent` (int, default `5`, nullable).
- `teams` += `type` (`'SENIOR' | 'DROP'`, default `'SENIOR'`); backfill existing → `'SENIOR'`.
- `projects` += `drop_id` (uuid, nullable, FK users); `NULL` = ordinary senior project (unchanged), set = drop project.
- Migrations new `0020+`. Shared: `roleSchema` += `DROP`; `createDropSchema`; `projectSchema` += `dropId`.

## 4. RBAC

- **DROP sees:** own profile, own finances, own drop team (read). Without Interviews.
- **Drop sidebar:** Profile, Team, Finances.
- **Accountant/Admin** validate the drop's income as for a senior. The rest of RBAC — unchanged.

## 5. Creating entities

### 5.1 Creating a drop (mirror of the senior form)

Identity (`role=DROP`), contacts, requisites, `drop_share_percent` (default 5%). The "Team" section: HR(s) **MANDATORY ≥1** + accountant + telegram channel — the fields are **IDENTICAL** to the senior team. On submit: a DROP user is created AND a drop team is mandatorily created (`type='DROP'`) with members drop+HR+accountant.

### 5.2 Creating a senior — 2 options

1. Create their own team (current behavior, unchanged) or
2. Add to an existing drop team (show drop teams without an active senior).

From the "Teams" page the **separate team creation — REMOVE**. A senior — at most in 1 active team.

### 5.3 Senior without a team (edge — only after archiving a drop team)

Detached → the "no team" badge; loses access to Interviews and Projects (nav hidden + empty-state on the routes); in the profile a "Create/choose team" button with the same choice as in 5.2.

## 6. Senior rotation in a drop team

At most 1 active senior. Rotation: current → `team_members.leftAt=now`, new → added; the drop stays. On the drop team details — the "change/assign senior" action.

## 7. Archiving and cascades

- **Senior archive** (own team): their team + projects (as now). Unchanged.
- **Senior team archive:** senior + projects (as now). Unchanged.
- **Drop team archive:** drop + all its projects; the senior is **DETACHED** (not archived), HR/accountant → `leftAt`.
- **Drop archive:** the drop team + all its projects; the senior is **DETACHED** (not archived).

Drop↔drop team — a bidirectional pair (mirror of senior↔team). Before confirmation — an impact-cascade screen with a warning (N projects archived, the senior is detached). "Deletion" = archive (soft, `archivedAt`). We do not introduce a physical DELETE.

## 8. Finances

### 8.1 Drop project — distribution

A project as for a senior, but money to the drop + the drop's share. Example (income $1000, senior 26%, drop 5%):

```
Income to the drop:         $1000
  − senior share (26%):      $260
  − drop share (5%):          $50
  = remainder:               $690  → 50/50 between admins (MAKSYM/KOSTYA): $345 / $345
Junior salary — separate (junior_payments, as now).
```

Implementation: a new branch "if `project.dropId != null`": subtract the senior's share and the drop's share, then split the remainder 50/50 to the partners. The ordinary senior-project branch (`dropId=null`) — **unchanged**.

### 8.2 Drop income/payout flow

The drop registers an income + receipt (as a senior) → the accountant validates → selection of transactions for payout → payout. Income can be FOP / gig / crypto.

### 8.3 Drop requisites

**NOT USDT-only** (unlike the senior/admin) — USDT ERC-20 and Bank UAH (FOP) are available.

### 8.4 Manual payout confirmation (new; for the senior and the drop)

The accountant/Admin manually confirms a payout (off-platform settlements); in the dialog they specify which admin received the money.

- **Drop payout:** the drop received $1000, the drop pays $950 to the chosen admin → (1) a transaction "income to the admin's balance" = the full payout amount ($950); (2) Pending "payout of the senior's percent" = the senior's share of the drop's income ($260 at 26%). The drop retains 5% ($50) = income − payout to the admin.
- **Senior payout:** the senior is the owner of the income themselves and has already retained their share → **ONLY** an "admin share" is created (= the payout amount to the chosen admin). A separate "senior share" transaction is NOT created. Without auto-50/50.

## 9. Phases (separate green PRs)

1. **Structure** (role, migrations, drop+team creation, 2 senior options, teamless edge, rotation, cascades).
2. **Drop-project finances.**
3. **Manual payout confirmation.**

## 10. Testing (focus — "did not break the senior")

- **Senior regression:** existing E2E/UT pass unchanged (except the "2 options" choice in the form).
- **UT new:** creating a drop creates a drop team; `drop_share` default 5; drop-project calculation (1000→260/50/345/345); archive cascades; prohibition of a 2nd active senior in a drop team.
- **E2E new:** creating a drop; "senior into a drop team"; teamless-senior edge; manual confirmation (drop: $950 to the admin + pending $260 to the senior; senior: only the admin share).

## 11. Decided by the owner

1. Senior manual confirmation — only the "admin share".
2. HR is mandatory when creating a drop (≥1).
3. The team fields of a drop team are identical to the senior team.
