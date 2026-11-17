import { Trans } from '@lingui/react/macro'
import type { SourcingNotice } from '@crm/shared'
import { AlertTriangle } from 'lucide-react'

interface AiLimitsNoticeProps {
  notice: SourcingNotice | undefined
  testId: string
}

/**
 * ADR 2026-11-03 §H.8: the model stage stopped on the AI limits. The live region is always mounted so
 * a screen reader announces the text when it appears; the text itself renders only while the field is set.
 */
export function AiLimitsNotice({ notice, testId }: AiLimitsNoticeProps) {
  return (
    <div role="status" className="empty:hidden">
      {notice === 'AI_LIMITS_EXHAUSTED' && (
        <p
          data-testid={testId}
          className="flex items-start gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <Trans>
            Пошук вакансій тимчасово недоступний: ліміти AI-моделей на зараз вичерпано. Спробуйте
            пізніше.
          </Trans>
        </p>
      )}
    </div>
  )
}
