import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import type { ExternalVacancyPrefill, TeamDto } from '@crm/shared'
import { encodeBlockMap, type PageBlock } from '@/bookmarklet/blocks'
import { api } from '@/lib/axios'
import { useSeniorResume } from '@/hooks/use-senior-resume'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { ExternalSubmissionDialog } from '../ExternalSubmissionDialog'

vi.mock('@/lib/axios', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('@/hooks/use-senior-resume', () => ({ useSeniorResume: vi.fn() }))

const post = vi.mocked(api.post)

const TEAM = '99999999-9999-4999-8999-999999999999'
const SENIOR = 'aaaaaaaa-0000-4000-8000-000000000001'
const teams = [
  {
    id: TEAM,
    name: 'Team A',
    members: [{ userId: SENIOR, displayName: 'Olena', role: 'SENIOR', leftAt: null }],
  },
] as unknown as TeamDto[]

const BLOCKS: PageBlock[] = [
  { t: 'Senior Go Developer', k: 'h1', fs: 32, fw: 700, x: 0, y: 100, w: 800, r: 'main' },
  { t: 'We build payments.', k: 'p', fs: 16, fw: 400, x: 0, y: 200, w: 800, r: 'main' },
]
let b = ''

const extracted: ExternalVacancyPrefill = {
  v: 1,
  recognition: 'partial',
  url: 'https://jobs.example.com/42',
  title: 'Jobs at Acme',
  company: 'Acme',
  description: 'Cookie banner text.',
  pageText: 'Senior Go Developer. We build payments.',
  status: { url: 'found', title: 'found', company: 'found', description: 'found' },
}

const PICKED = {
  isVacancy: true,
  title: 'Senior Go Developer',
  companyName: 'Globex',
  descriptionMd: 'We build payments.',
}

const PARSED = { isVacancy: true, title: 'Parsed title' }

const axiosError = (status: number, data: unknown) =>
  Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status, data } })

const calls = (url: string) => post.mock.calls.filter(([u]) => u === url)
const pickCalls = () => calls('/job-queue/manual/pick')
const parseCalls = () => calls('/job-queue/manual/parse')
const field = (label: string) => screen.getByLabelText(label)
const hintOf = (label: string) => screen.queryByTestId(`${field(label).id}-hint`)
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))

/** Renders the dialog; the result re-renders it with another prefill. */
function renderDialog(prefill: ExternalVacancyPrefill, strict = false) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const tree = (p: ExternalVacancyPrefill) => (
    <QueryClientProvider client={client}>
      <I18nTestProvider>
        <ExternalSubmissionDialog
          open
          onOpenChange={() => {}}
          scope={{ actorId: 'actor', role: 'HR', teamId: TEAM }}
          teams={teams}
          seniorId={SENIOR}
          prefill={p}
          onSubmitted={() => {}}
          onOpenCard={() => {}}
        />
      </I18nTestProvider>
    </QueryClientProvider>
  )
  const { rerender } = render(strict ? <StrictMode>{tree(prefill)}</StrictMode> : tree(prefill))
  return (next: ExternalVacancyPrefill) =>
    rerender(strict ? <StrictMode>{tree(next)}</StrictMode> : tree(next))
}

