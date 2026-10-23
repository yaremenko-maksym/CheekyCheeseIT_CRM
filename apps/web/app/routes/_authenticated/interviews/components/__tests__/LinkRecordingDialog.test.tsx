/**
 * CR-865-L-12 / LOW (fix round 1, review 5631787486): a failed link used to render the raw
 * `error.message` — an English axios string ("Request failed with status code 403") sitting next
 * to localized copy. It now goes through `getApiErrorMessage`, which translates an API error
 * envelope BY CODE through the active catalog and falls back to localized copy otherwise.
 *
 * The mutation hook is mocked because the subject here is the dialog's error wiring, not the
 * network layer: the test drives the real `onError` callback the component passes to `mutate`.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { LinkRecordingDialog } from '../LinkRecordingDialog'

const INTERVIEW = {
  id: '33333333-3333-4333-8333-333333333333',
  companyName: 'Acme Ltd',
  stage: 'TECH_INTERVIEW',
}

const mutate = vi.fn()

vi.mock('@/lib/meeting-recorder-api', () => ({
  useLinkInterviewRecording: () => ({ mutate }),
}))

vi.mock('../../use-board-seniors', () => ({
  useBoardSeniors: () => ({
    data: [{ id: 'senior-1', displayName: 'Senior One' }],
    isLoading: false,
  }),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => ({ data: [INTERVIEW], isLoading: false }) }
})

function renderDialog() {
  return render(
    <LinkRecordingDialog
      open
      onOpenChange={() => {}}
      recordingId="7e000000-0000-4000-a000-000000000002"
      recordingTitle="Vision check recording"
    />,
    { wrapper: I18nTestProvider },
  )
}

/** Drives the real `onError` the component handed to `mutate`, inside act so state flushes. */
async function failWith(error: unknown): Promise<void> {
  const options = mutate.mock.calls[0]?.[1] as { onError: (e: unknown) => void } | undefined
  if (!options) throw new Error('submit did not call mutate')
  await act(async () => {
    options.onError(error)
  })
}

describe('LinkRecordingDialog — a failed link shows localized copy, never a raw axios message', () => {
  beforeEach(() => {
    mutate.mockClear()
  })

  async function submitAfterSelecting(): Promise<void> {
    const user = userEvent.setup()
    renderDialog()
    // The interview list is gated behind choosing a senior.
    await user.selectOptions(screen.getByLabelText(/Сеньйор|Senior/i), 'senior-1')
    await user.click(await screen.findByText('Acme Ltd'))
    await user.click(screen.getByRole('button', { name: /Прив'язати|Link/i }))
    await waitFor(() => expect(mutate).toHaveBeenCalled())
  }

  it('translates an API error envelope by code instead of printing error.message', async () => {
    await loadCatalog('uk')
    await submitAfterSelecting()

    await failWith({
      isAxiosError: true,
      message: 'Request failed with status code 403',
      response: {
        status: 403,
        // The exact envelope `apiError()` emits — `statusCode` included, which
        // `apiErrorEnvelopeSchema` requires before the code is translated.
        data: {
          statusCode: 403,
          code: 'MEETING_RECORDER_RECORDING_ACCESS_DENIED',
          message: 'English fallback',
        },
      },
    })

    expect(await screen.findByText('Немає доступу до цього запису зустрічі')).toBeInTheDocument()
    expect(screen.queryByText(/Request failed with status code/)).not.toBeInTheDocument()
    expect(screen.queryByText('English fallback')).not.toBeInTheDocument()
  })

  it('falls back to localized copy when the error carries no message at all', async () => {
    await loadCatalog('uk')
    await submitAfterSelecting()

    await failWith({})

    expect(await screen.findByText("Не вдалося прив'язати запис")).toBeInTheDocument()
  })

  /**
   * An axios failure with no envelope: by the time a component sees it, `axios.ts`'s response
   * interceptor has already replaced `.message` with `getUserFacingErrorMessage`'s localized
   * text, so that is what must be rendered — never the raw "Request failed with status code N"
   * axios generated.
   */
  it('renders the already-localized axios message for an envelope-less failure', async () => {
    await loadCatalog('uk')
    await submitAfterSelecting()

    await failWith({
      isAxiosError: true,
      message: 'Недостатньо прав для цієї дії.',
      response: { status: 403, data: '' },
    })

    expect(await screen.findByText('Недостатньо прав для цієї дії.')).toBeInTheDocument()
    expect(screen.queryByText(/Request failed with status code/)).not.toBeInTheDocument()
  })
})
