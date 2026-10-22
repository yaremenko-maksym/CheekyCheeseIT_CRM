/**
 * Generates the two SQL files that carry the privilege model to production, from the one
 * declaration in `privilege-classes.ts`:
 *
 *   drizzle/manual/2026-10-18_db_grants.sql           — applies the model (file 2 of ADR §4)
 *   drizzle/manual/2026-10-18_db_privileges_check.sql  — asserts it (the catalog check of ADR §2)
 *
 * Regenerate with `pnpm --filter @crm/api db:privileges:generate`;
 * `generate-privilege-sql.spec.ts` fails if the committed files differ from the output,
 * so neither file can be hand-edited into disagreeing with the manifest.
 *
 * WHY GENERATED, AND WHAT IT BUYS
 * -------------------------------
 * A grant and the assertion that the grant is in place are the same fact written twice.
 * Written by hand they drift — and they drift silently, because the check would then
 * assert the stale expectation and pass. Generated from one source they cannot: the only
 * thing left that can diverge is the DATABASE, which is exactly what the check is for.
 *
 * WHY PURE SQL, WITH NO psql META-COMMANDS
 * ----------------------------------------
 * `deploy.yml` applies manual files as `psql -v ON_ERROR_STOP=1 < file`, and
 * `database/manual-sql-statements.ts` (the splitter every forward-DDL spec uses) REFUSES a
 * file containing a backslash command, because such a file cannot be verified by sending
 * its statements to the server. Keeping both files free of meta-commands is what lets the
 * integration spec apply exactly the bytes production applies.
 */
import {
  ALL_TABLE_PRIVILEGES,
  CLASS_PRIVILEGES,
  CONNECTION_LIMITS,
  PRIVILEGE_CLASSES,
  RETENTION_OWNER_REDACTION_COLUMN_GRANT,
  ROLES,
  MANUAL_DDL_RELATIONS,
  appendOnlyTriggers,
  collectorColumns,
  retentionOwnerFunctions,
  retentionOwnerPrivilegesFor,
  type PrivilegeClass,
  type TablePrivilege,
} from './privilege-classes'

/** File names, so the spec, the generator and the handoff cannot disagree. */
export const GRANTS_FILE = '2026-10-18_db_grants.sql'
export const CHECK_FILE = '2026-10-18_db_privileges_check.sql'
export const ROLES_FILE = '2026-10-18_db_roles.sql'

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * Every identifier reaching the generated SQL is validated, not escaped. A name that
 * needs quoting, or that could carry SQL, is a bug in the manifest rather than something
 * to render safely — so it throws at generation time instead of producing a file nobody
 * reads closely.
 */
function ident(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `privilege manifest: ${JSON.stringify(name)} is not a plain lower-case identifier`,
    )
  }
  return name
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

const CLASSES = Object.keys(PRIVILEGE_CLASSES) as PrivilegeClass[]

/** The relations of a class, sorted, validated. */
function relationsOf(cls: PrivilegeClass): string[] {
  return [...PRIVILEGE_CLASSES[cls]].map(ident).sort()
}

function privilegesFor(cls: PrivilegeClass, role: 'app' | 'collector'): readonly TablePrivilege[] {
  return CLASS_PRIVILEGES[cls][role]
}

/**
 * `(relation, class, optional)` declaration rows, shared by several parts of the check.
 *
 * `optional` marks a relation that a manual DDL file created rather than the Drizzle
 * schema (see MANUAL_DDL_RELATIONS): it must be classified where it exists and must not be
 * required to exist, because whether it does depends on which data-fix files have run
 * against that database.
 */
function relationClassValues(): string {
  const rows = CLASSES.flatMap((cls) =>
    relationsOf(cls).map(
      (relation) =>
        `    (${literal(relation)}, ${literal(cls)}, ${
          relation in MANUAL_DDL_RELATIONS ? 'true' : 'false'
        })`,
    ),
  )
  return rows.join(',\n')
}

/**
 * `(role, class)` pairs whose class grants that role a TABLE-level `SELECT`.
 *
 * Part 3 needs this per ROLE and not only for the collector: a table-level grant expands
 * into one `information_schema.column_privileges` row per column, so "which column rows
 * are legitimate" is a different set for each role, and a part that knew only the
 * collector's set could not tell a stray column grant to the other two from an expansion.
 */
function tableSelectPairs(): string {
  const rows: string[] = []
  for (const cls of CLASSES) {
    for (const [roleKey, roleName] of [
      ['app', ROLES.app],
      ['collector', ROLES.collector],
      ['retentionOwner', ROLES.retentionOwner],
    ] as const) {
      const granted =
        roleKey === 'retentionOwner'
          ? retentionOwnerPrivilegesFor(cls)
          : privilegesFor(cls, roleKey)
      if (granted.includes('SELECT')) rows.push(`    (${literal(roleName)}, ${literal(cls)})`)
    }
  }
  // No class grants a table-level SELECT to anyone: then every column row is drift, and
  // `WHERE false` says so rather than making the CTE a syntax error.
  return rows.length === 0
    ? 'SELECT NULL::text, NULL::text WHERE false'
    : `VALUES\n${rows.join(',\n')}`
}

/** `(class, role, privilege, expected)` expectation rows — 7 privileges x 3 roles x class. */
function classPrivilegeValues(): string {
  const rows: string[] = []
  for (const cls of CLASSES) {
    for (const [roleKey, roleName] of [
      ['app', ROLES.app],
      ['collector', ROLES.collector],
      // The retention owner's table privileges are declared against a CLASS, like the
      // other two roles' — see RETENTION_OWNER_CLASSES for why that scoping is the shape
      // this needs and what reading it for every class would have granted.
      ['retentionOwner', ROLES.retentionOwner],
    ] as const) {
      const granted =
        roleKey === 'retentionOwner'
          ? retentionOwnerPrivilegesFor(cls)
          : privilegesFor(cls, roleKey)
      for (const privilege of ALL_TABLE_PRIVILEGES) {
        rows.push(
          `    (${literal(cls)}, ${literal(roleName)}, ${literal(privilege)}, ${
            granted.includes(privilege) ? 'true' : 'false'
          })`,
        )
      }
    }
  }
  return rows.join(',\n')
}

