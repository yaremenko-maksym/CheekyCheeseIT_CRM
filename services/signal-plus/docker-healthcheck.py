#!/usr/bin/env python3
"""Docker HEALTHCHECK for signal-plus — no HTTP port to curl (the task is
explicit: "Никаких портов наружу"), and no heartbeat-file concept exists
anywhere in signal_plus/*.py today (checked: `grep -rniE "heartbeat|health"
signal_plus/ tests/` — zero matches). Inventing one would mean either editing
signal_plus/*.py (out of this step's zone — see the task file's "Зона
записи") or a heartbeat this script itself fabricates by touching a file on
a timer, which would only prove THIS PROCESS is alive, not the actual daemon.

Instead this reuses the daemon's own real contract, via its real modules
(signal_plus.config/state/slot — imported, not re-implemented), so it cannot
silently drift from what the daemon actually does:

Per task-signal-plus-service.md AC4 (step 1, already implemented and tested),
by the configured HANDOVER_TIME cutoff the daemon MUST have recorded, for
today, either a successful send (``last_success_date``) or a handover
give-up (``handover_date``) — those are the two ways requirement 9's cycle
ends. So:

  - today already resolved (either date == today)      -> healthy
  - today not resolved yet, but still before cutoff     -> healthy (normal:
    waiting for the slot, mid-retry-backoff, or mid auto-update)
  - today not resolved AND at/after cutoff              -> UNHEALTHY: the
    daemon's own invariant says this should never be true at this point,
    so something is actually stuck (hung process, deadlock, crash that
    left the container running) rather than merely idle.

This intentionally never fires "unhealthy" during the many-hours-long
ordinary idle stretches (pre-slot wait, post-success rest-of-day) that a
plain state-file-mtime-freshness check would misfire on.

task-signal-plus-sunday-skip.md AC6: on a skipped weekday (Sunday by
default, ``config.skip_weekdays``) ``signal_plus.cli.run_cycle`` no-ops
entirely and never writes EITHER ``last_success_date`` or ``handover_date``
-- so without the check below, this script would misreport UNHEALTHY every
single skipped day once past the cutoff, despite nothing being wrong.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

try:
    from signal_plus import slot
    from signal_plus import state as state_mod
    from signal_plus.config import Config, ConfigError
except Exception as exc:  # pragma: no cover - would mean a broken image build
    print(f"UNHEALTHY: cannot import signal_plus: {exc}", file=sys.stderr)
    sys.exit(1)


def check(now: datetime) -> tuple[bool, str]:
    try:
        config = Config.from_env()
    except ConfigError as exc:
        return False, f"bad configuration: {exc}"

    try:
        st = state_mod.load(config.state_file)
    except state_mod.StateError as exc:
        return False, f"state file is corrupt: {exc}"

    today = now.astimezone(slot.TIMEZONE).date()

    if slot.is_skipped_weekday(today, skip_weekdays=config.skip_weekdays):
        return True, f"{today} ({today.strftime('%A')}) is a skipped weekday; no roll-call expected"
    if st.last_success_date == today:
        return True, f"already sent today ({today})"
    if st.handover_date == today:
        return True, f"gave up for today ({today}) at the handover cutoff; waiting for tomorrow"
    if not slot.is_past_cutoff(now, cutoff=config.handover_time):
        return True, f"{today} not resolved yet, still before the {config.handover_time} Kyiv handover cutoff"

    return False, (
        f"past the {config.handover_time} Kyiv handover cutoff with neither a successful "
        f"send nor a recorded handover for {today} -- the daemon should have resolved one or "
        f"the other by now (last_error={st.last_error!r})"
    )


def main() -> int:
    ok, detail = check(datetime.now(timezone.utc))
    stream = sys.stdout if ok else sys.stderr
    print(f"{'OK' if ok else 'UNHEALTHY'}: {detail}", file=stream)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
