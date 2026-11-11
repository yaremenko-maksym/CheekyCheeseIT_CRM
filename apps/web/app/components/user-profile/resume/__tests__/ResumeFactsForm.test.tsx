/**
 * ResumeFactsForm — the facts HR types, checked live by the same
 * `checkResumeCompleteness` the server runs at Submit (design §5.1).
 *
 * The 409 case runs the REAL save/submit hooks over a stubbed `api`, so the
 * toast text is the one the error envelope maps to, not a value the test made up.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_RESUME_FACTS, type ResumeFacts } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const putMock = vi.fn()
const postMock = vi.fn()
vi.mock('@/lib/axios', () => ({ api: { put: putMock, post: postMock, get: vi.fn() } }))

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { useSaveResumeFacts, useSubmitResume } from '@/hooks/use-senior-resume'
import { ResumeFactsForm, moveItem } from '../ResumeFactsForm'

const NOW = new Date('2026-11-11T12:00:00Z')

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
}

/** The form wired to the real hooks, exactly as ResumeTab wires it. */
function Wired({ facts }: { facts: ResumeFacts }) {
  const save = useSaveResumeFacts('senior-1')
  const submit = useSubmitResume('senior-1')
  return (
    <ResumeFactsForm
      facts={facts}
      displayName="Alex Doe"
      disabled={false}
      now={NOW}
      onSave={(next) => save.mutateAsync({ facts: next })}
      onSubmit={() => submit.mutateAsync()}
    />
  )
}

const ONE_JOB: ResumeFacts = {
  ...EMPTY_RESUME_FACTS,
  experience: [
    {
      company: '',
      role: 'Backend Engineer',
      location: null,
      start: '2020-01',
      end: null,
      current: true,
      technologies: [],
      notes: [],
    },
  ],
}

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

