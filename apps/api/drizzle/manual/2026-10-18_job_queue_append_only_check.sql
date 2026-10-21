-- =============================================================================
-- r5 Task 1.3b — catalog check for the append-only triggers and the R-B functions
-- =============================================================================
--
-- READ-ONLY. It writes nothing and it creates nothing; it RAISES if the objects
-- 2026-10-18_job_queue_append_only_triggers.sql installs are missing, disabled or
-- changed. Apply it on every deploy, immediately AFTER that file.
--
-- WHY A CHECK EXISTS AT ALL (ADR §3, "what remains unprotected", item 1)
--   Nothing in the database protects the log from the role that owns it: ownership
--   alone suffices to `DISABLE TRIGGER` or `DROP TRIGGER`. The protection against the
--   migration role is procedural, and the DETECTION is exactly this file: it runs on
--   every deploy and fails if a guard is missing, disabled, REWRITTEN or JOINED BY AN
--   UNDECLARED TRIGGER, so a guard dropped, left disabled or quietly changed is caught
--   at the next deploy.
--
--   EVERY ASSERTION IN THIS FILE HAS A TEST, and the tests are the reason to believe the
--   comments. `AC5 — the catalog check` in job-queue-append-only.integration.spec.ts has
--   one test per assertion: it replays the tampering against the SHIPPED BYTES of this
--   file and requires the specific failure message. Each was verified by DELETING its
--   assertion here and confirming exactly that test goes red — twelve of the thirteen
--   assertions are killed that way. The thirteenth, the identity-arguments filter in part
--   2b, is an EQUIVALENT MUTANT with respect to this check's verdict: measured across four
--   catalog states, deleting it changes no pass/fail outcome, only the precision of a
--   failure message, because the overload report fires on the very precondition that makes
--   it matter. The measurement is recorded where the filter sits. Every assertion that CAN
--   change the verdict has a test. Before fix round 2 none of this was pinned: nine
--   assertions could be deleted with the suite staying green, so the guarantee rested on
--   a replay nobody could repeat. If you add an assertion, add its test in the same PR.
--
--   WHAT "REWRITTEN" COVERS, because name + `tgenabled` alone did not cover it. Each
--   declared trigger is pinned by its timing/event bitmask, the function it executes,
--   the absence of a `WHEN` clause, its argument count, and the md5 of its whole
--   `pg_get_triggerdef`; and no trigger beyond the eight declared may exist on the
--   three guarded tables. Every one of those assertions earns its place by a tampering
--   that passed the earlier version of this file green — see the manifest's own comment.
--
--   WHAT "DISARMED" COVERS BEYOND TRIGGERS, because a trigger is not the only way. Three
--   objects disarm a guarded table while leaving every declared trigger byte-identical, and
--   each was measured doing it: a RULE (`DO INSTEAD NOTHING` makes the audit INSERT record
--   nothing and report success), an INHERITING CHILD (rows written into it are visible
--   through the parent and the parent's triggers never fire for them — `crm_app` rewrote
--   and deleted such a row), and ROW LEVEL SECURITY (`USING (false)` hides the log). Part
--   1c catches all three, reading `pg_rewrite` / `pg_inherits` / `pg_policy` rather than
--   the `pg_class` hint columns that merely suggest them (the reason is at part 1c, and it
--   is a false-positive one). All three need ownership of the table, so none is reachable
--   by `crm_app`; they are reachable by exactly the actor this file exists to detect.
--
--   Stated so nobody reads more into it: it does NOT catch a disable-edit-re-enable
--   inside one transaction, it does not compare the log against the nightly dumps, it says
--   nothing about triggers on tables other than the three it names, and it does not see a
--   FOREIGN TABLE, a VIEW shadowing a guarded name in another schema, or an object class
--   not named above — this list is what was measured, not a proof of exhaustiveness.
--
-- WHY `md5(pg_get_functiondef(oid))` AND NOT `md5(prosrc)`
--   `prosrc` is the EMPTY STRING for a `BEGIN ATOMIC` body, so a manifest built on it
--   degenerates to the md5 of '' and the check would pass on any such function.
--   `pg_get_functiondef` reconstructs the whole definition — signature, `SECURITY
--   DEFINER`, the `SET search_path`, and the body — so the checksum moves if any of
--   them moves. ADR §3 condition 6 names this explicitly.
--
-- REFRESHING THE MANIFESTS — the one maintenance task this file has
--   `pg_get_functiondef` and `pg_get_triggerdef` are both deparser output, so a MAJOR
--   PostgreSQL upgrade can change the text without anybody changing the object. Both
--   this cluster and production run PostgreSQL 16; across the 16.14 production server
--   and the 16.15 one these values were taken on, sixteen of the eighteen checksums below
--   are byte-identical (measured on two containers, 2026-10-19).
--   THE TWO THAT ARE NOT COVERED BY THAT MEASUREMENT, said plainly rather than left to be
--   assumed from the sentence above: the pair added for
--   `job_queue_actions_created_at_now` (r5 Task 1.4b-i, 2026-10-21) was taken on 16.15
--   ONLY — no 16.14 container was raised for it. The risk that carries is bounded and
--   LOUD: if 16.14 deparses either object differently, the deploy stops with "definition
--   checksum is X, manifest says Y" and applies nothing. It is not a silent hole. The
--   cheap way to close the gap when somebody next has a 16.14 container in hand is the
--   two queries below, filtered to that one trigger and that one function.
--
--   When a body or a trigger changes in a reviewed file (or on a major upgrade),
--   recompute and paste. Functions (both manifests):
--     SELECT p.proname, md5(pg_get_functiondef(p.oid))
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND (p.proname LIKE 'job_queue%' OR p.proname LIKE 'crm_retention%')
--      ORDER BY 1;
--   Triggers (column 6 of `expected_triggers`):
--     SELECT c.relname, t.tgname, t.tgenabled, t.tgtype, p.proname,
--            md5(pg_get_triggerdef(t.oid))
--       FROM pg_trigger t
--       JOIN pg_class c ON c.oid = t.tgrelid
--       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
--       JOIN pg_proc p ON p.oid = t.tgfoid
--      WHERE NOT t.tgisinternal
--        AND c.relname IN ('job_queue_actions', 'job_queue_generation_entries',
--                          'job_queue_generations')
--      ORDER BY 1, 2;
--   A mismatch is the check doing its job: it means the deployed object is not the
--   reviewed one. Refresh the manifest in the SAME PR that changes the object — and
--   never to make a red deploy go green.
-- =============================================================================

