# Diagnostic: was the company share for drops computed using the senior percentage

**Status:** diagnostic, **not a fix**. Changes nothing.
**Who runs it:** the owner (the assistant has no access to the prod DB).
**Backlog item:** 4 (system A).

---

## What exactly we are checking

The interface used to have **one shared dialog** for incomes. It computed the company share
using the **senior** percentage — and did so even when the income came from a **drop**
(confirmed by reading the code during review #445).

A senior and a drop have different percentages. So if a drop ever ran an income through that
dialog, the company withheld **the wrong share**: the amount diverged from what it should have been per
the drop's percentage.

Today the code no longer computes it this way — there is a separate drop-share resolver
(`apps/api/src/finance/drop-share-resolver.ts`, `resolveDropShare`), and each row
carries a snapshot of its own percentage. **The only question is about historical rows**: did anyone
fall under the old behavior before it was fixed.

## What the query does NOT do

- does not change a single row;
- does not recompute amounts;
- does not say which amount is correct.

It answers exactly one question: **were we affected at all or not.**

## How to read the result

| Result             | What it means                                                          | What to do    |
| ------------------ | ---------------------------------------------------------------------- | ------------- |
| **Empty (0 rows)** | No drops paid through that dialog. The problem did not touch us.       | Close item 4. |
| **There are rows** | That many drop incomes carry the senior percentage — amounts diverged. | See below.    |

If there are rows — **do not fix them right away**. Send me the output; the recomputation is done case by case, because
different paths have different amount semantics (in some places it is recorded "before withholding", in others "after"),
and it cannot be closed with a single formula. The second query below gives only the **order of magnitude**, to
understand the scale — it is not grounds for editing the data.

---

## How to run

The connection to the prod DB goes through the container on the VPS (there is no direct SSH access to the database):

```bash
docker exec -i <postgres-container-name> psql -U crm_user -d crm_db
```

Then paste the queries below. Or the whole thing as a file:

```bash
docker exec -i <postgres-container-name> psql -U crm_user -d crm_db -v ON_ERROR_STOP=1 < prod-queries.sql
```

The `-v ON_ERROR_STOP=1` flag is not critical here (the queries are read-only), but it is a good habit: without it
psql returns "success" even when the SQL failed.

---

## Query 1 — are there any affected rows

```sql
SELECT
  t.id,
  t.type,
  t.status,
  t.amount,
  t.currency,
  t.senior_share_percent AS pct_stamped_senior,
  t.drop_share_percent   AS pct_stamped_drop,
  u.display_name         AS drop_name,
  u.drop_share_percent   AS drop_pct_now,
  t.created_at
FROM transactions t
JOIN users u ON u.id = COALESCE(t.receiver_id, t.recipient_id, t.sender_id)
WHERE u.role = 'DROP'
  AND t.senior_share_percent IS NOT NULL
ORDER BY t.created_at;
```

**Logic:** we look for rows where the receiver/sender is a drop, but the row carries a snapshot
of the **senior** percentage (`senior_share_percent IS NOT NULL`). An honestly recorded drop income
should not have this field — it should have `drop_share_percent`.

The `drop_pct_now` column shows what percentage this drop has **now** — useful for
understanding how large the difference is.

---

## Query 2 — only if the first one returned rows

```sql
SELECT
  t.id,
  t.type,
  t.amount                                            AS amount_now,
  t.senior_share_percent                              AS pct_stamped_senior,
  COALESCE(u.drop_share_percent, 5)                   AS pct_drop,
  round(t.amount * COALESCE(u.drop_share_percent, 5)::numeric
        / NULLIF(t.senior_share_percent, 0)::numeric, 6) AS amount_if_drop_pct,
  u.display_name                                      AS drop_name
FROM transactions t
JOIN users u ON u.id = COALESCE(t.receiver_id, t.recipient_id, t.sender_id)
WHERE u.role = 'DROP'
  AND t.senior_share_percent IS NOT NULL
ORDER BY t.created_at;
```

**What it shows:** next to the current amount — an estimate of what it would be per the drop's percentage.
The difference between `amount_now` and `amount_if_drop_pct` is the scale of the divergence.

**Once more: this is a reference point, not a ready recomputation.** You cannot substitute `amount_if_drop_pct` into the
database — different paths differ in whether the share is included in the amount or subtracted from it.

---

## What next

1. Run query 1.
2. Empty → tell me, I will close item 4 in the backlog.
3. Not empty → run query 2 and send both outputs. Then I prepare a case-by-case fix:
   idempotent SQL with a record in the audit log, applied **only** through `deploy.yml`
   (nobody has direct write access to the prod database — see `.claude/rules/common/live-db-access.md`).