describe('ResumeFactsForm', () => {
  it('each issue links to its field', () => {
    render(<Wired facts={ONE_JOB} />, { wrapper: Providers })
    const list = screen.getByRole('list', { name: 'Незаповнені поля' })
    const rows = within(list).getAllByRole('button')
    // headline, skills, job 1 company, job 1 notes, languages
    expect(rows).toHaveLength(5)

    const expectations: Array<[RegExp, () => HTMLElement]> = [
      [/^Цільова посада/, () => screen.getByLabelText('Цільова посада')],
      [/^Навички/, () => screen.getByRole('textbox', { name: 'Навички' })],
      [/^Місце роботи 1 · Компанія/, () => screen.getByLabelText('Компанія, місце роботи 1')],
      [/^Місце роботи 1 · Нотатки/, () => screen.getByLabelText('Нотатки, місце роботи 1')],
      [/^Мови/, () => screen.getByRole('button', { name: 'Додати мову' })],
    ]
    for (const [name, field] of expectations) {
      fireEvent.click(within(list).getByRole('button', { name }))
      expect(field()).toHaveFocus()
    }
  })

  it('409 from save shows "a check is running" and keeps the form values', async () => {
    putMock.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'Request failed with status code 409',
      response: {
        status: 409,
        data: {
          statusCode: 409,
          code: 'RESUME_VERIFICATION_BUSY',
          message: 'The resume is being checked right now. Wait until the check finishes.',
        },
      },
    })
    render(<Wired facts={ONE_JOB} />, { wrapper: Providers })

    const headline = screen.getByLabelText('Цільова посада')
    fireEvent.change(headline, { target: { value: 'Senior Backend Engineer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти чернетку' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Резюме зараз перевіряється. Зачекайте, доки перевірка завершиться.',
      ),
    )
    expect(putMock).toHaveBeenCalledWith('/users/senior-1/resume/facts', {
      facts: expect.objectContaining({ headline: 'Senior Backend Engineer' }),
    })
    expect(screen.getByLabelText('Цільова посада')).toHaveValue('Senior Backend Engineer')
    // still dirty: the draft was not thrown away
    expect(screen.getByRole('button', { name: 'Зберегти чернетку' })).toBeEnabled()
  })

  it('upload result fills facts fields', () => {
    const { rerender } = render(<Wired facts={EMPTY_RESUME_FACTS} />, { wrapper: Providers })
    expect(screen.getByLabelText('Цільова посада')).toHaveValue('')

    // The extraction finished on the server: the same form now receives its facts.
    const extracted: ResumeFacts = {
      ...ONE_JOB,
      headline: 'Platform Engineer',
      skills: ['Go', 'Kubernetes'],
    }
    rerender(<Wired facts={extracted} />)

    expect(screen.getByLabelText('Цільова посада')).toHaveValue('Platform Engineer')
    expect(screen.getByRole('textbox', { name: 'Навички' })).toHaveValue('Go\nKubernetes')
    expect(screen.getByLabelText('Посада, місце роботи 1')).toHaveValue('Backend Engineer')
  })

  it('a refetch does not overwrite a draft being typed', () => {
    const { rerender } = render(<Wired facts={EMPTY_RESUME_FACTS} />, { wrapper: Providers })
    fireEvent.change(screen.getByLabelText('Цільова посада'), { target: { value: 'Typed' } })
    rerender(<Wired facts={{ ...EMPTY_RESUME_FACTS, headline: 'Server' }} />)
    expect(screen.getByLabelText('Цільова посада')).toHaveValue('Typed')
  })

  it('Submit with unsaved facts saves first, then submits, in one action', async () => {
    const complete: ResumeFacts = {
      ...EMPTY_RESUME_FACTS,
      headline: 'Backend Engineer',
      skills: ['Go', 'SQL', 'Docker', 'Linux', 'Git'],
      languages: [{ name: 'English', level: 'C1' }],
      experience: [
        {
          ...ONE_JOB.experience[0]!,
          company: 'Acme',
          notes: ['Built the billing API'],
        },
      ],
    }
    const calls: string[] = []
    putMock.mockImplementation(() => {
      calls.push('put')
      return Promise.resolve({ data: { resume: null, canEdit: true, canConfirm: false } })
    })
    postMock.mockImplementation(() => {
      calls.push('post')
      return Promise.resolve({ data: { resume: null, canEdit: true, canConfirm: false } })
    })
    render(<Wired facts={complete} />, { wrapper: Providers })
    fireEvent.change(screen.getByLabelText('Цільова посада'), {
      target: { value: 'Senior Backend Engineer' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Надіслати на перевірку' }))
    await waitFor(() => expect(calls).toEqual(['put', 'post']))
    expect(postMock).toHaveBeenCalledWith('/users/senior-1/resume/submit')
  })

  it('"I work here now" clears and disables the end month', () => {
    const job = { ...ONE_JOB.experience[0]!, current: false, end: '2024-05' }
    render(<Wired facts={{ ...EMPTY_RESUME_FACTS, experience: [job] }} />, { wrapper: Providers })
    const toggle = screen.getByRole('switch', { name: 'Працюю тут зараз' })
    fireEvent.click(toggle)
    expect(toggle).toBeChecked()
    expect(
      screen.queryByText('Вкажіть місяць завершення або позначте «Працюю тут зараз»'),
    ).toBeNull()
  })

  it('a disabled form keeps the values readable but blocks every control', () => {
    render(
      <Providers>
        <ResumeFactsForm
          facts={{ ...EMPTY_RESUME_FACTS, headline: 'Backend Engineer' }}
          displayName="Alex Doe"
          disabled
          now={NOW}
          onSave={() => Promise.resolve()}
          onSubmit={() => Promise.resolve()}
        />
      </Providers>,
    )
    expect(screen.getByLabelText('Цільова посада')).toHaveValue('Backend Engineer')
    expect(screen.getByLabelText('Цільова посада')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Надіслати на перевірку' })).toBeDisabled()
  })
})

describe('moveItem', () => {
  it('moves an element and leaves out-of-range moves as a copy', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 1, 2)).toEqual(['a', 'b'])
  })
})
