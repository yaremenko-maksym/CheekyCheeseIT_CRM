import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import {
  seniorAvailabilityResponseSchema,
  seniorAvailabilitySchema,
  type SeniorAvailabilityDto,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DatePickerField } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { api } from '@/lib/axios'
import { SeniorAvailabilityLabel } from './SeniorAvailabilityLabel'

type Status = SeniorAvailabilityDto['status']

const availabilityKey = (userId: string) => ['senior-availability', userId] as const

/**
 * A senior's availability (vacancy-queue design §5.2), set on the senior's profile: by the senior
 * themself or by an ADMIN (the API refuses everyone else). HR reads it on the queue card only.
 */
export function SeniorAvailabilitySection({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: availabilityKey(userId),
    queryFn: () =>
      api
        .get<unknown>(`/users/${userId}/availability`)
        .then((r) => seniorAvailabilityResponseSchema.parse(r.data)),
  })
  return (
    <Card data-testid="senior-availability-section">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <Trans>Доступність</Trans>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending && (
          <p className="text-sm text-muted-foreground">
            <Trans>Завантаження…</Trans>
          </p>
        )}
        {query.isError && (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Не вдалося завантажити доступність</Trans>
          </p>
        )}
        {query.isSuccess && (
          // keyed on the saved value: a fresh save re-seeds the draft instead of an effect
          <AvailabilityForm key={JSON.stringify(query.data)} userId={userId} saved={query.data} />
        )}
      </CardContent>
    </Card>
  )
}

function AvailabilityForm({
  userId,
  saved,
}: {
  userId: string
  saved: SeniorAvailabilityDto | null
}) {
  const { t } = useLingui()
  const qc = useQueryClient()
  const [status, setStatus] = useState<Status>(saved?.status ?? 'FREE')
  const [day, setDay] = useState(saved?.status === 'FREE' ? saved.availableFrom : '')
  const save = useMutation({
    mutationFn: (body: SeniorAvailabilityDto) =>
      api
        .put<unknown>(`/users/${userId}/availability`, body)
        .then((r) => seniorAvailabilitySchema.parse(r.data)),
    onSuccess: (next) => {
      qc.setQueryData(availabilityKey(userId), next)
      toast.success(t`Доступність збережено`)
    },
    onError: () => toast.error(t`Не вдалося зберегти доступність. Спробуйте ще раз`),
  })
  const body: SeniorAvailabilityDto | null =
    status === 'BUSY' ? { status } : day !== '' ? { status, availableFrom: day } : null

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (body !== null) save.mutate(body)
      }}
    >
      <p className="text-sm" data-testid="senior-availability-current">
        {saved === null ? (
          <span className="text-muted-foreground">
            <Trans>Не вказано</Trans>
          </span>
        ) : (
          <SeniorAvailabilityLabel availability={saved} className="text-sm" />
        )}
      </p>
      <SegmentedToggle<Status>
        value={status}
        onChange={setStatus}
        ariaLabel={t`Доступність`}
        testId="senior-availability-status"
        options={[
          { value: 'FREE', label: t`Вільно`, testIdSuffix: 'free' },
          { value: 'BUSY', label: t`Зайнято`, testIdSuffix: 'busy' },
        ]}
      />
      {status === 'FREE' && (
        <div className="space-y-1.5">
          <Label htmlFor="senior-availability-from">
            <Trans>Вільно з</Trans>
          </Label>
          <DatePickerField
            id="senior-availability-from"
            value={day}
            onChange={setDay}
            data-testid="senior-availability-from"
          />
        </div>
      )}
      <Button
        type="submit"
        size="sm"
        disabled={body === null || save.isPending}
        data-testid="senior-availability-save"
      >
        <Trans>Зберегти</Trans>
      </Button>
    </form>
  )
}
