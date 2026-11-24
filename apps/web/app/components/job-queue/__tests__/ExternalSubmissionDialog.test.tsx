/** External vacancy intake, Task 1.3 — the «Записати зовнішню подачу» dialog (spec §B). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, type ReactNode } from 'react'
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
  const ui = (more: typeof props = {}) => (
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
      {...more}
    />
  )
  const { rerender } = render(ui(), { wrapper })
  return { onSubmitted, onOpenCard, rerender: (more: typeof props) => rerender(ui(more)) }
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
  it('fills the fields from the prefill and marks missing and guessed ones', async () => {
    renderDialog({ prefill: { ...prefill, title: undefined } })
    expect(screen.getByLabelText('Назва вакансії')).toHaveValue('')
    expect(screen.getByLabelText('Компанія')).toHaveValue('Acme')
    expect(screen.getByLabelText('Посилання на вакансію')).toHaveValue(
      'https://jobs.example.com/42',
    )
    expect(screen.getByText('Не розпізнано — заповніть вручну')).toBeInTheDocument()
    expect(screen.getByText('Перевірте це значення')).toBeInTheDocument()
    expect(submit()).toBeDisabled()
    // the «not recognized» flag goes once the field is filled; «check this value» stays
    await userEvent.type(screen.getByLabelText('Назва вакансії'), 'Senior React Developer')
    expect(screen.queryByText('Не розпізнано — заповніть вручну')).toBeNull()
    expect(screen.getByText('Перевірте це значення')).toBeInTheDocument()
    expect(submit()).toBeEnabled()
  })

  it('«nothing recognized» shows the error and keeps only the link, marked to check', () => {
    renderDialog({ prefill: { ...prefill, recognition: 'none' } })
    expect(screen.getByTestId('external-no-vacancy')).toHaveTextContent(
      'На цій сторінці вакансію не розпізнано',
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
    expect(submit()).toHaveTextContent('Записати подачу')
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
    expect(screen.getByTestId('external-duplicate')).toHaveTextContent(
      'Ця вакансія вже є в черзі. Відкрити й подати там',
    )
    expect(screen.getAllByRole('alert')).toHaveLength(1)
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
      'Це посилання вже є в черзі.',
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
    const { onSubmitted } = renderDialog()
    await userEvent.click(submit())
    expect(await screen.findByTestId('job-queue-duplicates')).toHaveTextContent('Similar role')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    post.mockResolvedValueOnce(created)
    await userEvent.click(screen.getByRole('button', { name: 'Усе одно записати' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1]![1]).toMatchObject({ confirmPossibleDuplicate: true })
    // the dialog survives the resend and is back to a plain Submit
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(OPP))
    expect(submit()).toHaveTextContent('Записати подачу')
  })

  it('while «Submit anyway» is sending, the old preview is gone and the confirmation stays', async () => {
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
    await screen.findByTestId('job-queue-duplicates')
    post.mockReturnValueOnce(new Promise(() => {}))
    await userEvent.click(screen.getByRole('button', { name: 'Усе одно записати' }))
    await waitFor(() => expect(submit()).toHaveAttribute('aria-busy', 'true'))
    expect(screen.queryByTestId('job-queue-duplicates')).toBeNull()
    expect(submit()).toHaveTextContent('Усе одно записати')
  })

  it('a possible duplicate shows no «already submitted» senior line: the 409 is about this senior', async () => {
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
    await screen.findByTestId('job-queue-duplicates')
    expect(screen.queryByTestId('job-queue-duplicate-submitted')).toBeNull()
  })

  it('an edit after a possible duplicate drops the confirmation and the old preview', async () => {
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
    await screen.findByTestId('job-queue-duplicates')
    await userEvent.type(screen.getByLabelText('Компанія'), ' Ltd')
    expect(screen.queryByTestId('job-queue-duplicates')).toBeNull()
    expect(submit()).toHaveTextContent('Записати подачу')
  })

  it('teams that arrive after the dialog opened still preselect the team and the senior', async () => {
    post.mockResolvedValue(created)
    const { rerender, onSubmitted } = renderDialog({ teams: [] })
    expect(submit()).toBeDisabled()
    rerender({ teams })
    expect(submit()).toBeEnabled()
    await userEvent.click(submit())
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(OPP))
    expect(post.mock.calls[0]![1]).toMatchObject({
      submission: { teamId: TEAM, seniorId: SENIOR, resumeId: RESUME },
    })
  })
})

const TEAM_B = '99999999-9999-4999-8999-99999999999b'
const TEAM_C = '99999999-9999-4999-8999-99999999999c'
const S_B1 = 'aaaaaaaa-0000-4000-8000-0000000000b1'
const S_B2 = 'aaaaaaaa-0000-4000-8000-0000000000b2'

const person = (userId: string, displayName: string, over: Record<string, unknown> = {}) => ({
  ...member,
  id: `m-${userId}`,
  userId,
  displayName,
  ...over,
})
const teamA = teams[0]!
/** A junior and a departed senior come first: neither may be offered or preselected. */
const teamB = {
  id: TEAM_B,
  name: 'Team B',
  members: [
    person('junior-1', 'Ivan Junior', { role: 'JUNIOR' }),
    person('left-1', 'Petro Left', { leftAt: '2026-06-01T00:00:00.000Z' }),
    person(S_B1, 'Bohdan First'),
    person(S_B2, 'Daryna Second'),
  ],
} as unknown as TeamDto
const teamC = {
  id: TEAM_C,
  name: 'Team C',
  members: [person('junior-2', 'Oksana Junior', { role: 'JUNIOR' })],
} as unknown as TeamDto