DO $check$
DECLARE
  -- SIX columns, in this order, and every one of them is asserted below:
  --   1 trigger name
  --   2 table
  --   3 expected `pg_trigger.tgenabled`      ('A' = ENABLE ALWAYS)
  --   4 expected `pg_trigger.tgtype`         (the timing/event/row-vs-statement bitmask)
  --   5 expected trigger function            (`pg_trigger.tgfoid` resolved to proname)
  --   6 expected `md5(pg_get_triggerdef(oid))` (the whole definition, WHEN clause included)
  --
  -- Columns 4-6 exist because NAME + `tgenabled` ALONE DO NOT PIN A GUARD. A trigger that
  -- keeps its name and stays ENABLE ALWAYS can still have been rewritten to guard nothing,
  -- and five such rewrites were demonstrated against the earlier version of this file —
  -- each one passed it green, and two of them let `crm_retention_owner` delete a
  -- `job_queue_actions` row seconds old:
  --   narrowing the events (BEFORE UPDATE only, so DELETE runs unguarded)  -> column 4
  --   flipping BEFORE to AFTER                                            -> column 4
  --   turning the row trigger into a statement trigger                     -> column 4
  --   adding WHEN (false)                                                  -> column 6
  --   repointing the trigger at a no-op function                           -> column 5
  -- The sixth rewrite — an EXTRA, undeclared trigger on a guarded table — is caught by
  -- part 1b below, not by this array: no per-trigger assertion can see a trigger nobody
  -- declared. `job_queue_generation_entries_building_only` is the one row here whose
  -- tgtype is 7 (BEFORE INSERT ... FOR EACH ROW); the two `no_truncate` rows are 34
  -- (BEFORE TRUNCATE ... FOR EACH STATEMENT, hence no ROW bit).
  --
  -- ON COLUMN 6, THE SESSION AND THE SERVER VERSION. Column 6 is deparser output, and it
  -- is a function of TWO things outside the trigger: the server version and the SESSION
  -- `search_path`. The second is not a theoretical concern — it moves every one of the
  -- column-6 checksums (measured: 193803… with `public` visible, 0c86cd… under `search_path =
  -- pg_catalog`, because the deparser qualifies the function name only when it must). That
  -- is why the `BEGIN` below pins the path before reading anything; the manifest values
  -- here are the values under that pinned path. Without the pin this column would be the
  -- one assertion in the file that can fail on a correct database. Columns 3-5 carry their
  -- part of the guarantee in catalog integers and names, so they are immune to both.
  --   On the version half: in principle a server upgrade can move the text without anybody
  -- moving the trigger. For THIS manifest that was measured rather than assumed: the seven
  -- checksums that existed on 2026-10-19 (every row below except
  -- `trg_job_queue_actions_created_at_now`, added 2026-10-21 and measured on 16.15 only —
  -- see the file header) are byte-identical on PostgreSQL 16.14 and 16.15 (two containers, same
  -- DDL, 2026-10-19), and 16.14 is what production runs while these values were taken on
  -- 16.15. The nine `pg_get_functiondef` checksums in the two manifests further down were
  -- measured the same way and are likewise identical across the two minors. Had they
  -- differed, the failure mode is a LOUD one — the deploy stops with "definition checksum
  -- is X, manifest says Y" and nothing is applied — never a silent hole. Refresh column 6
  -- only together with a reviewed DDL change (query in this file's header), never to make a
  -- red deploy go green.
  --
  -- WHAT COLUMN 6 CATCHES THAT COLUMNS 3-5 DO NOT, measured rather than argued, because a
  -- catch-all assertion that never catches anything alone is the first thing a later editor
  -- deletes. `BEFORE UPDATE OF reason OR DELETE` keeps tgtype at 27, keeps the function,
  -- adds no `WHEN` and passes no argument — every one of columns 3-5 and the `WHEN`/nargs
  -- assertions stays quiet — and it DISARMS the guard: the trigger then fires only when
  -- `reason` is in the SET list, so `UPDATE job_queue_actions SET actor_id = <other user>`
  -- succeeds where the reviewed definition refuses it with 23001. Measured on 16.15: the
  -- audit row's actor was rewritten. Column 6 (17e7ce53… against the manifest's 193803…) is
  -- the only assertion that sees it. `AC5 — the catalog check` pins this.
  expected_triggers CONSTANT text[][] := ARRAY[
    ['trg_job_queue_actions_append_only',                 'job_queue_actions',
     'A', '27',  'job_queue_actions_append_only',                '193803613d7cb921896de671ebb96fef'],
    ['trg_job_queue_actions_no_truncate',                 'job_queue_actions',
     'A', '34',  'job_queue_actions_no_truncate',                '1cf9b6eb4daec2c6c69b2eda056076bd'],
    ['trg_job_queue_generation_entries_immutable',        'job_queue_generation_entries',
     'A', '27',  'job_queue_generation_entries_immutable',       '5534fa98dd2a62a15603c914de52887c'],
    ['trg_job_queue_generation_entries_no_truncate',      'job_queue_generation_entries',
     'A', '34',  'job_queue_generation_entries_no_truncate',     '3827f42d4ddbfcf8517bafa63a41329d'],
    ['trg_job_queue_generation_entries_building_only',    'job_queue_generation_entries',
     'A', '7',   'job_queue_generation_entries_building_only',   'd0b0d5c9ee10132b27e66d3d5ac73fd2'],
    ['trg_job_queue_generations_frozen',                  'job_queue_generations',
     'A', '19',  'job_queue_generations_frozen',                 '2f9f701662e61ef68c6e2f9d2c585dad'],
    ['trg_job_queue_generations_purge_invalidated_only',  'job_queue_generations',
     'A', '11',  'job_queue_generations_purge_invalidated_only', 'b73c59e71d952b77f09757521481311c'],
    -- r5 Task 1.4b-i. `created_at` is forced to `now()` on INSERT, which is what makes the
    -- two-year bound in `job_queue_actions_append_only()` trustworthy: that bound reads this
    -- very column. So this row is not one more guard on the pile — drop it and the DELETE
    -- exception above becomes writer-controlled. tgtype 7 = BEFORE INSERT ... FOR EACH ROW,
    -- the same value as `..._building_only`.
    ['trg_job_queue_actions_created_at_now',              'job_queue_actions',
     'A', '7',   'job_queue_actions_created_at_now',             '3020b8d4acff09452b2097b14ace70c2']
  ];
  -- Function name, IDENTITY ARGUMENTS and the expected md5(pg_get_functiondef(oid)).
  -- The middle column is `pg_get_function_identity_arguments()` verbatim, which on
  -- PostgreSQL 16 carries the parameter NAMES as well as the types — so a rename of
  -- a parameter is a finding here, which is correct: the API calls these by keyword
  -- or by position, and both are part of the reviewed interface.
  expected_functions CONSTANT text[][] := ARRAY[
    ['crm_retention_purge_job_queue_actions', '',
     '5e5e897925c16d6bd1ca2881f5a25f99'],
    ['crm_retention_redact_action_reason',    'p_action_id uuid, p_request_id text',
     '8fcec30143ba762bc613728a0d088d79']
  ];
  -- The TRIGGER functions, pinned the same way. ADR §3 condition 6 asks only for the
  -- two R-B functions, and that is not enough on its own: condition 5 puts the shape
  -- validation of every admitted change INSIDE THE TRIGGER, so the trigger body is
  -- the independent half of the guarantee. Without these rows, an edit to a guard
  -- body passes this check as long as the trigger still exists and is enabled —
  -- i.e. the check would pin the enforcement's wiring and not its content. Owner is
  -- deliberately NOT asserted for these: they belong to whoever applied the DDL,
  -- which is the migration role and differs between environments.
  expected_trigger_functions CONSTANT text[][] := ARRAY[
    ['job_queue_actions_append_only',                  '5b559777a63649c3c3d0e4d63456be87'],
    ['job_queue_actions_no_truncate',                  '632615a6d6f46aa229582f5de8a95099'],
    ['job_queue_generation_entries_immutable',         '0df34c2b4af8d3628fe3b77885d5e3f0'],
    ['job_queue_generation_entries_no_truncate',       '0f2845e1a6add373ea5756a9f538baf6'],
    ['job_queue_generation_entries_building_only',     '9239f498636cd5f779dd27c7baa85276'],
    ['job_queue_generations_frozen',                   'ddcc16735e528255415b78dc58688278'],
    ['job_queue_generations_purge_invalidated_only',   '33ba42122c38b8c0baece4ead04e9d35'],
    -- Pinning the TRIGGER (above) proves only that something fires BEFORE INSERT. This row is
    -- what makes a REWRITTEN body a finding: a function that keeps its name and signature but
    -- drops the `NEW.created_at := now()` assignment leaves every other assertion in this file
    -- quiet, and hands the column back to its writer.
    ['job_queue_actions_created_at_now',               '0b9093ecd63c5e1d659494c306d354f2']
  ];
  expected_search_path CONSTANT text := 'search_path=pg_catalog, public, pg_temp';

  problems text[] := ARRAY[]::text[];
  i int;
  trg_name text;
  tbl_name text;
  fn_name text;
  fn_args text;
  fn_md5 text;
  rec record;
  found_count int;
