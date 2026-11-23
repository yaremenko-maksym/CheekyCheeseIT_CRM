-- =============================================================================
-- Remove The Muse (MUSE_API) from the database: its rows and its enum label
-- =============================================================================
--
-- APPLY (one transaction, so a failure rolls back the rows, the type and the trigger state):
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
--
-- WHY
--   The vendor removed The Muse public API (404 on 2026-11-23) and the code no longer knows the
--   type: the shared Zod enum has no MUSE_API, so a prod row of that type would fail to parse in
--   the new API. This file therefore MUST be applied before the container swap.
--
-- OWNER DECISION (A3, 2026-11-23): remove The Muse fully, INCLUDING its rows in the append-only
--   job_source_health_events. That log is evidence and is never pruned (ADR 2026-10-25 section 10);
--   this file is the one sanctioned exception. The trigger function has no bypass switch, so the
--   row guard is disabled for the length of one DELETE, inside this transaction, and restored to
--   ENABLE ALWAYS before the statement ends. Any failure rolls the whole file back, the trigger
--   state included. The deploy applies this as POSTGRES_USER, the same role that runs
--   `ALTER TABLE ... ENABLE ALWAYS TRIGGER` in 2026-10-31_job_source_health_events.sql on every
--   deploy, so it owns the table; the file still checks that before it touches the trigger.
--
-- WHAT IT DOES
--   Step 1 (rows). The MUSE_API source, its collection runs and their health events are deleted,
--     in that FK order. Counts are bounded: at most 1 source (the 2026-11-23 prod read), at most 100
--     runs and 100 events (the read was 3 and 5; the source runs until the deploy); every other FK that points at the source or the runs and would act
--     silently (SET NULL / CASCADE) must have no rows, the RESTRICT ones fail on their own.
--   Step 2 (the type). Postgres cannot drop an enum label, so the type is rebuilt without it:
--     every CHECK constraint, index and column default that names the type is captured with
--     pg_get_constraintdef / pg_get_indexdef / pg_get_expr, dropped, the old type is renamed, a new
--     one is created with the remaining labels in their enumsortorder, every column (and the
--     array column) is converted through text, the captured definitions are re-executed verbatim,
--     the old type is dropped without CASCADE (anything still on it fails the file), and a closing
--     check compares every definition with its captured text.
--
-- IDEMPOTENT
--   Replay: step 1 finds no source and does nothing; step 2 finds no MUSE_API label and does
--   nothing. On a fresh database the label is never created (2026-10-05_vacancy_sourcing_schema.sql
--   no longer adds it, 2026-10-05_vacancy_sources_seed.sql no longer inserts the row), so both
--   steps are no-ops there too.
--
-- LOCKS
--   Step 2 takes ACCESS EXCLUSIVE on job_sources, job_postings, job_source_records,
--   job_bridge_deliveries and job_team_triage_subscriptions and rewrites them (job_source_records
--   is the large one, about 13 MB on 2026-11-23). lock_timeout bounds the wait for the locks.
-- =============================================================================

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- Step 1: the Muse rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  muse_sources uuid[];
  muse_runs uuid[];
  n_events bigint;
  n_deleted bigint;
  n_refs bigint;
  trg_state "char";
  fk record;
