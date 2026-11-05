import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import type { MessageDescriptor } from '@lingui/core'
import { jobQueueTabSchema, type JobQueueTab, type JobQueueListResponseDto } from '@crm/shared'
import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const TAB_LABEL: Record<JobQueueTab, MessageDescriptor> = {
  NEW: msg`Нові`,
  SUBMITTED: msg`Подані`,
  HIDDEN: msg`Приховані`,
}

/** Spec §4.1: a count above 999 reads «999+» so the three equal columns never overflow at 320 px. */
function formatCount(n: number): string {
  return n > 999 ? '999+' : String(n)
}

export function JobQueueStatusTabs({
  value,
  counts,
  onChange,
  children,
}: {
  value: JobQueueTab
  /** `null` before the first page arrives — labels only, never a fake 0. */
  counts: JobQueueListResponseDto['counts'] | null
  onChange: (tab: JobQueueTab) => void
  /** The selected tab's content: rendered in the tabpanel its trigger's `aria-controls` points at. */
  children?: ReactNode
}) {
  const { i18n } = useLingui()
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onChange(jobQueueTabSchema.parse(v))}
      className="min-w-0 gap-4"
    >
      <TabsList className="grid h-auto w-full grid-cols-3">
        {jobQueueTabSchema.options.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            data-testid={`job-queue-tab-${tab}`}
            className="min-h-11 min-w-0 flex-col gap-0.5 px-2 @min-[560px]:flex-row @min-[560px]:gap-2"
          >
            <span className="truncate">{i18n._(TAB_LABEL[tab])}</span>
            {counts && (
              <span className="tabular-nums text-muted-foreground">{formatCount(counts[tab])}</span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent
        value={value}
        className="mt-0 flex min-w-0 flex-col gap-4 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {children}
      </TabsContent>
    </Tabs>
  )
}
