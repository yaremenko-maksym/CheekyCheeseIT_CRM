/**
 * CR-865-L-12 / LOW: a failed link used to render the raw `error.message` next to localized copy.
 *
 * COPY-M-1 (copy review 5632646634) corrected the fix twice over. `getApiErrorMessage` falls back
 * to a localized string only when the error has NO `message` key at all, so a ZodError from the
 * client-side `.parse` still rendered its raw message — and `new Error('')` produced an empty
 * string, so the alert did not render and the dialog failed SILENTLY. It now uses
 * `getUserFacingErrorMessage`, which always returns user-facing text. (Note: axios errors were
 * already localized before this PR — `axios.ts` sets `error.message = getUserFacingErrorMessage`
 * on every rejection — so the raw-English-axios framing never applied to them.)
 *
 * The mutation hook is mocked because the subject here is the dialog's error wiring, not the
 * network layer: the test drives the real `onError` callback the component passes to `mutate`.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ZodError } from 'zod'
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

  it('always renders something user-facing, even for an error with an empty message', async () => {
    await loadCatalog('uk')
    await submitAfterSelecting()

    // The silent-failure case: an empty message used to render an empty alert — i.e. nothing.
    await failWith(new Error(''))

    expect(await screen.findByText('Сталася помилка. Спробуйте ще раз.')).toBeInTheDocument()
  })

  it('shows no raw message for a client-side validation error (ZodError)', async () => {
    await loadCatalog('uk')
    await submitAfterSelecting()

    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        path: ['companyName'],
        message: 'Expected string, received null',
      },
    ] as never)
    await failWith(zodError)

    expect(screen.queryByText(/Expected string, received null/)).not.toBeInTheDocument()
    expect(await screen.findByText('Сталася помилка. Спробуйте ще раз.')).toBeInTheDocument()
  })

  it('keeps the link-specific title alongside the reason', async () => {
    await loadCatalog('uk')
    await submitAfterSelecting()

    await failWith({
      isAxiosError: true,
      message: 'Не вдалося виконати запит. Спробуйте ще раз.',
      response: { status: 500, data: '' },
    })

    // COPY-M-2: a status-level reason never mentions linking, so the existing msgid becomes the
    // alert TITLE and the reason is the description — both visible, no new msgid.
    expect(await screen.findByText("Не вдалося прив'язати запис")).toBeInTheDocument()
    // The reason for a 5xx is the status-level line — which, on its own, never mentions linking.
    expect(
      screen.getByText(
        'Помилка на нашій стороні. Ми вже знаємо про проблему — спробуйте трохи пізніше.',
      ),
    ).toBeInTheDocument()
  })

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