function header(file: string, title: string): string {
  return `-- ${file} — ${title}
--
-- GENERATED FILE. Do not edit by hand: regenerate with
--   pnpm --filter @crm/api db:privileges:generate
-- Source of truth: apps/api/src/database/privileges/privilege-classes.ts
-- Specification:   docs/architecture/2026-10-17-db-least-privilege-roles.md
--
-- Applied by deploy.yml as \`psql -v ON_ERROR_STOP=1 < file\`, which is statement-level
-- autocommit, so every statement below is idempotent and independently applicable.
`
}

/**
 * The collector's sequence grant: `USAGE` on the sequences OF the given tables, found
 * through `pg_depend` rather than by name.
 *
 * Exported and parameterised for one reason — so it can be RUN. No class C table is
 * assigned yet (ADR §4 step 8), so `buildGrantsSql` does not emit this block at all today,
 * which left its body — the `pg_depend` join that decides which sequences the collector
 * reaches — provable only by matching its text. `db-privileges.integration.spec.ts`
 * executes it against a probe table and asserts the OUTCOME: the class C table's sequence
 * granted, every other sequence in `public` untouched.
 *
 * `deptype IN ('a', 'i')`: 'a' is a `serial` column's owned sequence, 'i' an `IDENTITY`
 * one. A sequence created by hand and used by a DEFAULT has neither and is deliberately
 * not reached — the collector gets the sequences its own tables own, nothing else.
 */
export function collectorSequenceGrantSql(tables: readonly string[]): string {
  const names = tables.map((t) => literal(ident(t))).join(', ')
  return `DO $seqs$
DECLARE
  s text;
BEGIN
  FOR s IN
    SELECT seq.relname
      FROM pg_class seq
      JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = 'public'
      JOIN pg_depend d ON d.objid = seq.oid AND d.classid = 'pg_class'::regclass
                      AND d.deptype IN ('a', 'i')
      JOIN pg_class t ON t.oid = d.refobjid
     WHERE seq.relkind = 'S'
       AND t.relname IN (${names})
  LOOP
    EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO %I', s, ${literal(ROLES.collector)});
  END LOOP;
END
$seqs$;
`
}

/**
 * File 2 of ADR §4 — the grants, applied LAST on every deploy, as ONE transaction.
 *
 * Shape: revoke everything from the three roles, then grant back exactly what each class
 * prescribes. Re-applying it therefore also REPAIRS drift (a hand-made grant on the live
 * database is undone by the next deploy), and the single transaction means no session
 * ever observes the intermediate state in which the append-only log or a
 * migration-internal table is briefly writable.
 */
