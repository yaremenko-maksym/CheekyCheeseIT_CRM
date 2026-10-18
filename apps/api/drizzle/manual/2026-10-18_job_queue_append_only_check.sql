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
--   every deploy and fails if a guard is missing or not `ENABLE ALWAYS`, so a trigger
--   LEFT disabled or dropped is caught at the next deploy. Stated so nobody reads
--   more into it: it does NOT catch a disable-edit-re-enable inside one transaction,
--   and it does not compare the log against the nightly dumps.
--
-- WHY `md5(pg_get_functiondef(oid))` AND NOT `md5(prosrc)`
--   `prosrc` is the EMPTY STRING for a `BEGIN ATOMIC` body, so a manifest built on it
--   degenerates to the md5 of '' and the check would pass on any such function.
--   `pg_get_functiondef` reconstructs the whole definition — signature, `SECURITY
--   DEFINER`, the `SET search_path`, and the body — so the checksum moves if any of
--   them moves. ADR §3 condition 6 names this explicitly.
--
-- REFRESHING THE MANIFEST — the one maintenance task this file has
--   `pg_get_functiondef` output is a product of the server's deparser, so a MAJOR
--   PostgreSQL upgrade can change the text without anybody changing the function.
--   Both this cluster and production run PostgreSQL 16. When a function body changes
--   in a reviewed file (or on a major upgrade), recompute and paste:
--     SELECT p.proname, md5(pg_get_functiondef(p.oid))
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND p.proname IN ('crm_retention_purge_job_queue_actions',
--                          'crm_retention_redact_action_reason');
--   A mismatch is the check doing its job: it means the deployed body is not the
--   reviewed one. Refresh the manifest in the SAME PR that changes the body.
-- =============================================================================

DO $check$
DECLARE
  -- name, table, expected trigger timing/event bitmask, expected tgenabled
  expected_triggers CONSTANT text[][] := ARRAY[
    ['trg_job_queue_actions_append_only',                 'job_queue_actions'],
    ['trg_job_queue_actions_no_truncate',                 'job_queue_actions'],
    ['trg_job_queue_generation_entries_immutable',        'job_queue_generation_entries'],
    ['trg_job_queue_generation_entries_no_truncate',      'job_queue_generation_entries'],
    ['trg_job_queue_generation_entries_building_only',    'job_queue_generation_entries'],
    ['trg_job_queue_generations_frozen',                  'job_queue_generations'],
    ['trg_job_queue_generations_purge_invalidated_only',  'job_queue_generations']
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

    SELECT t.tgenabled, t.tgisinternal INTO rec
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = tbl_name AND t.tgname = trg_name;

    IF NOT FOUND THEN
      problems := problems || format('trigger %s is MISSING from public.%s', trg_name, tbl_name);
    ELSIF rec.tgenabled <> 'A' THEN
      problems := problems || format(
        'trigger %s on public.%s is not ENABLE ALWAYS (tgenabled = %L)',
        trg_name, tbl_name, rec.tgenabled);
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
    'r5 Task 1.3b catalog check OK: % triggers ENABLE ALWAYS, % guard bodies pinned, % R-B functions pinned',
    array_length(expected_triggers, 1),
    array_length(expected_trigger_functions, 1),
    array_length(expected_functions, 1);
END
$check$;