/** Each senior has their own READY resume; no senior is a query that has not started. */
function resumePerSenior() {
  resumeHook.mockImplementation(
    (seniorId) =>
      (seniorId === undefined
        ? { data: undefined, isPending: true, isError: false }
        : {
            data: { resume: { id: `resume-${seniorId}`, status: 'READY' } },
            isPending: false,
            isError: false,
          }) as unknown as ReturnType<typeof useSeniorResume>,
  )
}

async function submitAndGetBody() {
  post.mockResolvedValue(created)
  await userEvent.click(submit())
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  return post.mock.calls[0]![1] as Record<string, unknown>
}

async function pick(label: string, option: string) {
  const user = userEvent.setup()
  await user.click(screen.getByLabelText(label))
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('ExternalSubmissionDialog: form rules', () => {
  beforeEach(() => resumePerSenior())

  it('opens empty without a prefill: no hints, no alerts, Submit off', () => {
    renderDialog({ prefill: null })
    for (const label of ['Посилання на вакансію', 'Назва вакансії', 'Компанія', 'Опис']) {
      expect(screen.getByLabelText(label)).toHaveValue('')
    }
    expect(screen.queryByText('Не розпізнано — заповніть вручну')).toBeNull()
    expect(screen.queryByText('Перевірте це значення')).toBeNull()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(screen.queryByTestId('external-resume-state')).toBeNull()
    expect(submit()).toBeDisabled()
    expect(submit()).not.toHaveAttribute('aria-busy')
  })

  it('the link field is not spell-checked', () => {
    renderDialog()
    expect(screen.getByLabelText('Посилання на вакансію')).toHaveAttribute('spellcheck', 'false')
  })

  it('Cancel asks to close', async () => {
    const onOpenChange = vi.fn()
    renderDialog({ onOpenChange })
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('each hint belongs to its own field', () => {
    renderDialog({ prefill: { ...prefill, title: undefined } })
    const hintOf = (label: string) => screen.getByTestId(`${screen.getByLabelText(label).id}-hint`)
    expect(hintOf('Назва вакансії')).toHaveTextContent('Не розпізнано — заповніть вручну')
    expect(hintOf('Компанія')).toHaveTextContent('Перевірте це значення')
  })

  it('a title of spaces is still missing: the hint stays and Submit is off', async () => {
    renderDialog({ prefill: { ...prefill, title: undefined } })
    await userEvent.type(screen.getByLabelText('Назва вакансії'), '   ')
    expect(screen.getByText('Не розпізнано — заповніть вручну')).toBeInTheDocument()
    expect(submit()).toBeDisabled()
  })

  it('a bad link marks the field invalid and describes it; a good one does not', async () => {
    renderDialog()
    const url = screen.getByLabelText('Посилання на вакансію')
    expect(url).not.toHaveAttribute('aria-invalid')
    expect(url).not.toHaveAttribute('aria-describedby')
    await userEvent.clear(url)
    await userEvent.type(url, 'http://jobs.example.com/1')
    expect(url).toHaveAttribute('aria-invalid', 'true')
    expect(url).toHaveAccessibleDescription('Потрібне посилання https:// без логіна й пароля.')
  })

  it('sends trimmed text and a trimmed link', async () => {
    renderDialog({
      prefill: {
        ...prefill,
        url: '  https://jobs.example.com/42  ',
        title: '  Senior React Developer  ',
        company: ' Acme ',
        description: '\nBuild things.\n',
      },
    })
    expect(submit()).toBeEnabled()
    expect(await submitAndGetBody()).toMatchObject({
      title: 'Senior React Developer',
      companyName: 'Acme',
      descriptionMd: 'Build things.',
      applicationUrl: 'https://jobs.example.com/42',
    })
  })

  it.each([
    ['no link', undefined],
    ['a link of spaces', '   '],
  ])('%s is allowed and sends no applicationUrl', async (_label, url) => {
    renderDialog({ prefill: { ...prefill, url } })
    expect(submit()).toBeEnabled()
    expect(await submitAndGetBody()).not.toHaveProperty('applicationUrl')
  })

  it('a resume still loading blocks Submit and says so', () => {
    resumeHook.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
    } as unknown as ReturnType<typeof useSeniorResume>)
    renderDialog()
    expect(screen.getByTestId('external-resume-state')).toHaveTextContent('Перевіряємо резюме…')
    expect(submit()).toBeDisabled()
  })

  it('a resume that failed to load blocks Submit and says so', () => {
    resumeHook.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
    } as unknown as ReturnType<typeof useSeniorResume>)
    renderDialog()
    expect(screen.getByTestId('external-resume-state')).toHaveTextContent(
      'Не вдалося завантажити резюме сеньйора.',
    )
    expect(submit()).toBeDisabled()
  })

  it('a READY resume shows no resume note', () => {
    renderDialog()
    expect(screen.queryByTestId('external-resume-state')).toBeNull()
    expect(submit()).toBeEnabled()
  })

  it('while sending, Submit is busy, off and spinning', async () => {
    post.mockReturnValue(new Promise(() => {}))
    renderDialog()
    // the spinner is aria-hidden, so no role or label reaches it
    // eslint-disable-next-line testing-library/no-node-access
    const spinner = () => submit().querySelector('svg')
    expect(spinner()).toBeNull()
    await userEvent.click(submit())
    await waitFor(() => expect(submit()).toHaveAttribute('aria-busy', 'true'))
    expect(submit()).toBeDisabled()
    expect(spinner()).not.toBeNull()
  })

  it('a failure without a response is one plain error and no «submit anyway»', async () => {
    post.mockRejectedValue(new Error('Network Error'))
    renderDialog()
    await userEvent.click(submit())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toBe('')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByTestId('external-duplicate')).toBeNull()
    expect(submit()).toHaveTextContent('Записати подачу')
  })
})

