/**
 * The API-log alert's patterns, as the TESTS in this package see them — ONE copy.
 *
 * The owner is `scripts/devops/check-api-permission-denied.sh` (PR #1041): the shell variables
 * `PERMISSION_DENIED_CONTRACT_RE` and `PERMISSION_DENIED_RE`, which it also prints via
 * `--print-contract-pattern` and `--print-pattern`. The alert runs them through `grep -Ei`, so
 * the flag here is case-insensitive too.
 *
 * Text copied from #1041 at `28cfca9ae`:
 *   PERMISSION_DENIED_CONTRACT_RE='db_privilege_denied.*sqlstate=42501'
 *   PERMISSION_DENIED_RE="${PERMISSION_DENIED_CONTRACT_RE}"'|permission denied|must be (owner|superuser)'
 *
 * THIS IS A COPY, and a copy can rot unnoticed: an earlier pair of copies kept asserting a
 * `(sqlstate|code)…42501` branch the alert no longer had, and lacked the `i` flag, so they
 * described a pattern that did not exist while passing. Once #1041 is on main, replace the
 * two constants below with a read of `--print-contract-pattern` / `--print-pattern`
 * (`new RegExp(output, 'i')`) and delete the literals.
 */

/** What the alert treats as THE contract: the pool-level line. */
export const ALERT_CONTRACT_PATTERN = /db_privilege_denied.*sqlstate=42501/i

/** Everything that pages: the contract, plus the English text of a privilege error. */
export const ALERT_PATTERN =
  /db_privilege_denied.*sqlstate=42501|permission denied|must be (owner|superuser)/i