export function buildGrantsSql(): string {
  const out: string[] = []
  out.push(header(GRANTS_FILE, 'privileges per table class (ADR §2, file 2 of §4)'))
  out.push(`--
-- The reset-then-grant shape is deliberate. Without the reset, a privilege granted by
-- hand on production would survive every deploy; with it, the deploy is the only thing
-- that decides privileges. The ADR's requirement that this be one transaction is what
-- makes the reset safe: privileges are catalog rows under MVCC, so no concurrent session
-- sees the window in which the roles hold nothing.
--
-- Measured on PostgreSQL 16.15 (2026-10-18): GRANT/REVOKE on a table takes NO lock on the
-- relation, so this transaction does not block API queries. \`lock_timeout\` is therefore
-- insurance against an unforeseen wait rather than an expected one: a deploy that cannot
-- get what it needs within 10 s fails loudly and leaves the previous, consistent state.

BEGIN;

SET LOCAL lock_timeout = '10s';
`)

  out.push(`-- Fail closed if the roles file has not run: granting to a missing role would abort
-- mid-transaction anyway, but the raise names the cause and the fix.
DO $guard$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r)
    INTO missing
    FROM (VALUES (${literal(ROLES.app)}), (${literal(ROLES.collector)}), (${literal(
      ROLES.retentionOwner,
    )})) AS v(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v.r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'db-grants: role(s) % do not exist — apply ${ROLES_FILE} first (it is the FIRST manual DDL file in the deploy order)', missing
      USING ERRCODE = '42704';
  END IF;
END
$guard$;
`)

  const allRoles = [ROLES.app, ROLES.collector, ROLES.retentionOwner].map(ident).join(', ')
  out.push(`-- 1. Reset. Table-level first, so the column-level sweep below sees only true column
--    grants: revoking a privilege at table level does NOT revoke it at column level
--    (PostgreSQL REVOKE, "Notes"), which is why one statement cannot do both.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${allRoles};

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${allRoles};

DO $columns$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT table_name, column_name, privilege_type, grantee
      FROM information_schema.column_privileges
     WHERE table_schema = 'public'
       AND grantee IN (${[ROLES.app, ROLES.collector, ROLES.retentionOwner]
         .map((x) => literal(x))
         .join(', ')})
  LOOP
    EXECUTE format('REVOKE %s (%I) ON TABLE public.%I FROM %I',
                   r.privilege_type, r.column_name, r.table_name, r.grantee);
  END LOOP;
END
$columns$;
`)

  out.push('-- 2. Grant back, one statement per class and role.')
  for (const cls of CLASSES) {
    const relations = relationsOf(cls)
    const why = CLASS_PRIVILEGES[cls].why
    if (relations.length === 0) {
      out.push(`-- class ${cls}: no relations assigned. ${why}\n`)
      continue
    }
    out.push(`-- class ${cls} — ${why}`)
    for (const [roleKey, roleName] of [
      ['app', ROLES.app],
      ['collector', ROLES.collector],
      // The retention owner is granted here too, and must be: step 1 above revokes ALL
      // privileges from all three roles on every deploy, so a grant made anywhere else —
      // by the 1.3b DDL file, or by hand on production — survives exactly until the next
      // deploy and then disappears with nothing reported. The manifest is the only place
      // a privilege of this role can live and still be there tomorrow.
      ['retentionOwner', ROLES.retentionOwner],
    ] as const) {
      const privileges =
        roleKey === 'retentionOwner'
          ? retentionOwnerPrivilegesFor(cls)
          : privilegesFor(cls, roleKey)
      if (privileges.length === 0) {
        out.push(`--   ${roleName}: nothing.`)
        continue
      }
      const list = relations.map((r) => `  public.${r}`).join(',\n')
      out.push(`GRANT ${privileges.join(', ')} ON TABLE\n${list}\n  TO ${ident(roleName)};`)
    }
    out.push('')
  }

  const columnEntries = Object.entries(collectorColumns)
  out.push(`-- 3. Class D column-level SELECT for ${ROLES.collector}. A table-level grant would
--    silently cover every column, including credentials and finance columns, so class D
--    carries no table-level SELECT and the columns are named one by one.`)
  if (columnEntries.length === 0) {
    out.push('--    No class D table is assigned yet (ADR §4 step 8).\n')
  } else {
    for (const [table, columns] of columnEntries.sort(([a], [b]) => a.localeCompare(b))) {
      const cols = columns.map(ident).join(', ')
      out.push(
        `GRANT SELECT (${cols}) ON TABLE public.${ident(table)} TO ${ident(ROLES.collector)};`,
      )
    }
    out.push('')
  }

  const redaction = RETENTION_OWNER_REDACTION_COLUMN_GRANT
  out.push(`-- 3b. The ONE non-SELECT column-level grant the model admits (owner decision, 2026-10-22):
--    the reason redaction rewrites one column and gets that column, not table-level UPDATE.
--    Part 3 of the check admits exactly this tuple and still reports every other
--    column-level write.
--    The failing runs that justify this grant AND the retention owner's class B INSERT
--    above (r5 Task 1.4b-iii; PostgreSQL 16.15, scratch database, 2026-10-22), each run as
--    crm_app: SELECT crm_retention_redact_action_reason(<action id>, 'dsr-failrun', <actor id>)
--      with SELECT, DELETE                 -> SQLSTATE 42501 "permission denied for table
--                                             job_queue_actions" at the function's UPDATE
--      plus UPDATE (reason)                -> SQLSTATE 42501, same message, now at the
--                                             function's INSERT of the evidence row; the
--                                             redaction rolled back with it
--      plus INSERT                         -> true: reason redacted, one REASON_REDACTED row
--    Full record: privilege-classes.ts, RETENTION_OWNER_TABLE_PRIVILEGES.
GRANT ${redaction.privilege} (${ident(redaction.column)}) ON TABLE public.${ident(
    redaction.relation,
  )} TO ${ident(redaction.role)};
`)

  out.push(`-- 4. Sequences. ${ROLES.app} calls nextval and reads currval; never UPDATE, which is
--    setval — the ability to rewind a sequence and collide ids (ADR §2, "Sequences").
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(ROLES.app)};
`)
  const classCTables = relationsOf('C')
  if (classCTables.length === 0) {
    out.push(`-- ${ROLES.collector}: USAGE only on the sequences of its class C tables. No class C
--    table is assigned yet, so no sequence grant is issued — fail closed.
`)
  } else {
    out.push(collectorSequenceGrantSql(classCTables))
  }

  out.push(`COMMIT;
`)
  // Read off the OUTPUT, not off a counter kept alongside it: a counter can disagree with
  // what was emitted (and its arithmetic is unobservable in the generated file, so nothing
  // would notice). A grants file with no GRANT in it would silently leave the API with
  // nothing but the default privileges.
  // `ON TABLE` specifically, not any GRANT: the sequence grant is emitted unconditionally,
  // so a manifest that classified nothing would still produce a file with a GRANT in it —
  // and an API with access to every sequence and not one table.
  // Only a TABLE grant starts a chunk with `GRANT `: the sequence grant is emitted
  // unconditionally but its chunk opens with the `-- 4. Sequences.` comment, so a manifest
  // that classified nothing would otherwise produce a file granting every sequence and not
  // one table.
  if (!out.some((chunk) => chunk.startsWith('GRANT '))) {
    throw new Error('privilege manifest: no grants emitted — the manifest is empty')
  }
  return `${out.join('\n').trimEnd()}\n`
}

/**
 * One assertion of the catalog check: a SELECT that must return no row, and the message
 * raised when it does. Uniform shape so a new part is a query, not a new mechanism.
 */
function assertion(name: string, what: string, query: string): string {
  return `-- ${name}: ${what}
DO $check$
DECLARE
  offenders text;
BEGIN
${query.trimEnd()}
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — ${name}: %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;
`
}

/**
 * The catalog check of ADR §2 — nine parts, read-only, run in CI against a scratch
 * database built from the same DDL and as a deploy step right after the apply steps.
 *
 * It exits non-zero on drift through `RAISE EXCEPTION` plus `-v ON_ERROR_STOP=1`, which
 * the wiring guard (`scripts/devops/check-prod-ddl-wiring.py`) already requires of every
 * manual file — so the thing that makes this check fail the deploy is itself enforced
 * mechanically rather than by the wiring being written correctly.
 */