describe('ExternalSubmissionDialog: team and senior', () => {
  beforeEach(() => resumePerSenior())

  it('one team: no team picker; only an active senior is offered and preselected', async () => {
    renderDialog({ teams: [teamB], scope: { ...SCOPE, teamId: TEAM_B }, seniorId: undefined })
    expect(screen.queryByLabelText('Команда')).toBeNull()
    expect(screen.getByLabelText('Сеньйор')).toHaveTextContent('Bohdan First')
    expect(await submitAndGetBody()).toMatchObject({
      submission: { teamId: TEAM_B, seniorId: S_B1, resumeId: `resume-${S_B1}` },
    })
  })

  it('the scope team wins over the first team in the list', async () => {
    renderDialog({ teams: [teamB, teamA], seniorId: undefined })
    expect(screen.getByLabelText('Команда')).toHaveTextContent('Team A')
    expect(screen.getByLabelText('Сеньйор')).toHaveTextContent('Olena Senior')
    expect(await submitAndGetBody()).toMatchObject({
      submission: { teamId: TEAM, seniorId: SENIOR, resumeId: `resume-${SENIOR}` },
    })
  })

  it('without a scope team, the team of the initial senior is chosen, and that senior', async () => {
    renderDialog({
      teams: [teamA, teamB],
      scope: { actorId: 'actor', role: 'ADMIN', teamId: null },
      seniorId: S_B2,
    })
    expect(screen.getByLabelText('Команда')).toHaveTextContent('Team B')
    expect(await submitAndGetBody()).toMatchObject({
      submission: { teamId: TEAM_B, seniorId: S_B2 },
    })
  })

  it('an initial senior outside the team falls back to the team’s first senior', async () => {
    renderDialog({
      teams: [teamA],
      scope: { actorId: 'actor', role: 'ADMIN', teamId: null },
      seniorId: S_B1,
    })
    expect(await submitAndGetBody()).toMatchObject({
      submission: { teamId: TEAM, seniorId: SENIOR },
    })
  })

  it('a picked senior is sent', async () => {
    renderDialog({ teams: [teamB], scope: { ...SCOPE, teamId: TEAM_B }, seniorId: S_B1 })
    await pick('Сеньйор', 'Daryna Second')
    expect(screen.getByLabelText('Сеньйор')).toHaveTextContent('Daryna Second')
    expect(await submitAndGetBody()).toMatchObject({
      submission: { teamId: TEAM_B, seniorId: S_B2, resumeId: `resume-${S_B2}` },
    })
  })

  it('picking a team moves to its first senior, even when the initial senior is there too', async () => {
    renderDialog({ teams: [teamA, teamB, teamC], seniorId: S_B2 })
    await pick('Команда', 'Team B')
    expect(screen.getByLabelText('Команда')).toHaveTextContent('Team B')
    expect(screen.getByLabelText('Сеньйор')).toHaveTextContent('Bohdan First')
    expect(await submitAndGetBody()).toMatchObject({
      submission: { teamId: TEAM_B, seniorId: S_B1 },
    })
  })

  it('a team without seniors disables the senior picker and Submit, with no resume note', async () => {
    const thrown: unknown[] = []
    const onError = (e: ErrorEvent) => thrown.push(e.error)
    window.addEventListener('error', onError)
    renderDialog({ teams: [teamA, teamC] })
    await pick('Команда', 'Team C')
    window.removeEventListener('error', onError)
    // the pick itself must not throw on a team with no senior to preselect
    expect(thrown).toEqual([])
    const senior = screen.getByLabelText('Сеньйор')
    expect(senior).toBeDisabled()
    expect(senior).toHaveTextContent('У команді немає сеньйорів')
    expect(screen.queryByTestId('external-resume-state')).toBeNull()
    expect(submit()).toBeDisabled()
  })
})

