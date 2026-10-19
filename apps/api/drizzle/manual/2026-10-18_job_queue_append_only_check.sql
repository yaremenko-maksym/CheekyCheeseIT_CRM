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
--   WHAT "REWRITTEN" COVERS, because name + `tgenabled` alone did not cover it. Each
--   declared trigger is pinned by its timing/event bitmask, the function it executes,
--   the absence of a `WHEN` clause, its argument count, and the md5 of its whole
--   `pg_get_triggerdef`; and no trigger beyond the seven declared may exist on the
--   three guarded tables. Every one of those assertions earns its place by a tampering
--   that passed the earlier version of this file green — see the manifest's own comment.
--
--   Stated so nobody reads more into it: it does NOT catch a disable-edit-re-enable
--   inside one transaction, it does not compare the log against the nightly dumps, and
--   it says nothing about triggers on tables other than the three it names.
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
--   and the 16.15 one these values were taken on, all sixteen checksums below are
--   byte-identical (measured on two containers, 2026-10-19).
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
  -- ON COLUMN 6 AND THE SERVER VERSION. `pg_get_triggerdef` is deparser output, so in
  -- principle a server upgrade can move the text without anybody moving the trigger. For
  -- THIS manifest that was measured rather than assumed: all seven checksums below are
  -- byte-identical on PostgreSQL 16.14 and 16.15 (two containers, same DDL, 2026-10-19),
  -- and 16.14 is what production runs while these values were taken on 16.15. The nine
  -- `pg_get_functiondef` checksums in the two manifests further down were measured the
  -- same way and are likewise identical across the two minors. Had they differed, the
  -- failure mode is a LOUD one — the deploy stops with "definition checksum is X,
  -- manifest says Y" and nothing is applied — never a silent hole; and columns 3-5, which
  -- carry the guarantee in catalog integers rather than in deparsed text, are immune to
  -- the deparser entirely. Refresh column 6 only together with a reviewed DDL change
  -- (query in this file's header), never to make a red deploy go green.
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
     'A', '11',  'job_queue_generations_purge_invalidated_only', 'b73c59e71d952b77f09757521481311c']
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
    ['job_queue_actions_append_only',                  '6102403f82916ef46cbaae8d9709d9ab'],
    ['job_queue_actions_no_truncate',                  '632615a6d6f46aa229582f5de8a95099'],
    ['job_queue_generation_entries_immutable',         '0df34c2b4af8d3628fe3b77885d5e3f0'],
    ['job_queue_generation_entries_no_truncate',       '0f2845e1a6add373ea5756a9f538baf6'],
    ['job_queue_generation_entries_building_only',     '9239f498636cd5f779dd27c7baa85276'],
    ['job_queue_generations_frozen',                   'ddcc16735e528255415b78dc58688278'],
    ['job_queue_generations_purge_invalidated_only',   '33ba42122c38b8c0baece4ead04e9d35']
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

    SELECT p.proconfig,
           md5(pg_catalog.pg_get_functiondef(p.oid)) AS body_md5
      INTO rec
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn_name;

    IF NOT FOUND THEN
      problems := problems || format('trigger function public.%s() is MISSING', fn_name);
      CONTINUE;
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
    'no WHEN, full triggerdef md5) with no undeclared trigger on the guarded tables, '
    '% guard bodies pinned, % R-B functions pinned',
    array_length(expected_triggers, 1),
    array_length(expected_trigger_functions, 1),
    array_length(expected_functions, 1);
END
$check$;
