/** External vacancy intake, Task 1.3 — the «Записати зовнішню подачу» dialog (spec §B). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { ExternalVacancyPrefill, TeamDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { useSeniorResume } from '@/hooks/use-senior-resume'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { ExternalSubmissionDialog } from '../ExternalSubmissionDialog'

vi.mock('@/lib/axios', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('@/hooks/use-senior-resume', () => ({ useSeniorResume: vi.fn() }))

const post = vi.mocked(api.post)
const resumeHook = vi.mocked(useSeniorResume)

const TEAM = '99999999-9999-4999-8999-999999999999'
const SENIOR = 'aaaaaaaa-0000-4000-8000-000000000001'
const RESUME = 'bbbbbbbb-0000-4000-8000-000000000001'
const OPP = '11111111-1111-4111-8111-111111111111'
const SCOPE = { actorId: 'actor', role: 'HR' as const, teamId: TEAM }

const member = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  userId: SENIOR,
  displayName: 'Olena Senior',
  email: 'olena@example.com',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'SENIOR' as const,
  techStack: null,
  technicalRoles: [],
  joinedAt: '2026-01-01T00:00:00.000Z',
  leftAt: null,
}
const teams = [{ id: TEAM, name: 'Team A', members: [member] }] as unknown as TeamDto[]

const prefill: ExternalVacancyPrefill = {
  v: 1,
  recognition: 'partial',
  url: 'https://jobs.example.com/42',
  title: 'Senior React Developer',
  company: 'Acme',
  description: 'Build things.',
  status: { url: 'found', title: 'missing', company: 'guessed', description: 'found' },
}

function resume(status: 'READY' | 'RUNNING' | null) {
  resumeHook.mockReturnValue({
    data: { resume: status === null ? null : { id: RESUME, status } },
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useSeniorResume>)
}

const created = {
  data: {
    submission: {
      id: 'dddddddd-0000-4000-8000-000000000001',
      opportunityId: OPP,
      seniorId: SENIOR,
      state: 'TAKEN',
      submittedAt: '2026-11-23T10:00:00.000Z',
      cancelledAt: null,
      version: 1,
      submittedByName: 'HR',
    },
  },
}

const axiosError = (status: number, data: unknown) =>
  Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status, data } })

function renderDialog(props: Partial<Parameters<typeof ExternalSubmissionDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const onSubmitted = vi.fn()
  const onOpenCard = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
  render(
    <ExternalSubmissionDialog
      open
      onOpenChange={() => {}}
      scope={SCOPE}
      teams={teams}
      seniorId={SENIOR}
      prefill={prefill}
      onSubmitted={onSubmitted}
      onOpenCard={onOpenCard}
      {...props}
    />,
    { wrapper },
  )
  return { onSubmitted, onOpenCard }
}

const submit = () => screen.getByTestId('external-submit')

beforeEach(async () => {
  await loadCatalog('uk')
  resume('READY')
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ExternalSubmissionDialog', () => {
  it('fills the fields from the prefill and marks missing and guessed ones', () => {
    renderDialog()
    expect(screen.getByLabelText('Назва вакансії')).toHaveValue('Senior React Developer')
    expect(screen.getByLabelText('Компанія')).toHaveValue('Acme')
    expect(screen.getByLabelText('Посилання на вакансію')).toHaveValue(
      'https://jobs.example.com/42',
    )
    expect(screen.getByText('Не розпізнано — заповніть вручну')).toBeInTheDocument()
    expect(screen.getByText('Перевірте це значення')).toBeInTheDocument()
    expect(submit()).toBeEnabled()
  })

  it('«nothing recognized» shows the error and keeps only the link, marked to check', () => {
    renderDialog({ prefill: { ...prefill, recognition: 'none' } })
    expect(screen.getByTestId('external-no-vacancy')).toHaveTextContent(
      'На цій сторінці не розпізнано вакансію',
    )
    expect(screen.getByLabelText('Назва вакансії')).toHaveValue('')
    expect(screen.getByLabelText('Компанія')).toHaveValue('')
    expect(screen.getByLabelText('Опис')).toHaveValue('')
    expect(screen.getByLabelText('Посилання на вакансію')).toHaveValue(
      'https://jobs.example.com/42',
    )
    expect(screen.getAllByText('Не розпізнано — заповніть вручну')).toHaveLength(3)
    expect(screen.getByText('Перевірте це значення')).toBeInTheDocument()
    expect(submit()).toBeDisabled()
  })

  it.each([
    [null, 'У сеньйора немає резюме — подати не можна.'],
    ['RUNNING', 'Резюме сеньйора ще не готове — подати не можна.'],
  ] as const)('a resume that is %s disables Submit with the reason', (status, reason) => {
    resume(status)
    renderDialog()
    expect(screen.getByTestId('external-resume-state')).toHaveTextContent(reason)
    expect(submit()).toBeDisabled()
  })

  it.each(['Назва вакансії', 'Компанія', 'Опис'])(
    'an empty «%s» disables Submit',
    async (label) => {
      renderDialog()
      await userEvent.clear(screen.getByLabelText(label))
      expect(submit()).toBeDisabled()
    },
  )

  it('a non-https link disables Submit and says why', async () => {
    renderDialog()
    const url = screen.getByLabelText('Посилання на вакансію')
    await userEvent.clear(url)
    await userEvent.type(url, 'http://jobs.example.com/1')
    expect(screen.getByText('Потрібне посилання https:// без логіна й пароля.')).toBeInTheDocument()
    expect(submit()).toBeDisabled()
  })

  it('sends the card with the READY resume and reports the new card', async () => {
    post.mockResolvedValue(created)
    const { onSubmitted } = renderDialog()
    await userEvent.click(submit())
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const [url, body] = post.mock.calls[0]!
    expect(url).toBe('/job-queue/manual')
    expect(body).toMatchObject({
      title: 'Senior React Developer',
      companyName: 'Acme',
      descriptionMd: 'Build things.',
      applicationUrl: 'https://jobs.example.com/42',
      submission: { teamId: TEAM, seniorId: SENIOR, resumeId: RESUME },
    })
    expect(body).not.toHaveProperty('confirmPossibleDuplicate')
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(OPP))
  })

  it('a duplicate the actor can open links to that card', async () => {
    post.mockRejectedValue(
      axiosError(409, {
        statusCode: 409,
        code: 'JOB_QUEUE_MANUAL_DUPLICATE',
        params: {},
        message: 'dup',
        opportunityId: OPP,
      }),
    )
    const { onOpenCard } = renderDialog()
    await userEvent.click(submit())
    await userEvent.click(await screen.findByRole('button', { name: 'Відкрити й подати там' }))
    expect(screen.getByTestId('external-duplicate')).toHaveTextContent('Ця вакансія вже є в черзі.')
    expect(onOpenCard).toHaveBeenCalledWith(OPP)
  })

  it('a duplicate without a card id is the plain «already registered» error', async () => {
    post.mockRejectedValue(
      axiosError(409, {
        statusCode: 409,
        code: 'JOB_QUEUE_MANUAL_DUPLICATE',
        params: {},
        message: 'dup',
      }),
    )
    renderDialog()
    await userEvent.click(submit())
    expect(await screen.findByTestId('external-duplicate')).toHaveTextContent(
      'Це посилання вже зареєстровано в черзі.',
    )
    expect(screen.queryByRole('button', { name: 'Відкрити й подати там' })).toBeNull()
  })

  it('a possible duplicate lists the vacancies and «Submit anyway» resends with the confirmation', async () => {
    post.mockRejectedValueOnce(
      axiosError(409, {
        code: 'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
        possibleDuplicates: {
          items: [{ opportunityId: OPP, title: 'Similar role', companyName: 'Acme' }],
          totalCount: 1,
        },
      }),
    )
    renderDialog()
    await userEvent.click(submit())
    expect(await screen.findByTestId('job-queue-duplicates')).toHaveTextContent('Similar role')
    post.mockResolvedValueOnce(created)
    await userEvent.click(screen.getByRole('button', { name: 'Усе одно записати' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1]![1]).toMatchObject({ confirmPossibleDuplicate: true })
  })
})