BEGIN
  -- `type::text`: the comparison must still parse once the label is gone (replay).
  SELECT coalesce(array_agg(id), '{}') INTO muse_sources
    FROM job_sources WHERE type::text = 'MUSE_API';
  SELECT coalesce(array_agg(id), '{}') INTO muse_runs
    FROM job_collection_runs WHERE source_id = ANY (muse_sources);
  SELECT count(*) INTO n_events
    FROM job_source_health_events WHERE source_id = ANY (muse_sources);

  -- The 2026-11-23 prod read was 1 source, 3 runs, 5 health events. The source stays enabled until
  -- the deploy, so runs and events may grow; their caps are a sanity bound, not the exact read.
  IF cardinality(muse_sources) > 1 OR cardinality(muse_runs) > 100 OR n_events > 100 THEN
    RAISE EXCEPTION 'remove_muse_api: more Muse rows than expected: sources %/1, runs %/100, health events %/100',
      cardinality(muse_sources), cardinality(muse_runs), n_events;
  END IF;

  IF cardinality(muse_sources) = 0 THEN
    RAISE NOTICE 'remove_muse_api: no MUSE_API source, step 1 has nothing to delete';
    RETURN;
  END IF;

  -- A SET NULL / CASCADE / SET DEFAULT foreign key would rewrite or delete rows silently; none of
  -- them may have a row pointing at what is about to go. RESTRICT / NO ACTION ones fail on their own.
  FOR fk IN
    SELECT k.conname, k.conrelid::regclass AS rel, k.confrelid, a.attname
      FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f'
       AND k.confrelid IN ('job_sources'::regclass, 'job_collection_runs'::regclass)
       AND k.confdeltype NOT IN ('r', 'a')
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = ANY ($1)', fk.rel, fk.attname)
      INTO n_refs
      USING CASE WHEN fk.confrelid = 'job_sources'::regclass THEN muse_sources ELSE muse_runs END;
    IF n_refs > 0 THEN
      RAISE EXCEPTION 'remove_muse_api: % row(s) of % (%) point at a Muse source or run and would be changed silently by the delete',
        n_refs, fk.rel, fk.conname;
    END IF;
  END LOOP;

  IF n_events > 0 THEN
    IF NOT pg_has_role(current_user,
                       (SELECT relowner FROM pg_class WHERE oid = 'job_source_health_events'::regclass),
                       'USAGE') THEN
      RAISE EXCEPTION 'remove_muse_api: % does not own job_source_health_events and cannot suspend its append-only trigger',
        current_user;
    END IF;
    SELECT tgenabled INTO trg_state FROM pg_trigger
     WHERE tgrelid = 'job_source_health_events'::regclass
       AND tgname = 'trg_job_source_health_events_append_only';
    IF trg_state IS DISTINCT FROM 'A' THEN
      RAISE EXCEPTION 'remove_muse_api: trg_job_source_health_events_append_only is not ENABLE ALWAYS (state %), refusing',
        coalesce(trg_state::text, 'missing');
    END IF;

    -- The one sanctioned prune of the append-only log (owner decision 2026-11-23).
    ALTER TABLE job_source_health_events DISABLE TRIGGER trg_job_source_health_events_append_only;
    DELETE FROM job_source_health_events WHERE source_id = ANY (muse_sources);
    GET DIAGNOSTICS n_deleted = ROW_COUNT;
    ALTER TABLE job_source_health_events ENABLE ALWAYS TRIGGER trg_job_source_health_events_append_only;
    IF n_deleted <> n_events THEN
      RAISE EXCEPTION 'remove_muse_api: deleted % health events, expected %', n_deleted, n_events;
    END IF;
  END IF;

  DELETE FROM job_collection_runs WHERE id = ANY (muse_runs);
  GET DIAGNOSTICS n_deleted = ROW_COUNT;
  IF n_deleted <> cardinality(muse_runs) THEN
    RAISE EXCEPTION 'remove_muse_api: deleted % runs, expected %', n_deleted, cardinality(muse_runs);
  END IF;

  DELETE FROM job_sources WHERE id = ANY (muse_sources);
  GET DIAGNOSTICS n_deleted = ROW_COUNT;
  IF n_deleted <> cardinality(muse_sources) THEN
    RAISE EXCEPTION 'remove_muse_api: deleted % sources, expected %', n_deleted, cardinality(muse_sources);
  END IF;

  -- Closing check: the guard is back exactly as the 2026-10-31 file leaves it.
  SELECT tgenabled INTO trg_state FROM pg_trigger
   WHERE tgrelid = 'job_source_health_events'::regclass
     AND tgname = 'trg_job_source_health_events_append_only';
  IF n_events > 0 AND trg_state IS DISTINCT FROM 'A' THEN
    RAISE EXCEPTION 'remove_muse_api: the append-only trigger was not restored to ENABLE ALWAYS (state %)', trg_state;
  END IF;
  RAISE NOTICE 'remove_muse_api: deleted % source(s), % run(s), % health event(s)',
    cardinality(muse_sources), cardinality(muse_runs), n_events;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 2: ALTER TYPE job_source_type without MUSE_API (rebuild, labels in their order).