describe('ExternalSubmissionDialog — «Заповнити» from a pasted text (spec §D)', () => {
  const PARSED = {
    isVacancy: true,
    title: 'Go Developer',
    companyName: 'Globex',
    descriptionMd: 'We need a Go developer.',
  }
  const paste = () => screen.getByTestId('external-paste')
  const fillButton = () => screen.getByTestId('external-fill')
  const parseCalls = () => post.mock.calls.filter(([url]) => url === '/job-queue/manual/parse')

  it('fills only the empty fields and marks them to check; typed text is never overwritten', async () => {
    post.mockResolvedValueOnce({ data: PARSED })
    renderDialog({ prefill: null })
    expect(fillButton()).toBeDisabled()
    expect(screen.queryByText('Перевірте це значення')).toBeNull()
    await userEvent.type(screen.getByLabelText('Компанія'), 'Acme')
    await userEvent.type(paste(), 'Go Developer at Globex')
    await userEvent.click(fillButton())
    await waitFor(() => expect(screen.getByLabelText('Назва вакансії')).toHaveValue('Go Developer'))
    expect(post).toHaveBeenCalledWith('/job-queue/manual/parse', { text: 'Go Developer at Globex' })
    expect(screen.getByLabelText('Компанія')).toHaveValue('Acme')
    expect(screen.getByLabelText('Опис')).toHaveValue('We need a Go developer.')
    expect(screen.getAllByText('Перевірте це значення')).toHaveLength(2)
    expect(screen.queryByTestId(/-company-hint$/)).toBeNull()
    // an edit of a filled field takes its «check this value» away
    await userEvent.type(screen.getByLabelText('Назва вакансії'), '!')
    expect(screen.getAllByText('Перевірте це значення')).toHaveLength(1)
    expect(screen.queryByTestId(/-title-hint$/)).toBeNull()
    expect(screen.getByTestId(/-description-hint$/)).toHaveTextContent('Перевірте це значення')
  })

  it('the paste box is labelled and says what it is for', () => {
    renderDialog({ prefill: null })
    expect(screen.getByLabelText('Текст вакансії')).toBe(paste())
    expect(paste()).toHaveAttribute(
      'placeholder',
      'Вставте текст вакансії, щоб заповнити поля нижче',
    )
  })

  it('a paste of spaces cannot be sent; a field of spaces counts as empty and is filled', async () => {
    post.mockResolvedValueOnce({ data: PARSED })
    renderDialog({ prefill: null })
    await userEvent.type(paste(), '   ')
    expect(fillButton()).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Компанія'), '  ')
    await userEvent.type(paste(), 'Go Developer at Globex')
    await userEvent.click(fillButton())
    await waitFor(() => expect(screen.getByLabelText('Компанія')).toHaveValue('Globex'))
  })

  it('a «not a vacancy» answer fills nothing, even if it carries fields', async () => {
    post.mockResolvedValueOnce({ data: { isVacancy: false, title: 'Lunch' } })
    renderDialog({ prefill: null })
    await userEvent.type(paste(), 'Lunch menu')
    await userEvent.click(fillButton())
    await screen.findByTestId('external-parse-not-vacancy')
    expect(screen.getByLabelText('Назва вакансії')).toHaveValue('')
  })

  it('a reading that fills nothing leaves the last submit answer in place', async () => {
    post.mockRejectedValueOnce(
      axiosError(409, {
        statusCode: 409,
        code: 'JOB_QUEUE_MANUAL_DUPLICATE',
        params: {},
        message: 'dup',
      }),
    )
    renderDialog()
    await userEvent.click(submit())
    await screen.findByTestId('external-duplicate')
    post.mockResolvedValueOnce({ data: PARSED })
    await userEvent.type(paste(), 'Go Developer at Globex')
    await userEvent.click(fillButton())
    await waitFor(() => expect(parseCalls()).toHaveLength(1))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(screen.getByTestId('external-duplicate')).toBeInTheDocument()
  })

  it('«Заповнити» is busy only while the text is being read', async () => {
    post.mockReturnValueOnce(new Promise(() => {}))
    renderDialog({ prefill: null })
    await userEvent.type(paste(), 'Go Developer')
    expect(fillButton()).not.toHaveAttribute('aria-busy')
    await userEvent.click(fillButton())
    await waitFor(() => expect(fillButton()).toHaveAttribute('aria-busy', 'true'))
    expect(fillButton()).toBeDisabled()
  })

  it('the pasted text is plain text: markup stays visible as characters', async () => {
    renderDialog({ prefill: null })
    await userEvent.type(paste(), '<b>Go</b>')
    expect(paste()).toHaveValue('<b>Go</b>')
    expect(screen.queryByText('Go', { selector: 'b' })).toBeNull()
  })

  it('a text that is not a vacancy: the «not recognized» banner, nothing filled', async () => {
    post.mockResolvedValueOnce({ data: { isVacancy: false } })
    renderDialog({ prefill: null })
    await userEvent.type(paste(), 'Lunch menu')
    await userEvent.click(fillButton())
    expect(await screen.findByTestId('external-parse-not-vacancy')).toHaveTextContent(
      'У цьому тексті вакансію не розпізнано. Заповніть поля вручну.',
    )
    expect(screen.getByLabelText('Назва вакансії')).toHaveValue('')
  })

  it('a 429: the «too many requests» banner, the fields stay editable', async () => {
    post.mockRejectedValueOnce(axiosError(429, { code: 'TOO_MANY_REQUESTS' }))
    renderDialog({ prefill: null })
    await userEvent.type(paste(), 'Go Developer')
    await userEvent.click(fillButton())
    expect(await screen.findByTestId('external-parse-error')).toHaveTextContent(
      'Забагато запитів на розпізнавання. Заповніть поля вручну.',
    )
    await userEvent.type(screen.getByLabelText('Назва вакансії'), 'Go')
    expect(screen.getByLabelText('Назва вакансії')).toHaveValue('Go')
  })

  it('a 503: the outage banner, the fields stay editable, and «Заповнити» can retry', async () => {
    post.mockRejectedValueOnce(
      axiosError(503, {
        statusCode: 503,
        code: 'JOB_QUEUE_PARSE_UNAVAILABLE',
        message: 'Reading the vacancy text is unavailable right now. Fill in the fields by hand.',
      }),
    )
    renderDialog({ prefill: null })
    await userEvent.type(paste(), 'Go Developer')
    await userEvent.click(fillButton())
    expect(await screen.findByTestId('external-parse-error')).toHaveTextContent(
      'Розпізнавання тексту вакансії зараз недоступне. Заповніть поля вручну.',
    )
    await userEvent.type(screen.getByLabelText('Компанія'), 'Acme')
    expect(screen.getByLabelText('Компанія')).toHaveValue('Acme')
    post.mockResolvedValueOnce({ data: PARSED })
    await userEvent.click(fillButton())
    await waitFor(() => expect(screen.getByLabelText('Назва вакансії')).toHaveValue('Go Developer'))
    expect(screen.queryByTestId('external-parse-error')).toBeNull()
  })

  it.each(['partial', 'none'] as const)(
    'a %s hand-off with page text is read once on opening, never again on a re-render',
    async (recognition) => {
      post.mockResolvedValue({ data: PARSED })
      const handOff = (): ExternalVacancyPrefill => ({
        ...prefill,
        recognition,
        title: undefined,
        pageText: 'Go Developer at Globex. We need a Go developer.',
      })
      const view = renderDialog({ prefill: handOff() })
      await waitFor(() =>
        expect(screen.getByLabelText('Назва вакансії')).toHaveValue('Go Developer'),
      )
      expect(parseCalls()).toEqual([
        ['/job-queue/manual/parse', { text: 'Go Developer at Globex. We need a Go developer.' }],
      ])
      expect(paste()).toHaveValue('Go Developer at Globex. We need a Go developer.')
      // a new but equal payload object is the same payload
      view.rerender({ prefill: handOff() })
      await userEvent.type(screen.getByLabelText('Компанія'), 'x')
      expect(parseCalls()).toHaveLength(1)
      // a «nothing recognized» banner goes once the server read a vacancy
      expect(screen.queryByTestId('external-no-vacancy')).toBeNull()
    },
  )

  it('a «none» hand-off read as a vacancy that fills nothing keeps the «nothing recognized» banner', async () => {
    post.mockResolvedValueOnce({ data: { isVacancy: true } })
    renderDialog({
      prefill: { ...prefill, recognition: 'none', pageText: 'Go Developer at Globex' },
    })
    await waitFor(() => expect(parseCalls()).toHaveLength(1))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(screen.getByTestId('external-no-vacancy')).toBeInTheDocument()
    expect(screen.getByLabelText('Назва вакансії')).toHaveValue('')
  })

  it('an edit of the pasted text clears the last reading’s banner', async () => {
    post.mockRejectedValueOnce(axiosError(429, { code: 'TOO_MANY_REQUESTS' }))
    renderDialog({ prefill: null })
    await userEvent.type(paste(), 'Go Developer')
    await userEvent.click(fillButton())
    await screen.findByTestId('external-parse-error')
    await userEvent.type(paste(), '!')
    expect(screen.queryByTestId('external-parse-error')).toBeNull()
    post.mockResolvedValueOnce({ data: { isVacancy: false } })
    await userEvent.click(fillButton())
    await screen.findByTestId('external-parse-not-vacancy')
    await userEvent.type(paste(), '!')
    expect(screen.queryByTestId('external-parse-not-vacancy')).toBeNull()
  })

  it('an edit of the pasted text while it is being read keeps the reading', async () => {
    let answer: (v: unknown) => void = () => {}
    post.mockReturnValueOnce(new Promise((r) => (answer = r)))
    renderDialog({ prefill: null })
    await userEvent.type(paste(), 'Go Developer')
    await userEvent.click(fillButton())
    await waitFor(() => expect(fillButton()).toHaveAttribute('aria-busy', 'true'))
    await userEvent.type(paste(), '!')
    await act(async () => answer({ data: PARSED }))
    await waitFor(() => expect(screen.getByLabelText('Назва вакансії')).toHaveValue('Go Developer'))
  })

  it('a recognized hand-off, or one without page text, is not read', async () => {
    renderDialog({ prefill: { ...prefill, recognition: 'recognized', pageText: 'Go Developer' } })
    await act(() => new Promise((r) => setTimeout(r, 0)))
    cleanup()
    renderDialog({ prefill })
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(post).not.toHaveBeenCalled()
  })

  it('a strict-mode double effect still reads the hand-off once', async () => {
    post.mockResolvedValue({ data: PARSED })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <I18nTestProvider>
            <ExternalSubmissionDialog
              open
              onOpenChange={() => {}}
              scope={SCOPE}
              teams={teams}
              seniorId={SENIOR}
              prefill={{ ...prefill, title: undefined, pageText: 'Go Developer at Globex' }}
              onSubmitted={() => {}}
              onOpenCard={() => {}}
            />
          </I18nTestProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByLabelText('Назва вакансії')).toHaveValue('Go Developer'))
    expect(parseCalls()).toHaveLength(1)
  })

  it.each([
    ['no prefill', null],
    ['a recognized one', { ...prefill, recognition: 'recognized', pageText: 'Go' }],
  ] as const)(
    'a hand-off replaced by %s while open asks nothing more and shows no error',
    async (_, next) => {
      post.mockResolvedValue({ data: PARSED })
      const view = renderDialog({ prefill: { ...prefill, title: undefined, pageText: 'Go page' } })
      await waitFor(() => expect(parseCalls()).toHaveLength(1))
      view.rerender({ prefill: next })
      await act(() => new Promise((r) => setTimeout(r, 0)))
      expect(parseCalls()).toHaveLength(1)
      expect(screen.queryByTestId('external-parse-error')).toBeNull()
    },
  )

  it('a new page text arriving while the dialog is open is read too', async () => {
    post.mockResolvedValue({ data: PARSED })
    const handOff = (pageText: string): ExternalVacancyPrefill => ({
      ...prefill,
      title: undefined,
      pageText,
    })
    const view = renderDialog({ prefill: handOff('First page') })
    await waitFor(() => expect(parseCalls()).toHaveLength(1))
    view.rerender({ prefill: handOff('Second page') })
    await waitFor(() =>
      expect(parseCalls()).toEqual([
        ['/job-queue/manual/parse', { text: 'First page' }],
        ['/job-queue/manual/parse', { text: 'Second page' }],
      ]),
    )
  })
})