/** The post mock: the pick answers `pick`, a parse answers `PARSED`. */
function answer(pick: () => Promise<unknown>) {
  post.mockImplementation((url: string) =>
    url === '/job-queue/manual/pick' ? pick() : Promise.resolve({ data: PARSED }),
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
  b = await encodeBlockMap(BLOCKS)
  vi.mocked(useSeniorResume).mockReturnValue({
    data: { resume: { id: 'r', status: 'READY' } },
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useSeniorResume>)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ExternalSubmissionDialog — the block-map pick', () => {
  it('asks the pick once and replaces the extractor values; the page text is not parsed', async () => {
    answer(() => Promise.resolve({ data: PICKED }))
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(field('Компанія')).toHaveValue('Globex'))
    expect(field('Назва вакансії')).toHaveValue('Senior Go Developer')
    expect(field('Опис')).toHaveValue('We build payments.')
    expect(pickCalls()).toEqual([
      [
        '/job-queue/manual/pick',
        { url: 'https://jobs.example.com/42', tabTitle: '', blocks: BLOCKS },
      ],
    ])
    await settle()
    expect(parseCalls()).toHaveLength(0)
    expect(screen.queryByTestId('external-pick-unavailable')).toBeNull()
  })

  it('marks «check this» on a company the pick changed, not on one equal once normalized', async () => {
    answer(() => Promise.resolve({ data: PICKED }))
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(field('Компанія')).toHaveValue('Globex'))
    expect(hintOf('Компанія')).toHaveTextContent('Перевірте це значення')
    cleanup()
    answer(() => Promise.resolve({ data: { isVacancy: true, companyName: '  acme  ' } }))
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(field('Компанія')).toHaveValue('  acme  '))
    expect(hintOf('Компанія')).toBeNull()
    cleanup()
    // the whole company counts, not only the 80-char opening a description is compared on
    const head = 'a'.repeat(80)
    answer(() => Promise.resolve({ data: { isVacancy: true, companyName: `${head} Ltd` } }))
    renderDialog({ ...extracted, company: `${head} Inc`, b })
    await waitFor(() => expect(field('Компанія')).toHaveValue(`${head} Ltd`))
    expect(hintOf('Компанія')).toHaveTextContent('Перевірте це значення')
  })

  it('asks the pick once under StrictMode, and again for a new map', async () => {
    answer(() => Promise.resolve({ data: PICKED }))
    const again = renderDialog({ ...extracted, b }, true)
    await waitFor(() => expect(field('Компанія')).toHaveValue('Globex'))
    await settle()
    expect(pickCalls()).toHaveLength(1)
    const other: PageBlock[] = [{ ...BLOCKS[0]!, t: 'Staff Go Developer' }]
    again({ ...extracted, b: await encodeBlockMap(other) })
    await waitFor(() => expect(pickCalls()).toHaveLength(2))
    expect(pickCalls()[1]![1]).toEqual({
      url: 'https://jobs.example.com/42',
      tabTitle: '',
      blocks: other,
    })
  })

  it('a pick equal to every field changes nothing: a failed submit keeps its error', async () => {
    let reply: (v: unknown) => void = () => {}
    post.mockImplementation((url: string) =>
      url === '/job-queue/manual/pick'
        ? new Promise((r) => (reply = r))
        : url === '/job-queue/manual'
          ? Promise.reject(axiosError(500, {}))
          : Promise.resolve({ data: PARSED }),
    )
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(pickCalls()).toHaveLength(1))
    await userEvent.click(screen.getByTestId('external-submit'))
    await screen.findByRole('alert')
    const same = {
      title: 'Jobs at Acme',
      companyName: 'Acme',
      descriptionMd: 'Cookie banner text.',
    }
    await act(async () => reply({ data: { isVacancy: true, ...same } }))
    await settle()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('a pick that answers while Submit is in flight leaves the sent fields and its outcome alone', async () => {
    let reply: (v: unknown) => void = () => {}
    let fail: (e: unknown) => void = () => {}
    post.mockImplementation((url: string) =>
      url === '/job-queue/manual/pick'
        ? new Promise((r) => (reply = r))
        : url === '/job-queue/manual'
          ? new Promise((_, rej) => (fail = rej))
          : Promise.resolve({ data: PARSED }),
    )
    const again = renderDialog({ ...extracted, b })
    await waitFor(() => expect(pickCalls()).toHaveLength(1))
    await userEvent.click(screen.getByTestId('external-submit'))
    await waitFor(() => expect(calls('/job-queue/manual')).toHaveLength(1))
    await act(async () => reply({ data: PICKED }))
    await settle()
    expect(field('Назва вакансії')).toHaveValue('Jobs at Acme')
    await act(async () => fail(axiosError(500, {})))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    // once the submit settled, a later pick fills the form again
    again({ ...extracted, b: await encodeBlockMap([{ ...BLOCKS[0]!, t: 'Staff Go Developer' }]) })
    await waitFor(() => expect(pickCalls()).toHaveLength(2))
    await act(async () => reply({ data: PICKED }))
    await waitFor(() => expect(field('Назва вакансії')).toHaveValue('Senior Go Developer'))
  })

  it('an edit during the submit resets it, and a later pick fills the form again', async () => {
    let reply: (v: unknown) => void = () => {}
    post.mockImplementation((url: string) =>
      url === '/job-queue/manual/pick'
        ? new Promise((r) => (reply = r))
        : url === '/job-queue/manual'
          ? new Promise(() => {})
          : Promise.resolve({ data: PARSED }),
    )
    const again = renderDialog({ ...extracted, b })
    await waitFor(() => expect(pickCalls()).toHaveLength(1))
    await userEvent.click(screen.getByTestId('external-submit'))
    await waitFor(() => expect(calls('/job-queue/manual')).toHaveLength(1))
    // the edit resets the submit that never settles, so nothing is in flight any more
    await userEvent.type(field('Компанія'), '!')
    again({ ...extracted, b: await encodeBlockMap([{ ...BLOCKS[0]!, t: 'Staff Go Developer' }]) })
    await waitFor(() => expect(pickCalls()).toHaveLength(2))
    await act(async () => reply({ data: PICKED }))
    await waitFor(() => expect(field('Назва вакансії')).toHaveValue('Senior Go Developer'))
  })

  it('sends no url when the hand-off carried none', async () => {
    answer(() => Promise.resolve({ data: PICKED }))
    renderDialog({ ...extracted, url: undefined, b })
    await waitFor(() => expect(pickCalls()).toHaveLength(1))
    expect(pickCalls()[0]![1]).toEqual({ tabTitle: '', blocks: BLOCKS })
  })

  it('keeps a field the HR edited before the reply', async () => {
    let reply: (v: unknown) => void = () => {}
    answer(() => new Promise((r) => (reply = r)))
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(pickCalls()).toHaveLength(1))
    await userEvent.clear(field('Назва вакансії'))
    await userEvent.type(field('Назва вакансії'), 'My title')
    await act(async () => reply({ data: PICKED }))
    await waitFor(() => expect(field('Компанія')).toHaveValue('Globex'))
    expect(field('Назва вакансії')).toHaveValue('My title')
    expect(hintOf('Назва вакансії')).toBeNull()
  })

  it('a pick field that is absent or blank keeps the extractor value', async () => {
    answer(() =>
      Promise.resolve({ data: { isVacancy: true, companyName: '  ', descriptionMd: 'New body' } }),
    )
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(field('Опис')).toHaveValue('New body'))
    expect(field('Назва вакансії')).toHaveValue('Jobs at Acme')
    expect(field('Компанія')).toHaveValue('Acme')
    expect(hintOf('Назва вакансії')).toBeNull()
    expect(hintOf('Компанія')).toBeNull()
  })

  it('marks «check this» on a title the pick changed, not on one equal once normalized', async () => {
    answer(() => Promise.resolve({ data: PICKED }))
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(field('Назва вакансії')).toHaveValue('Senior Go Developer'))
    expect(hintOf('Назва вакансії')).toHaveTextContent('Перевірте це значення')
    cleanup()
    answer(() => Promise.resolve({ data: { isVacancy: true, title: '  senior   GO developer ' } }))
    renderDialog({ ...extracted, title: 'Senior Go Developer', b })
    await waitFor(() => expect(field('Назва вакансії')).toHaveValue('  senior   GO developer '))
    expect(hintOf('Назва вакансії')).toBeNull()
    cleanup()
    // spaces collapse to one, never vanish: two words are not one
    answer(() => Promise.resolve({ data: { isVacancy: true, title: 'Go Developer' } }))
    renderDialog({ ...extracted, title: 'GoDeveloper', b })
    await waitFor(() => expect(field('Назва вакансії')).toHaveValue('Go Developer'))
    expect(hintOf('Назва вакансії')).toHaveTextContent('Перевірте це значення')
  })

  it('an edit of a picked field takes its «check this» away', async () => {
    answer(() => Promise.resolve({ data: PICKED }))
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(hintOf('Назва вакансії')).not.toBeNull())
    await userEvent.type(field('Назва вакансії'), '!')
    expect(hintOf('Назва вакансії')).toBeNull()
  })

  it('marks the description only when its first 80 normalized characters differ', async () => {
    const head = 'a'.repeat(79)
    answer(() => Promise.resolve({ data: { isVacancy: true, descriptionMd: `${head}X tail` } }))
    renderDialog({ ...extracted, description: `${head}Y tail`, b })
    await waitFor(() => expect(field('Опис')).toHaveValue(`${head}X tail`))
    expect(hintOf('Опис')).toHaveTextContent('Перевірте це значення')
    cleanup()
    answer(() => Promise.resolve({ data: { isVacancy: true, descriptionMd: `${head}YX` } }))
    renderDialog({ ...extracted, description: `${head}YZ`, b })
    await waitFor(() => expect(field('Опис')).toHaveValue(`${head}YX`))
    expect(hintOf('Опис')).toBeNull()
  })

  it.each([
    ['a 503', () => Promise.reject(axiosError(503, { code: 'JOB_QUEUE_PARSE_UNAVAILABLE' }))],
    ['a network error', () => Promise.reject(new Error('Network Error'))],
  ])(
    '%s keeps the extractor values, says so quietly, then falls back to the page-text parse',
    async (_, fail) => {
      answer(fail)
      renderDialog({ ...extracted, title: undefined, b })
      expect(await screen.findByTestId('external-pick-unavailable')).toHaveTextContent(
        'ШІ не розпізнав вакансію — перевірте поля нижче.',
      )
      await waitFor(() => expect(field('Назва вакансії')).toHaveValue('Parsed title'))
      expect(field('Компанія')).toHaveValue('Acme')
      expect(field('Опис')).toHaveValue('Cookie banner text.')
      expect(screen.queryAllByRole('alert')).toHaveLength(0)
      expect(pickCalls()).toHaveLength(1)
      expect(parseCalls()).toEqual([
        ['/job-queue/manual/parse', { text: 'Senior Go Developer. We build payments.' }],
      ])
      // the pick went first: the parse was asked only after it failed
      expect(post.mock.calls[0]![0]).toBe('/job-queue/manual/pick')
    },
  )

  it('the quiet line reads in English too', async () => {
    await loadCatalog('en')
    answer(() => Promise.reject(new Error('Network Error')))
    renderDialog({ ...extracted, b })
    expect(await screen.findByTestId('external-pick-unavailable')).toHaveTextContent(
      'AI could not recognize the vacancy — check the fields below.',
    )
  })

  it('a «not a vacancy» pick keeps the extractor values with no warning and no parse', async () => {
    answer(() => Promise.resolve({ data: { isVacancy: false } }))
    renderDialog({ ...extracted, b })
    await waitFor(() => expect(pickCalls()).toHaveLength(1))
    await settle()
    expect(field('Назва вакансії')).toHaveValue('Jobs at Acme')
    expect(field('Компанія')).toHaveValue('Acme')
    expect(screen.queryByTestId('external-pick-unavailable')).toBeNull()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(parseCalls()).toHaveLength(0)
  })

  it('a pick that fills a «nothing recognized» hand-off drops that banner', async () => {
    answer(() => Promise.resolve({ data: PICKED }))
    renderDialog({ ...extracted, recognition: 'none', b })
    await waitFor(() => expect(field('Назва вакансії')).toHaveValue('Senior Go Developer'))
    expect(screen.queryByTestId('external-no-vacancy')).toBeNull()
  })

  it('a vacancy pick with only blank fields falls back to the page-text parse', async () => {
    answer(() => Promise.resolve({ data: { isVacancy: true, title: '  ' } }))
    renderDialog({ ...extracted, recognition: 'none', b })
    await waitFor(() => expect(field('Назва вакансії')).toHaveValue('Parsed title'))
    expect(parseCalls()).toHaveLength(1)
    expect(screen.queryByTestId('external-pick-unavailable')).toBeNull()
  })

  it.each([
    ['no map', undefined],
    ['a map that does not decode', '!!broken!!'],
  ])('with %s nothing is picked and the page text is parsed as today', async (_, map) => {
    answer(() => Promise.resolve({ data: PICKED }))
    renderDialog({ ...extracted, title: undefined, b: map })
    await waitFor(() => expect(field('Назва вакансії')).toHaveValue('Parsed title'))
    expect(parseCalls()).toHaveLength(1)
    await settle()
    expect(pickCalls()).toHaveLength(0)
    expect(screen.queryByTestId('external-pick-unavailable')).toBeNull()
  })
})
