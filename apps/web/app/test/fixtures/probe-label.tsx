import { useLingui } from '@lingui/react/macro'
import { TYPE_LABEL_MESSAGES } from '@/routes/_authenticated/finance/constants'

/** Module-level (so the React Compiler compiles it) render-time `i18n._` read. */
export function ProbeLabel() {
  const { i18n } = useLingui()
  return <div data-testid="probe-label">{i18n._(TYPE_LABEL_MESSAGES.ADMIN_INCOME)}</div>
}