export function buildCheckSql(): string {
  const parts: string[] = []
  parts.push(header(CHECK_FILE, 'the catalog check of ADR §2 — nine parts, read-only'))
  parts.push(`--
-- Read-only: it asserts, it never repairs. A failure means the database and the reviewed
-- declaration disagree, and the fix is a PR, not a hand-made GRANT (ADR §4, "Rollback").
--
-- WHICH ROLE THIS IS DESIGNED FOR, AND WHY IT IS NOT A CHOICE MADE HERE
-- The deploy applies every DDL file as the migration role, and on production that role is
-- \`crm_user\`, a SUPERUSER and the only non-system role in the cluster (read from production
-- 2026-10-18). That matters for part 8, because PostgreSQL 16's automatic creator-membership
-- applies ONLY to a non-superuser with CREATEROLE. Measured both ways on 16.15, same cluster,
-- same statements:
--   creator is a superuser (production)        -> 0 membership rows for the created role
--   creator is non-superuser with CREATEROLE   -> 1 row, admin=t inherit=f set=f
-- So a check that hard-coded the row the ADR describes would pass in a non-superuser scratch
-- database and FAIL on the first production deploy; one that hard-coded "zero rows" would
-- fail any branch-2 deploy.
--
-- Part 8 therefore asserts neither count. It asserts the SHAPE of whatever rows exist,
-- unconditionally, plus "at most one of them" — which is satisfied by both measurements
-- above and by nothing else. An earlier revision derived the expected COUNT from the
-- migration role's current \`rolsuper\`, and that was wrong for a reason worth stating,
-- because it would have fired on a step the ADR itself prescribes: creator-membership is a
-- fact about WHO CREATED the role, while \`rolsuper\` is a fact about who the role is NOW,
-- and ADR §4's hardening step \`ALTER ROLE crm_user NOSUPERUSER CREATEROLE\` changes the
-- second without touching the first. On production — roles created by a superuser, so zero
-- membership rows — that step would have moved the check into the "expect exactly 1" branch
-- and failed every deploy after it, with a message whose only remedy reads
-- \`GRANT crm_app TO crm_user\`: the exact opposite of hardening. Production runs
-- PostgreSQL 16.14; nothing used in this file is newer than 16.0.
--
-- "The migration role" below is DERIVED, never named: it is the owner of the relations in
-- \`public\`. That is what makes the ADR's default-privilege trap observable — default
-- privileges apply only to objects created by the role they are attached to, so if DDL
-- ever starts running as a different role, part 5 fails instead of new tables silently
-- losing their grants.

BEGIN;
`)

  // `declared` is the manifest; `expected` is the manifest INTERSECTED with what exists.
  // Parts 2-4 use `expected`, because `has_table_privilege` on a missing relation raises
  // "relation does not exist" instead of returning false — which would turn an absent
  // optional table into an unreadable error rather than part 1's precise complaint.
  const relationClasses = `  WITH declared_relations(relation, cls, optional) AS (VALUES\n${relationClassValues()}\n  ),
  expected(relation, cls) AS (
    SELECT d.relation, d.cls
      FROM declared_relations d
      JOIN pg_class c ON c.relname = d.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
  )`
  const classPrivileges = `  class_privileges(cls, role_name, privilege, expected) AS (VALUES\n${classPrivilegeValues()}\n  )`
  const appRoles = [ROLES.app, ROLES.collector, ROLES.retentionOwner]
  const appRolesList = appRoles.map((r) => literal(r)).join(', ')
  const migrationRole = `(SELECT c.relowner::regrole::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)`

  // 1 — manifest coverage, both directions.
  parts.push(
    assertion(
      'part 1 (manifest coverage)',
      'every relation in public is classified exactly once, and the manifest names no relation that does not exist',
      `${relationClasses}
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s is in public but in no privilege class — choose one in privilege-classes.ts', c.relname) AS detail
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND c.relname NOT IN (SELECT relation FROM declared_relations)
    UNION ALL
    -- The other direction, minus the optional ones: a manual-DDL artefact (see
    -- MANUAL_DDL_RELATIONS) exists only where its data-fix file ran, so requiring it to be
    -- present would fail the check on every database that never needed the fix.
    SELECT format('%s is classified %s but does not exist in public', d.relation, d.cls)
      FROM declared_relations d
     WHERE NOT d.optional
       AND NOT EXISTS (
         SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = d.relation AND c.relkind IN ('r', 'p', 'v', 'm')
       )
  ) q;`,
    ),
  )

  // 2 — table privileges, every privilege, both directions, plus grant options.
  parts.push(
    assertion(
      'part 2 (table privileges)',
      'has_table_privilege equals the class for every relation, role and privilege — no more, no less',
      `${relationClasses},
${classPrivileges}
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s (class %s): %s %s %s but should %s it',
                  e.relation, e.cls, p.role_name,
                  CASE WHEN p.expected THEN 'lacks' ELSE 'holds' END,
                  p.privilege,
                  CASE WHEN p.expected THEN 'hold' ELSE 'not hold' END) AS detail
      FROM expected e
      JOIN class_privileges p ON p.cls = e.cls
     WHERE has_table_privilege(p.role_name, format('public.%I', e.relation), p.privilege) <> p.expected
    UNION ALL
    -- WITH GRANT OPTION is never granted on any class (ADR §2): a role that may re-grant
    -- its own privileges can widen the boundary without any DDL.
    SELECT format('%s: %s holds %s WITH GRANT OPTION', e.relation, p.role_name, p.privilege)
      FROM expected e
      JOIN class_privileges p ON p.cls = e.cls
     WHERE has_table_privilege(p.role_name, format('public.%I', e.relation),
                               p.privilege || ' WITH GRANT OPTION')
  ) q;`,
    ),
  )

  // 3 — column privileges (the view expands table grants, which is the trap).
  const redactionRole = literal(ident(RETENTION_OWNER_REDACTION_COLUMN_GRANT.role))
  const redactionRelation = literal(ident(RETENTION_OWNER_REDACTION_COLUMN_GRANT.relation))
  const redactionColumn = literal(ident(RETENTION_OWNER_REDACTION_COLUMN_GRANT.column))
  const redactionPrivilege = literal(RETENTION_OWNER_REDACTION_COLUMN_GRANT.privilege)
  parts.push(
    assertion(
      'part 3 (column privileges)',
      'the column-level SELECT set of EVERY one of the three roles equals the manifest exactly, and the one declared non-SELECT column grant is present and is the only one',
      `${relationClasses},
  -- Declared column-level grants. Only the collector has any (class D is its mechanism),
  -- but the set is keyed BY ROLE, because the role is what the comparison below joins on
  -- and a one-role set is what let a column grant to either other role pass unseen: a
  -- \`GRANT SELECT (id, email) ON users TO ${ROLES.retentionOwner}\` was invisible to this
  -- part, and the next deploy's reset (its column sweep covers all three roles) then
  -- removed it with nothing reported anywhere.
  declared(role_name, relation, column_name) AS (${
    Object.entries(collectorColumns).length === 0
      ? `SELECT NULL::text, NULL::text, NULL::text WHERE false`
      : Object.entries(collectorColumns)
          .sort(([a], [b]) => a.localeCompare(b))
          .flatMap(([table, columns]) =>
            columns.map(
              (c) => `    SELECT ${literal(ROLES.collector)}, ${literal(table)}, ${literal(c)}`,
            ),
          )
          .join('\n    UNION ALL\n    ')
  }),
  -- Which (role, class) pairs carry a table-level SELECT. information_schema.column_privileges
  -- expands a TABLE-level grant into one row per column, so the expected set is "every
  -- column of a relation whose class grants table-level SELECT to THAT role" plus the
  -- declared column-level grants. Comparing against the declared list alone would read a
  -- table-level grant as drift on every class A table; comparing only the other way would
  -- miss a stray column grant.
  role_table_select(role_name, cls) AS (${tableSelectPairs()}),
  expected_pairs(role_name, relation, column_name) AS (
    SELECT rts.role_name, c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN expected e ON e.relation = c.table_name
      JOIN role_table_select rts ON rts.cls = e.cls
     WHERE c.table_schema = 'public'
    UNION
    SELECT role_name, relation, column_name FROM declared
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s has column SELECT on %s.%s, which the manifest does not declare',
                  cp.grantee, cp.table_name, cp.column_name) AS detail
      FROM information_schema.column_privileges cp
     WHERE cp.table_schema = 'public'
       AND cp.grantee IN (${appRolesList})
       AND cp.privilege_type = 'SELECT'
       AND NOT EXISTS (SELECT 1 FROM expected_pairs e
                        WHERE e.role_name = cp.grantee
                          AND e.relation = cp.table_name AND e.column_name = cp.column_name)
    UNION ALL
    SELECT format('%s lacks the declared column SELECT on %s.%s',
                  e.role_name, e.relation, e.column_name)
      FROM expected_pairs e
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.column_privileges cp
                        WHERE cp.table_schema = 'public' AND cp.grantee = e.role_name
                          AND cp.privilege_type = 'SELECT'
                          AND cp.table_name = e.relation AND cp.column_name = e.column_name)
    UNION ALL
    -- Any privilege other than SELECT, at column level, for any of the three roles —
    -- except the ONE declared tuple (RETENTION_OWNER_REDACTION_COLUMN_GRANT, owner
    -- decision 2026-10-22). All four fields must match for the exemption to apply: the
    -- same privilege on another column, or on this column for another role, is reported.
    SELECT format('%s holds column %s on %s.%s — only SELECT is ever granted at column level',
                  cp.grantee, cp.privilege_type, cp.table_name, cp.column_name)
      FROM information_schema.column_privileges cp
      JOIN expected e ON e.relation = cp.table_name
     WHERE cp.table_schema = 'public'
       AND cp.grantee IN (${appRolesList})
       AND cp.privilege_type <> 'SELECT'
       AND NOT has_table_privilege(cp.grantee, format('public.%I', cp.table_name), cp.privilege_type)
       AND NOT (cp.grantee = ${redactionRole}
                AND cp.table_name = ${redactionRelation}
                AND cp.column_name = ${redactionColumn}
                AND cp.privilege_type = ${redactionPrivilege})
    UNION ALL
    -- ...and that one declared tuple must actually be there, wherever its relation exists.
    -- Without this half, a deploy that lost the grant would pass the check and leave the
    -- redaction raising 42501 — the INERT state this exception exists to end — unreported.
    SELECT format('%s lacks the declared column %s on %s.%s',
                  ${redactionRole}, ${redactionPrivilege}, ${redactionRelation}, ${redactionColumn})
     WHERE EXISTS (SELECT 1 FROM expected e WHERE e.relation = ${redactionRelation})
       AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges cp
                        WHERE cp.table_schema = 'public'
                          AND cp.grantee = ${redactionRole}
                          AND cp.table_name = ${redactionRelation}
                          AND cp.column_name = ${redactionColumn}
                          AND cp.privilege_type = ${redactionPrivilege})
  ) q;`,
    ),
  )

  // 4 — sequences.
  parts.push(
    assertion(
      'part 4 (sequence privileges)',
      'crm_app holds USAGE and SELECT and never UPDATE; the collector holds USAGE only on its class C sequences',
      `${relationClasses},
  sequences(seq, owning_table) AS (
    SELECT s.relname, t.relname
      FROM pg_class s
      JOIN pg_namespace n ON n.oid = s.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                           AND d.deptype IN ('a', 'i')
      LEFT JOIN pg_class t ON t.oid = d.refobjid
     WHERE s.relkind = 'S'
  ),
  wanted(role_name, privilege, expected_expr) AS (VALUES
    (${literal(ROLES.app)}, 'USAGE', 'app'),
    (${literal(ROLES.app)}, 'SELECT', 'app'),
    (${literal(ROLES.app)}, 'UPDATE', 'never'),
    (${literal(ROLES.collector)}, 'USAGE', 'class_c'),
    (${literal(ROLES.collector)}, 'SELECT', 'never'),
    (${literal(ROLES.collector)}, 'UPDATE', 'never'),
    (${literal(ROLES.retentionOwner)}, 'USAGE', 'never'),
    (${literal(ROLES.retentionOwner)}, 'SELECT', 'never'),
    (${literal(ROLES.retentionOwner)}, 'UPDATE', 'never')
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('sequence %s: %s %s %s', s.seq, w.role_name,
                  CASE WHEN expect THEN 'lacks' ELSE 'holds' END, w.privilege) AS detail
      FROM sequences s
      CROSS JOIN wanted w
      CROSS JOIN LATERAL (
        SELECT CASE w.expected_expr
                 WHEN 'app' THEN true
                 WHEN 'never' THEN false
                 ELSE EXISTS (SELECT 1 FROM expected e
                               WHERE e.relation = s.owning_table AND e.cls = 'C')
               END AS expect
      ) x
     WHERE has_sequence_privilege(w.role_name, format('public.%I', s.seq), w.privilege) <> x.expect
  ) q;`,
    ),
  )

  // 5 — default privileges.
  parts.push(
    assertion(
      'part 5 (default privileges)',
      'pg_default_acl holds exactly the two entries the roles file sets — sequences and the function revoke, nothing on TABLES — attached to the migration role',
      `  WITH migration_role AS (SELECT ${migrationRole} AS role_name),
  actual(objtype, in_public, grantee, privilege_type, grantable, defacl_role) AS (
    SELECT d.defaclobjtype, d.defaclnamespace = 'public'::regnamespace,
           a.grantee::regrole::text, a.privilege_type, a.is_grantable,
           d.defaclrole::regrole::text
      FROM pg_default_acl d, aclexplode(d.defaclacl) a
  ),
  expected(objtype, in_public, grantee, privilege_type) AS (VALUES
    -- NO 'r' (tables and views) ROW, and the absence is the assertion: a default privilege
    -- on TABLES also applies to VIEWS, and an auto-updatable view writes its base tables
    -- as the VIEW OWNER — so one would reopen every class whose point is a revoke. If one
    -- is ever added back by hand, the first branch below names it and fails the deploy.
    ('S', true, ${literal(ROLES.app)}, 'USAGE'),
    ('S', true, ${literal(ROLES.app)}, 'SELECT'),
    -- The functions entry carries no PUBLIC row: that absence IS the revoke, and the
    -- owner's own EXECUTE is what remains.
    ('f', false, (SELECT role_name FROM migration_role), 'EXECUTE')
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('unexpected default privilege: %s may %s on new %s objects%s',
                  a.grantee, a.privilege_type, a.objtype,
                  CASE WHEN a.grantable THEN ' WITH GRANT OPTION' ELSE '' END) AS detail
      FROM actual a
     WHERE NOT EXISTS (SELECT 1 FROM expected e
                        WHERE e.objtype = a.objtype AND e.in_public = a.in_public
                          AND e.grantee = a.grantee AND e.privilege_type = a.privilege_type)
        OR a.grantable
    UNION ALL
    SELECT format('missing default privilege: %s should get %s on new %s objects',
                  e.grantee, e.privilege_type, e.objtype)
      FROM expected e
     WHERE NOT EXISTS (SELECT 1 FROM actual a
                        WHERE a.objtype = e.objtype AND a.in_public = e.in_public
                          AND a.grantee = e.grantee AND a.privilege_type = e.privilege_type)
    UNION ALL
    -- The trap of ADR §2: default privileges apply only to objects created by the role
    -- they are attached to. If DDL ever runs as another role, new tables silently get no
    -- grants — unless this row fails first.
    SELECT format('default privileges are attached to %s but %s owns the tables in public',
                  a.defacl_role, m.role_name)
      FROM actual a, migration_role m
     WHERE a.defacl_role <> m.role_name
  ) q;`,
    ),
  )

  // 6 — database, schema and function privileges.
  parts.push(
    assertion(
      'part 6 (database, schema and function privileges)',
      'CONNECT on this database only, TEMPORARY and CREATE nowhere, and PUBLIC holds EXECUTE on no function in public',
      `  WITH roles(role_name, connects) AS (VALUES
    (${literal(ROLES.app)}, true),
    (${literal(ROLES.collector)}, true),
    (${literal(ROLES.retentionOwner)}, false)
  ),
  other_databases AS (
    SELECT datname FROM pg_database
     WHERE datname IN ('postgres', 'template1') AND datallowconn
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s: CONNECT on %s is %s, expected %s', r.role_name, current_database(),
                  has_database_privilege(r.role_name, current_database(), 'CONNECT'), r.connects) AS detail
      FROM roles r
     WHERE has_database_privilege(r.role_name, current_database(), 'CONNECT') <> r.connects
    UNION ALL
    SELECT format('%s holds TEMPORARY on %s', r.role_name, current_database())
      FROM roles r
     WHERE has_database_privilege(r.role_name, current_database(), 'TEMPORARY')
    UNION ALL
    SELECT format('%s holds CREATE on database %s', r.role_name, current_database())
      FROM roles r
     WHERE has_database_privilege(r.role_name, current_database(), 'CREATE')
    UNION ALL
    -- The other databases of the cluster: without this, crm_app could still connect to
    -- \`postgres\` and create temporary tables there (ADR §2, "Database and schema").
    SELECT format('%s holds %s on database %s', r.role_name, p.privilege, d.datname)
      FROM roles r, other_databases d,
           (VALUES ('CONNECT'), ('TEMPORARY')) AS p(privilege)
     WHERE has_database_privilege(r.role_name, d.datname, p.privilege)
    UNION ALL
    SELECT format('PUBLIC holds %s on database %s', p.privilege, d.datname)
      FROM other_databases d, (VALUES ('CONNECT'), ('TEMPORARY')) AS p(privilege)
     WHERE EXISTS (
       SELECT 1 FROM pg_database db, aclexplode(COALESCE(db.datacl, acldefault('d', db.datdba))) a
        WHERE db.datname = d.datname AND a.grantee = 0 AND a.privilege_type = p.privilege
     )
    UNION ALL
    SELECT format('PUBLIC holds %s on database %s', p.privilege, current_database())
      FROM (VALUES ('CONNECT'), ('TEMPORARY'), ('CREATE')) AS p(privilege)
     WHERE EXISTS (
       SELECT 1 FROM pg_database db, aclexplode(COALESCE(db.datacl, acldefault('d', db.datdba))) a
        WHERE db.datname = current_database() AND a.grantee = 0 AND a.privilege_type = p.privilege
     )
    UNION ALL
    SELECT format('%s lacks USAGE on schema public', r.role_name)
      FROM roles r
     WHERE NOT has_schema_privilege(r.role_name, 'public', 'USAGE')
    UNION ALL
    SELECT format('%s holds CREATE on schema public', r.role_name)
      FROM roles r
     WHERE has_schema_privilege(r.role_name, 'public', 'CREATE')
    UNION ALL
    SELECT 'PUBLIC holds CREATE on schema public'
     WHERE EXISTS (
       SELECT 1 FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
        WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'
     )
    UNION ALL
    -- A NULL proacl means the DEFAULT acl, which grants EXECUTE to PUBLIC — so the
    -- COALESCE is the whole point: without it a brand-new function reads as locked down.
    SELECT format('PUBLIC holds EXECUTE on function public.%s', p.proname)
      FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.pronamespace = 'public'::regnamespace
       AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) q;`,
    ),
  )

  // 7 — role attributes and ownership.
  parts.push(
    assertion(
      'part 7 (role attributes and ownership)',
      'the three roles are unprivileged, own nothing beyond what is declared, and have the declared connection limits',
      `  WITH wanted(role_name, can_login, conn_limit) AS (VALUES
    (${literal(ROLES.app)}, true, ${CONNECTION_LIMITS[ROLES.app]}),
    (${literal(ROLES.collector)}, true, ${CONNECTION_LIMITS[ROLES.collector]}),
    (${literal(ROLES.retentionOwner)}, false, 0)
  ),
  declared_functions(proname) AS (${
    retentionOwnerFunctions.length === 0
      ? 'SELECT NULL::text WHERE false'
      : retentionOwnerFunctions.map((f) => `SELECT ${literal(f)}`).join('\n    UNION ALL\n    ')
  })
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('role %s does not exist', w.role_name) AS detail
      FROM wanted w
     WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = w.role_name)
    UNION ALL
    SELECT format('role %s has attribute %s', r.rolname, a.attribute)
      FROM pg_roles r
      JOIN wanted w ON w.role_name = r.rolname
      CROSS JOIN LATERAL (VALUES
        ('SUPERUSER', r.rolsuper), ('CREATEROLE', r.rolcreaterole),
        ('CREATEDB', r.rolcreatedb), ('BYPASSRLS', r.rolbypassrls),
        ('REPLICATION', r.rolreplication)
      ) AS a(attribute, held)
     WHERE a.held
    UNION ALL
    SELECT format('role %s: rolcanlogin is %s, expected %s', r.rolname, r.rolcanlogin, w.can_login)
      FROM pg_roles r JOIN wanted w ON w.role_name = r.rolname
     WHERE r.rolcanlogin <> w.can_login
    UNION ALL
    SELECT format('role %s: CONNECTION LIMIT is %s, expected %s', r.rolname, r.rolconnlimit, w.conn_limit)
      FROM pg_roles r JOIN wanted w ON w.role_name = r.rolname
     WHERE r.rolconnlimit <> w.conn_limit
    UNION ALL
    SELECT format('role %s owns relation %s', c.relowner::regrole::text, c.relname)
      FROM pg_class c JOIN wanted w ON w.role_name = c.relowner::regrole::text
    UNION ALL
    SELECT format('role %s owns schema %s', n.nspowner::regrole::text, n.nspname)
      FROM pg_namespace n JOIN wanted w ON w.role_name = n.nspowner::regrole::text
    UNION ALL
    -- The retention owner will own exactly the declared functions (Task 1.3b). Until then
    -- the declared list is empty, so this pins "owns nothing" and the PR that adds a
    -- function must add its name to the manifest in the same diff.
    SELECT format('role %s owns function %s, which the manifest does not declare',
                  p.proowner::regrole::text, p.proname)
      FROM pg_proc p JOIN wanted w ON w.role_name = p.proowner::regrole::text
     WHERE p.proname NOT IN (SELECT proname FROM declared_functions)
    UNION ALL
    SELECT format('declared function %s is not owned by %s', f.proname, ${literal(
      ROLES.retentionOwner,
    )})
      FROM declared_functions f
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                        WHERE p.proname = f.proname
                          AND p.proowner::regrole::text = ${literal(ROLES.retentionOwner)})
  ) q;`,
    ),
  )

  // 8 — role membership, both directions, branch-aware.
  parts.push(
    assertion(
      'part 8 (role membership)',
      'the three roles are members of no role; the only membership OF them is one creator-membership row of the exact shape PostgreSQL 16 produces',
      `  WITH wanted(role_name) AS (VALUES (${literal(ROLES.app)}), (${literal(
        ROLES.collector,
      )}), (${literal(ROLES.retentionOwner)})),
  migration_role AS (SELECT ${migrationRole} AS role_name)
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    -- The direction that matters: membership is what would let these roles SET ROLE to an
    -- owner and get ownership back.
    SELECT format('%s is a member of %s — it must be a member of no role',
                  m.member::regrole::text, m.roleid::regrole::text) AS detail
      FROM pg_auth_members m
      JOIN wanted w ON w.role_name = m.member::regrole::text
    UNION ALL
    -- The other direction, asserted by SHAPE and never by count. On PostgreSQL 16 a
    -- non-superuser with CREATEROLE is automatically made a member of every role it
    -- creates, with ADMIN and without INHERIT or SET (reproduced on 16.15, 2026-10-18),
    -- while a superuser creator produces no row at all. Both are legitimate, both are
    -- allowed here, and ZERO rows is therefore not an error — which is what keeps this
    -- part quiet through ADR §4's \`ALTER ROLE crm_user NOSUPERUSER CREATEROLE\` on a
    -- cluster whose roles a superuser created (see the header).
    --
    -- The row is harmless; what is not harmless is INHERIT or SET, or a member that is
    -- not the migration role. That is what this asserts on every deploy, because
    -- createrole_self_grant in the roles file constrains only the moment the grant is
    -- made: holding ADMIN, the migration role can re-grant itself WITH SET at any time.
    SELECT format('%s has member %s (admin=%s inherit=%s set=%s), which is not the creator-membership shape',
                  m.roleid::regrole::text, m.member::regrole::text,
                  m.admin_option, m.inherit_option, m.set_option)
      FROM pg_auth_members m
      JOIN wanted w ON w.role_name = m.roleid::regrole::text
      CROSS JOIN migration_role mr
     WHERE m.member::regrole::text <> mr.role_name
        OR NOT m.admin_option
        OR m.inherit_option
        OR m.set_option
    UNION ALL
    -- At most ONE such row, by arithmetic rather than by shape. What that catches is a
    -- SECOND MEMBER: measured on 16.15 (2026-10-18), a second grant of the same role to
    -- the SAME member from a different grantor is MERGED into the existing row rather
    -- than added, so "two rows" always means two members, and the row the predicate above
    -- would name is not necessarily the one that is extra. Kept for two reasons that do
    -- not depend on that measurement holding: it is arithmetic over the whole set, so it
    -- survives any narrowing of the predicate above, and it is what would catch a future
    -- PostgreSQL that records per-grantor rows for one member. Zero rows is NOT an error
    -- here — the superuser branch produces none (see the header).
    SELECT format('%s has %s membership rows, expected at most 1 (the creator-membership row)',
                  w.role_name, count(m.member))
      FROM wanted w
      LEFT JOIN pg_auth_members m ON m.roleid::regrole::text = w.role_name
     GROUP BY w.role_name
    HAVING count(m.member) > 1
  ) q;`,
    ),
  )

  // 9 — class B triggers.
  const triggerRows = Object.entries(appendOnlyTriggers).flatMap(([table, triggers]) =>
    triggers.map((t) => `    (${literal(table)}, ${literal(t.name)}, ${literal(t.enabled)})`),
  )
  parts.push(
    assertion(
      'part 9 (append-only triggers)',
      'every class B table carries exactly its declared triggers, in the declared enabled state',
      `  WITH declared(table_name, trigger_name, enabled) AS (${
        triggerRows.length === 0
          ? 'SELECT NULL::text, NULL::text, NULL::"char" WHERE false'
          : `VALUES\n${triggerRows.join(',\n')}`
      }),
  class_b(table_name) AS (${
    relationsOf('B').length === 0
      ? 'SELECT NULL::text WHERE false'
      : relationsOf('B')
          .map((t) => `SELECT ${literal(t)}`)
          .join('\n    UNION ALL\n    ')
  }),
  actual(table_name, trigger_name, enabled) AS (
    SELECT c.relname, t.tgname, t.tgenabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN class_b b ON b.table_name = c.relname
     WHERE NOT t.tgisinternal
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s.%s exists but is not declared in privilege-classes.ts',
                  a.table_name, a.trigger_name) AS detail
      FROM actual a
     WHERE NOT EXISTS (SELECT 1 FROM declared d
                        WHERE d.table_name = a.table_name AND d.trigger_name = a.trigger_name)
    UNION ALL
    SELECT format('declared trigger %s.%s is missing', d.table_name, d.trigger_name)
      FROM declared d
     WHERE NOT EXISTS (SELECT 1 FROM actual a
                        WHERE a.table_name = d.table_name AND a.trigger_name = d.trigger_name)
    UNION ALL
    SELECT format('trigger %s.%s is in state %s, expected %s (A = ENABLE ALWAYS)',
                  a.table_name, a.trigger_name, a.enabled, d.enabled)
      FROM actual a
      JOIN declared d ON d.table_name = a.table_name AND d.trigger_name = a.trigger_name
     WHERE a.enabled <> d.enabled
  ) q;`,
    ),
  )

  parts.push(`DO $ok$
BEGIN
  RAISE NOTICE 'db-privileges check passed: % relations classified, roles %, %, %',
    ${CLASSES.reduce(
      (n, cls) => n + PRIVILEGE_CLASSES[cls].length,
      0,
    )}, ${literal(ROLES.app)}, ${literal(ROLES.collector)}, ${literal(ROLES.retentionOwner)};
END
$ok$;

COMMIT;
`)

  return `${parts.join('\n').trimEnd()}\n`
}