-- Everything below resolves the type through search_path, so it acts on whichever
-- job_source_type the session sees and is a no-op when that type has no MUSE_API.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  typ oid;
  arr oid;
  nsp text;
  labels text;
  r record;
  n bigint;
  problems text[] := '{}';
BEGIN
  typ := to_regtype('job_source_type');
  IF typ IS NULL OR NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = typ AND enumlabel = 'MUSE_API') THEN
    RAISE NOTICE 'remove_muse_api: job_source_type has no MUSE_API, step 2 has nothing to rebuild';
    RETURN;
  END IF;
  SELECT t.typarray, n2.nspname INTO arr, nsp
    FROM pg_type t JOIN pg_namespace n2 ON n2.oid = t.typnamespace WHERE t.oid = typ;

  -- Only kinds this file knows how to carry across may depend on the type.
  FOR r IN
    SELECT d.classid, d.objid, d.objsubid, pg_describe_object(d.classid, d.objid, d.objsubid) AS what
      FROM pg_depend d
     WHERE d.refobjid IN (typ, arr) AND d.refclassid = 'pg_type'::regclass
  LOOP
    IF NOT (
         (r.classid = 'pg_type'::regclass AND r.objid = arr)
      OR (r.classid = 'pg_class'::regclass
          AND (SELECT relkind FROM pg_class WHERE oid = r.objid) IN ('r', 'p', 'i'))
      OR r.classid = 'pg_attrdef'::regclass
      OR (r.classid = 'pg_constraint'::regclass
          AND (SELECT contype FROM pg_constraint WHERE oid = r.objid) = 'c')
    ) THEN
      RAISE EXCEPTION 'remove_muse_api: unexpected dependent of job_source_type: %', r.what;
    END IF;
  END LOOP;

  -- No row may still hold the label.
  FOR r IN
    SELECT a.attrelid::regclass AS rel, a.attname, a.atttypid = arr AS is_array
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE a.atttypid IN (typ, arr) AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
  LOOP
    IF r.is_array THEN
      EXECUTE format('SELECT count(*) FROM %s WHERE %L = ANY (%I::text[])', r.rel, 'MUSE_API', r.attname) INTO n;
    ELSE
      EXECUTE format('SELECT count(*) FROM %s WHERE %I::text = %L', r.rel, r.attname, 'MUSE_API') INTO n;
    END IF;
    IF n > 0 THEN
      RAISE EXCEPTION 'remove_muse_api: % row(s) of %.% still hold MUSE_API', n, r.rel, r.attname;
    END IF;
  END LOOP;

  -- Capture every definition that names the type, BEFORE the rename (so the text says job_source_type).
  CREATE TEMP TABLE remove_muse_constraints ON COMMIT DROP AS
    SELECT k.conrelid::regclass::text AS rel, k.conname, pg_get_constraintdef(k.oid) AS def
      FROM pg_constraint k
     WHERE k.oid IN (SELECT objid FROM pg_depend
                      WHERE classid = 'pg_constraint'::regclass AND refobjid IN (typ, arr));
  CREATE TEMP TABLE remove_muse_indexes ON COMMIT DROP AS
    SELECT c.oid::regclass::text AS name, c.relname, n2.nspname, pg_get_indexdef(c.oid) AS def
      FROM pg_class c JOIN pg_namespace n2 ON n2.oid = c.relnamespace
     WHERE c.relkind = 'i'
       AND c.oid IN (SELECT objid FROM pg_depend
                      WHERE classid = 'pg_class'::regclass AND refobjid IN (typ, arr));
  CREATE TEMP TABLE remove_muse_defaults ON COMMIT DROP AS
    SELECT ad.adrelid, ad.adnum, ad.adrelid::regclass::text AS rel, a.attname,
           pg_get_expr(ad.adbin, ad.adrelid) AS expr
      FROM pg_attrdef ad
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE ad.oid IN (SELECT objid FROM pg_depend
                       WHERE classid = 'pg_attrdef'::regclass AND refobjid IN (typ, arr));

  IF EXISTS (SELECT 1 FROM remove_muse_constraints WHERE def LIKE '%MUSE_API%')
     OR EXISTS (SELECT 1 FROM remove_muse_indexes WHERE def LIKE '%MUSE_API%')
     OR EXISTS (SELECT 1 FROM remove_muse_defaults WHERE expr LIKE '%MUSE_API%') THEN
    RAISE EXCEPTION 'remove_muse_api: a constraint, index or default names MUSE_API itself and cannot be carried across';
  END IF;

  FOR r IN SELECT * FROM remove_muse_constraints LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.rel, r.conname);
  END LOOP;
  FOR r IN SELECT * FROM remove_muse_indexes LOOP
    EXECUTE format('DROP INDEX %s', r.name);
  END LOOP;
  FOR r IN SELECT * FROM remove_muse_defaults LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP DEFAULT', r.rel, r.attname);
  END LOOP;

  SELECT string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) INTO labels
    FROM pg_enum WHERE enumtypid = typ AND enumlabel <> 'MUSE_API';
  EXECUTE format('ALTER TYPE %I.job_source_type RENAME TO job_source_type_pre_muse_removal', nsp);
  EXECUTE format('CREATE TYPE %I.job_source_type AS ENUM (%s)', nsp, labels);

  FOR r IN
    SELECT a.attrelid::regclass AS rel, a.attname, a.atttypid = arr AS is_array
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE a.atttypid IN (typ, arr) AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
     ORDER BY a.attrelid, a.attnum
  LOOP
    IF r.is_array THEN
      EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE %I.job_source_type[] USING %I::text[]::%I.job_source_type[]',
                     r.rel, r.attname, nsp, r.attname, nsp);
    ELSE
      EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE %I.job_source_type USING %I::text::%I.job_source_type',
                     r.rel, r.attname, nsp, r.attname, nsp);
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM remove_muse_defaults LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET DEFAULT %s', r.rel, r.attname, r.expr);
  END LOOP;
  FOR r IN SELECT * FROM remove_muse_constraints LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.rel, r.conname, r.def);
  END LOOP;
  FOR r IN SELECT * FROM remove_muse_indexes LOOP
    EXECUTE r.def;
  END LOOP;

  -- Without CASCADE: anything still on the old type fails the whole file.
  EXECUTE format('DROP TYPE %I.job_source_type_pre_muse_removal', nsp);

  -- Closing check: every carried definition reads back exactly as captured, and the labels are
  -- the old ones minus MUSE_API, in the old order.
  typ := to_regtype(format('%I.job_source_type', nsp));
  FOR r IN SELECT * FROM remove_muse_constraints LOOP
    IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = r.rel::regclass AND conname = r.conname) IS DISTINCT FROM r.def THEN
      problems := problems || format('constraint %s changed', r.conname);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM remove_muse_indexes LOOP
    IF pg_get_indexdef(to_regclass(format('%I.%I', r.nspname, r.relname))) IS DISTINCT FROM r.def THEN
      problems := problems || format('index %s changed', r.name);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM remove_muse_defaults LOOP
    IF (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef
         WHERE adrelid = r.adrelid AND adnum = r.adnum) IS DISTINCT FROM r.expr THEN
      problems := problems || format('default of %s.%s changed', r.rel, r.attname);
    END IF;
  END LOOP;
  IF (SELECT string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) FROM pg_enum
       WHERE enumtypid = typ) IS DISTINCT FROM labels THEN
    problems := problems || 'the rebuilt label list differs'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'remove_muse_api: the rebuilt job_source_type is not in the intended state: %',
      array_to_string(problems, '; ');
  END IF;
  RAISE NOTICE 'remove_muse_api: job_source_type rebuilt without MUSE_API (% constraints, % indexes, % defaults carried)',
    (SELECT count(*) FROM remove_muse_constraints), (SELECT count(*) FROM remove_muse_indexes),
    (SELECT count(*) FROM remove_muse_defaults);
END
$$;