BEGIN
  -- PIN THE `search_path` THIS CHECK COMPUTES UNDER, because column 6 depends on it.
  -- `pg_get_triggerdef` SCHEMA-QUALIFIES the executed function only when `public` is not
  -- visible, so the same untouched trigger hashes two different ways: measured on 16.15,
  -- `trg_job_queue_actions_append_only` is 193803613d7cb921896de671ebb96fef under a path
  -- containing `public` and 0c86cd143fc4c57b8903ce90aa3fbbb1 under `search_path =
  -- pg_catalog`. They all move together. The deploy runs plain `psql`, so without this
  -- line a HEALTHY database fails this check loudly whenever the migration role carries a
  -- role-level or database-level `search_path` that omits `public` — a false positive on
  -- deploy, which is the one failure this file must not invent. `true` = transaction-local,
  -- so it does not leak to whatever psql runs next.
  --   The manifest values below are the values under THIS pinned path (verified identical
  -- to the previous default-path values, so pinning refreshed nothing). The nine
  -- `pg_get_functiondef` checksums are independent of it — measured under both paths, all
  -- nine byte-identical — because a function's definition names no schema it has to
  -- resolve. Only column 6 needed pinning; it is pinned rather than documented so the
  -- checksum means one thing.
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, public', true);

  -- -------------------------------------------------------------------------
  -- 1. Every guard trigger exists, on the right table, and is ENABLE ALWAYS.
  --    `tgenabled`: 'O' origin (default), 'A' ALWAYS, 'R' replica, 'D' disabled.
  --    Only 'A' fires under session_replication_role = replica, which is the whole
  --    point of setting it — so anything other than 'A' is a finding, including the
  --    DEFAULT state, not merely 'D'.
  -- -------------------------------------------------------------------------
  FOR i IN 1 .. array_length(expected_triggers, 1) LOOP
    trg_name := expected_triggers[i][1];
    tbl_name := expected_triggers[i][2];

    SELECT t.tgenabled,
           t.tgtype,
           p.proname                                 AS fn,
           t.tgqual IS NOT NULL                      AS has_when,
           t.tgnargs                                 AS nargs,
           md5(pg_catalog.pg_get_triggerdef(t.oid))  AS def_md5,
           pg_catalog.pg_get_triggerdef(t.oid)       AS def
      INTO rec
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public' AND c.relname = tbl_name AND t.tgname = trg_name
       AND NOT t.tgisinternal;

    IF NOT FOUND THEN
      problems := problems || format('trigger %s is MISSING from public.%s', trg_name, tbl_name);
      CONTINUE;
    END IF;

    IF rec.tgenabled <> expected_triggers[i][3] THEN
      problems := problems || format(
        'trigger %s on public.%s is not ENABLE ALWAYS (tgenabled = %L, expected %L)',
        trg_name, tbl_name, rec.tgenabled, expected_triggers[i][3]);
    END IF;

    -- Column 4. One comparison covers three of the demonstrated rewrites: narrowing the
    -- events, flipping BEFORE/AFTER, and row-vs-statement all live in this bitmask.
    IF rec.tgtype::text <> expected_triggers[i][4] THEN
      problems := problems || format(
        'trigger %s on public.%s fires on the WRONG timing/events: tgtype is %s, manifest '
        'says %s — deployed definition is %L',
        trg_name, tbl_name, rec.tgtype, expected_triggers[i][4], rec.def);
    END IF;

    -- Column 5. A trigger keeping its name while pointing at a different function is the
    -- cheapest way to disarm a guard without tripping any name-based assertion.
    IF rec.fn <> expected_triggers[i][5] THEN
      problems := problems || format(
        'trigger %s on public.%s EXECUTES public.%s(), manifest says public.%s() — the '
        'trigger was repointed at another function',
        trg_name, tbl_name, rec.fn, expected_triggers[i][5]);
    END IF;

    -- A `WHEN` clause is never present in the reviewed DDL, so any is a rewrite. Named
    -- separately from column 6 because `WHEN (false)` disarms the guard completely and
    -- deserves to be read off the failure rather than inferred from a checksum.
    IF rec.has_when THEN
      problems := problems || format(
        'trigger %s on public.%s carries a WHEN clause, which the reviewed DDL never does '
        '— a WHEN that is ever false is a guard that does not run: %L',
        trg_name, tbl_name, rec.def);
    END IF;

    IF rec.nargs <> 0 THEN
      problems := problems || format(
        'trigger %s on public.%s passes %s argument(s) to its function, expected none',
        trg_name, tbl_name, rec.nargs);
    END IF;

    -- Column 6. The catch-all: anything the four assertions above do not name still moves
    -- this checksum (argument text, the table it is attached to, future syntax).
    IF rec.def_md5 <> expected_triggers[i][6] THEN
      problems := problems || format(
        'trigger %s on public.%s definition checksum is %s, manifest says %s — the '
        'deployed trigger is not the reviewed one; deployed definition is %L',
        trg_name, tbl_name, rec.def_md5, expected_triggers[i][6], rec.def);
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 1b. NO TRIGGER BEYOND THE SEVEN DECLARED, on any of the guarded tables.
  --     Per-trigger assertions are blind to a trigger nobody declared, and an
  --     extra trigger on an append-only log is a change nobody reviewed — it can
  --     suppress a write, rewrite NEW, or (as a BEFORE trigger returning NULL)
  --     silently swallow rows. The table list is derived from the manifest above
  --     rather than written out again, so it cannot drift from it.
  --     Internal triggers (FK enforcement) are `tgisinternal` and excluded.
  -- -------------------------------------------------------------------------
  FOR rec IN
    SELECT c.relname AS tbl, t.tgname AS trg, pg_catalog.pg_get_triggerdef(t.oid) AS def
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND NOT t.tgisinternal
       AND c.relname IN (SELECT DISTINCT expected_triggers[s][2]
                           FROM generate_subscripts(expected_triggers, 1) s)
       AND NOT EXISTS (SELECT 1
                         FROM generate_subscripts(expected_triggers, 1) s
                        WHERE expected_triggers[s][1] = t.tgname
                          AND expected_triggers[s][2] = c.relname)
     ORDER BY c.relname, t.tgname
  LOOP
    problems := problems || format(
      'trigger %s on public.%s is NOT DECLARED in this file — an undeclared trigger on a '
      'guarded table is a change nobody reviewed: %L', rec.trg, rec.tbl, rec.def);
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 1c. NO RULE, NO CHILD TABLE, NO ROW-LEVEL SECURITY on a guarded table.
  --     Everything above this point reads `pg_trigger`, and a trigger is not the
  --     only way to disarm a table. THREE OBJECTS WERE DEMONSTRATED against the
  --     earlier version of this file, each leaving all seven triggers BYTE-IDENTICAL
  --     and this check GREEN (measured, 2026-10-19):
  --       `CREATE RULE ... ON INSERT ... DO INSTEAD NOTHING` — the audit INSERT
  --         returns `INSERT 0 0` with no error and records nothing. The log silently
  --         stops recording.                                      -> relhasrules
  --       an INHERITING CHILD table plus a rule diverting the INSERT into it — the
  --         row is written, is visible through `SELECT ... FROM job_queue_actions`,
  --         and `crm_app` then rewrote `actor_id` and `reason` and DELETED it. This
  --         is exactly the shape part 1b's comment says it exists to stop, reached
  --         through `pg_inherits` instead of `pg_trigger`.         -> relhassubclass
  --       `ENABLE ROW LEVEL SECURITY` + `POLICY ... USING (false)` — `crm_app` sees
  --         zero rows in the entire audit log.                     -> relrowsecurity
  --
  --     WHO CAN DO THIS, stated so the weight is not overread: all three require
  --     OWNERSHIP of the table, so none is reachable by `crm_app` — verified, the
  --     API role fails `must be owner of table job_queue_actions` even with
  --     `TEMPORARY` granted back. They are reachable by the migration role, which is
  --     the actor this whole file exists to DETECT rather than prevent (ADR §3: the
  --     protection against the migration role is procedural, the detection is here).
  --     Without these three booleans that actor had an undetected persistence
  --     primitive that hands audit tampering to `crm_app` and survives every
  --     subsequent deploy.
  --
  --     The three guarded tables come from the manifest, like part 1b's list, so this
  --     cannot drift from it. The reviewed DDL creates no rule, no child and no policy
  --     on any of them, so every count below is expected to be zero.
  --
  --     NOT `pg_class.relhasrules` / `relhassubclass`, WHICH IS WHERE THIS NEARLY WENT
  --     WRONG. Those two columns are PLANNER HINTS, not facts: PostgreSQL sets them when
  --     a rule or a child appears and clears them ONLY ON A LATER VACUUM, not when the
  --     object goes away. Measured on 16.15 — create a rule and an inheriting child, drop
  --     both, and `relhasrules` and `relhassubclass` are still `t` while `pg_rewrite` and
  --     `pg_inherits` hold nothing.
  --       An assertion on the hints would therefore go red on any database where a rule or
  --     a child ever existed and was removed, and STAY red until some vacuum happened to
  --     run — which is worse than a permanent red, because a check that is red for a while
  --     and then green with nothing changed teaches the next reader that its failures mean
  --     nothing. (That sharper reading is the security reviewer's, who proposed these
  --     booleans and then withdrew them; the original wording here said "never cleared".)
  --     Same defect family as a checksum that depends on the session `search_path`: a
  --     check that fails on a healthy database is a check people learn to ignore. So the
  --     assertions below read the AUTHORITATIVE catalogs — `pg_rewrite`, `pg_inherits`,
  --     `pg_policy` — and name the offending object, which the hints cannot do either.
  --       `relrowsecurity` IS authoritative (`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`
  --     really clears it), so it is read directly — together with `pg_policy`, because
  --     RLS-disabled-but-policies-present is still an unreviewed object on an audit table.
  -- -------------------------------------------------------------------------
  FOR rec IN
    SELECT c.relname AS tbl,
           c.relrowsecurity,
           -- WHY EXCLUDING BY NAME IS SAFE HERE, measured because it looks unsafe and the
           -- doubt would otherwise be re-raised every review round. The worry is obvious:
           -- the exclusion keys on the rule's NAME, not its TYPE, so a rule deliberately
           -- named `_RETURN` on INSERT would be filtered out of a guard whose only job is
           -- to be loud. PostgreSQL does not allow it. Measured on 16.15:
           --   CREATE TABLE t (id int);
           --   CREATE RULE "_RETURN" AS ON INSERT TO t DO INSTEAD NOTHING;
           --   ERROR:  non-view rule for "t" must not be named "_RETURN"
           -- The name is reserved for the SELECT rule that IS a view's definition, so on a
           -- plain table `rulename = '_RETURN'` and "is a view rule" are the same set, and
           -- the exclusion cannot hide a write-suppressing rule. (If one of these three
           -- relations were ever REPLACED by a view, its `_RETURN` rule would be excluded
           -- here — but a view can carry only INSTEAD OF triggers, whose tgtype differs
           -- from every value in the manifest, so part 1 column 4 catches that instead.)
           (SELECT string_agg(r.rulename, ', ' ORDER BY r.rulename)
              FROM pg_catalog.pg_rewrite r
             WHERE r.ev_class = c.oid AND r.rulename <> '_RETURN')      AS rules,
           (SELECT string_agg(cn.nspname || '.' || cc.relname, ', ' ORDER BY cc.relname)
              FROM pg_catalog.pg_inherits inh
              JOIN pg_catalog.pg_class cc ON cc.oid = inh.inhrelid
              JOIN pg_catalog.pg_namespace cn ON cn.oid = cc.relnamespace
             WHERE inh.inhparent = c.oid)                              AS children,
           (SELECT string_agg(pol.polname, ', ' ORDER BY pol.polname)
              FROM pg_catalog.pg_policy pol
             WHERE pol.polrelid = c.oid)                               AS policies
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN (SELECT DISTINCT expected_triggers[s][2]
                           FROM generate_subscripts(expected_triggers, 1) s)
     ORDER BY c.relname
  LOOP
    IF rec.rules IS NOT NULL THEN
      problems := problems || format(
        'table public.%s carries a RULE — the reviewed DDL creates none, and a rule can '
        'make a write return success while recording nothing (`DO INSTEAD NOTHING`) or '
        'divert it to another table: %s', rec.tbl, rec.rules);
    END IF;

    IF rec.children IS NOT NULL THEN
      problems := problems || format(
        'table public.%s has an INHERITING CHILD table — rows written into a child are '
        'visible through the parent while the parent''s triggers never fire for them, so '
        'the guards do not apply to them: %s', rec.tbl, rec.children);
    END IF;

    IF rec.relrowsecurity OR rec.policies IS NOT NULL THEN
      problems := problems || format(
        'table public.%s has ROW LEVEL SECURITY (enabled = %s, policies = %s) — the '
        'reviewed DDL enables none, and a policy can hide the whole audit log from the '
        'role that reads it',
        rec.tbl, rec.relrowsecurity, coalesce(rec.policies, 'none'));
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 2. The two R-B functions: existence + signature, prosecdef, proowner,
  --    proconfig (the pinned search_path, pg_temp last), proacl and the body
  --    checksum. ADR §3 condition 6, item by item.
  -- -------------------------------------------------------------------------
  FOR i IN 1 .. array_length(expected_functions, 1) LOOP
    fn_name := expected_functions[i][1];
    fn_args := expected_functions[i][2];
    fn_md5  := expected_functions[i][3];

    SELECT p.oid,
           p.prosecdef,
           pg_catalog.pg_get_userbyid(p.proowner) AS owner,
           p.proconfig,
           p.proacl,
           md5(pg_catalog.pg_get_functiondef(p.oid)) AS body_md5,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      INTO rec
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = fn_name
       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = fn_args;

    IF NOT FOUND THEN
      problems := problems || format('function public.%s(%s) is MISSING', fn_name, fn_args);
      CONTINUE;
    END IF;

    IF NOT rec.prosecdef THEN
      problems := problems || format('function public.%s is not SECURITY DEFINER', fn_name);
    END IF;

    IF rec.owner <> 'crm_retention_owner' THEN
      problems := problems || format(
        'function public.%s is owned by %L, expected crm_retention_owner', fn_name, rec.owner);
    END IF;

    -- proconfig must be EXACTLY the one pinned setting. An extra setting is a
    -- finding too: anything else in there was not reviewed.
    IF rec.proconfig IS DISTINCT FROM ARRAY[expected_search_path] THEN
      problems := problems || format(
        'function public.%s has proconfig %L, expected exactly {%s}',
        fn_name, rec.proconfig, expected_search_path);
    END IF;

    IF rec.body_md5 <> fn_md5 THEN
      problems := problems || format(
        'function public.%s body checksum is %s, manifest says %s — the deployed body is '
        'not the reviewed one (or the manifest was not refreshed; see this file''s header)',
        fn_name, rec.body_md5, fn_md5);
    END IF;

    -- EXECUTE is granted to crm_app and to nobody else; PUBLIC holds nothing.
    -- `proacl IS NULL` means "default privileges", i.e. EXECUTE for PUBLIC — the
    -- state the REVOKE exists to leave behind, so a NULL here is a finding.
    IF rec.proacl IS NULL THEN
      problems := problems || format(
        'function public.%s has default privileges (proacl IS NULL) — EXECUTE is still '
        'granted to PUBLIC', fn_name);
    ELSE
      SELECT count(*)::int INTO found_count
        FROM pg_catalog.aclexplode(rec.proacl) a
       WHERE a.privilege_type = 'EXECUTE'
         AND a.grantee <> 0                          -- 0 = PUBLIC
         AND pg_catalog.pg_get_userbyid(a.grantee) NOT IN ('crm_app', 'crm_retention_owner');
      IF found_count > 0 THEN
        problems := problems || format(
          'function public.%s grants EXECUTE to %s role(s) beyond crm_app and its owner',
          fn_name, found_count);
      END IF;

      IF EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(rec.proacl) a
         WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0
      ) THEN
        problems := problems || format('function public.%s grants EXECUTE to PUBLIC', fn_name);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(rec.proacl) a
         WHERE a.privilege_type = 'EXECUTE'
           AND a.grantee <> 0
           AND pg_catalog.pg_get_userbyid(a.grantee) = 'crm_app'
      ) THEN
        problems := problems || format(
          'function public.%s does not grant EXECUTE to crm_app', fn_name);
      END IF;
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 2b. The trigger function bodies — the independent half of the guarantee.
  -- -------------------------------------------------------------------------
  FOR i IN 1 .. array_length(expected_trigger_functions, 1) LOOP
    fn_name := expected_trigger_functions[i][1];
    fn_md5  := expected_trigger_functions[i][2];

    -- The identity-arguments filter: correct, kept, and NOT load-bearing for the
    -- guarantee — which is a weaker claim than this comment used to make, and the honest
    -- one. Selected by `proname` alone, an overload of a guard's name
    -- (`job_queue_actions_append_only(int)`, say) makes this `SELECT … INTO` take an
    -- ARBITRARY one of the matching rows, so the checksum assertion below could read a
    -- function that is not the one the triggers execute. A trigger function takes no
    -- declared arguments, so its identity arguments are the empty string, and that is the
    -- only row this may read. (The two R-B functions in part 2 were already filtered this
    -- way; this loop was not.)
    --
    -- WHY IT CANNOT BE PINNED BY A TEST, recorded so nobody spends the afternoon trying.
    -- Deleting this filter leaves the whole suite GREEN (re-measured in round 3: 74/74
    -- still pass, as 68/68 did in round 2 before five tests and the inventory were added). That
    -- is not a gap in the tests — it is because deleting it CANNOT CHANGE THIS CHECK'S
    -- VERDICT, which was measured across the whole state space that matters rather than
    -- argued (2026-10-19, PG 16.15, this check with and without the filter):
    --   clean                                        -> GREEN   | GREEN
    --   an overload exists                           -> RED     | RED   (same 1 problem)
    --   an overload exists AND the real body gutted  -> RED     | RED   (same 2 problems,
    --                                                   including the real body checksum)
    --   the real body gutted, no overload            -> RED     | RED   (same 1 problem)
    -- The reason it is invariant: the overload REPORT below fires on exactly the
    -- precondition that makes this lookup ambiguous, so whenever the filter could matter
    -- the check is ALREADY red; and removing a conjunct from a WHERE clause can only widen
    -- the candidate rows, while this block only ever APPENDS problems. So the exact cost
    -- of deleting it, stated without rounding in its own favour: NO RED BECOMES GREEN, and
    -- the failure MESSAGE can be less precise — a real body-checksum complaint can be
    -- omitted because the wrong row was read. The earlier wording here said "never a
    -- masked finding", which overstated it: that omitted complaint IS a finding the
    -- message no longer carries. What survives is the verdict, not every detail of it.
    --   So: the filter buys diagnostic precision and robustness if the report is ever
    -- removed; the REPORT carries the detection, and that one IS pinned (`2b: reports an
    -- unexpected overload …`). Deleting this line is an EQUIVALENT MUTANT with respect to
    -- the verdict, which is why no behavioural test can kill it. Keep it anyway: it costs
    -- one line and it is what makes the failure name the right object.
    SELECT p.proconfig,
           md5(pg_catalog.pg_get_functiondef(p.oid)) AS body_md5
      INTO rec
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = fn_name
       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = '';

    IF NOT FOUND THEN
      problems := problems || format('trigger function public.%s() is MISSING', fn_name);
      CONTINUE;
    END IF;

    -- An overload of a guard's name is not itself an attack, but nothing in the reviewed
    -- DDL creates one, so it is an unreviewed object sitting next to a security guard
    -- under a confusable name. Reported rather than ignored.
    SELECT count(*)::int INTO found_count
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = fn_name
       AND pg_catalog.pg_get_function_identity_arguments(p.oid) <> '';
    IF found_count > 0 THEN
      problems := problems || format(
        'trigger function public.%s has %s unexpected overload(s) — no reviewed file '
        'creates one, and an overload of a guard''s name is an unreviewed object',
        fn_name, found_count);
    END IF;

    IF rec.proconfig IS DISTINCT FROM ARRAY[expected_search_path] THEN
      problems := problems || format(
        'trigger function public.%s has proconfig %L, expected exactly {%s}',
        fn_name, rec.proconfig, expected_search_path);
    END IF;

    IF rec.body_md5 <> fn_md5 THEN
      problems := problems || format(
        'trigger function public.%s body checksum is %s, manifest says %s — a guard body '
        'was changed outside a reviewed file (or the manifest was not refreshed)',
        fn_name, rec.body_md5, fn_md5);
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 3. ARITHMETIC, not attentiveness: `crm_retention_owner` owns EXACTLY these two
  --    functions and nothing else. ADR §2 "Functions" allows these two definer
  --    functions and no others, and a third one owned by this role would run with
  --    its privileges while never having been reviewed as part of R-B.
  -- -------------------------------------------------------------------------
  SELECT count(*)::int INTO found_count
    FROM pg_catalog.pg_proc p
   WHERE pg_catalog.pg_get_userbyid(p.proowner) = 'crm_retention_owner';

  IF found_count <> array_length(expected_functions, 1) THEN
    problems := problems || format(
      'crm_retention_owner owns %s function(s), expected exactly %s',
      found_count, array_length(expected_functions, 1));
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION
      'r5 Task 1.3b catalog check FAILED (% problem(s)): %',
      cardinality(problems), array_to_string(problems, ' | ')
      USING
        ERRCODE = 'raise_exception',
        HINT = 'Re-apply apps/api/drizzle/manual/2026-10-18_job_queue_append_only_triggers.sql. '
               'If a body legitimately changed, refresh the manifest in this file in the '
               'same PR (the query is in this file''s header).';
  END IF;

  RAISE NOTICE
    'r5 Task 1.3b catalog check OK: % triggers pinned by definition (timing/events, function, '
    'no WHEN, full triggerdef md5) with no undeclared trigger, no rule, no inheriting child '
    'and no row-level security on the guarded tables, '
    '% guard bodies pinned, % R-B functions pinned',
    array_length(expected_triggers, 1),
    array_length(expected_trigger_functions, 1),
    array_length(expected_functions, 1);
END
$check$;
