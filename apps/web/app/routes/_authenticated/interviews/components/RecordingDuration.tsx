import { Trans } from '@lingui/react/macro'

/** A recording's duration in whole minutes (at least 1), for the recording lists and detail. */
export function RecordingDuration({ durationMs }: { durationMs: number }) {
  const minutes = Math.max(1, Math.round(durationMs / 60_000))
  return <Trans>{minutes} хв</Trans>
}
