import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobSuggestionDto } from '@crm/shared'

import { JobSuggestionDialog } from '../JobSuggestionDialog'

/**
 * JobSuggestionDialog — task-job-sourcing-slice1 AC5 + AC6.
 *
 * AC5: «Открыть оригинал» must call `window.open` SYNCHRONOUSLY inside the
 *      click handler. The assertion runs immediately after `fireEvent.click`
 *      with NO `await` in between — an implementation that awaited the status
 *      mutation (or anything else) first would fail here, which is exactly the
 *      PR #476 defect (silently dead button on mobile).
 *
 * AC6: a description carrying `<script>` / `<img onerror>` must render as TEXT.
 *      This is the RENDER half of the XSS defence; the INGEST half lives in
 *      apps/api/src/job-sourcing/html-to-markdown.spec.ts.
 */

const mutate = vi.fn()

vi.mock('@/hooks/use-job-sourcing', () => ({
  useJobSuggestions: () => ({ data: mockQueue, isLoading: false, isError: false }),
  useJobExclusions: () => ({ data: { items: [] }, isLoading: false }),
  useUpdateJobSuggestionStatus: () => ({ mutate, isPending: false }),
  useCreateJobExclusion: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteJobExclusion: () => ({ mutate: vi.fn(), isPending: false }),
}))

function suggestion(overrides: Partial<JobSuggestionDto['posting']> = {}): JobSuggestionDto {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    seniorId: '11111111-1111-4111-8111-111111111111',
    status: 'NEW',
    statusChangedAt: null,
    statusChangedByName: null,
    createdAt: '2026-08-07T09:00:00.000Z',
    posting: {
      id: '22222222-2222-4222-8222-222222222222',
      sourceType: 'DOU_RSS',
      externalId: 'https://jobs.dou.ua/companies/epam/vacancies/1',
      url: 'https://jobs.dou.ua/companies/epam/vacancies/1',
      title: 'Senior Frontend Engineer',
      companyName: 'EPAM',
      location: 'Київ, віддалено',
      descriptionMd: 'We are **hiring** a frontend engineer.',
      publishedAt: '2026-08-07T08:48:38.000Z',
      collectedAt: '2026-08-07T09:00:00.000Z',
      ...overrides,
    },
  }
}

let mockQueue: { items: JobSuggestionDto[]; total: number } = { items: [], total: 0 }

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <JobSuggestionDialog open onClose={() => {}} seniorId={undefined} />
    </QueryClientProvider>,
  )
}

describe('JobSuggestionDialog', () => {
  beforeEach(() => {
    mockQueue = { items: [suggestion()], total: 3 }
    mutate.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the vacancy title, company and location', async () => {
    renderDialog()
    expect(await screen.findByTestId('job-suggestion-title')).toHaveTextContent(
      'Senior Frontend Engineer',
    )
    expect(screen.getByTestId('job-suggestion-company')).toHaveTextContent('EPAM')
    expect(screen.getByTestId('job-queue-counter')).toHaveTextContent('3')
  })

  it('renders the description as markdown (bold becomes <strong>)', async () => {
    renderDialog()
    const description = await screen.findByTestId('job-suggestion-description')
    expect(description.querySelector('strong')?.textContent).toBe('hiring')
  })

  // ── AC5 ────────────────────────────────────────────────────────────────────

  it('AC5: «Открыть оригинал» calls window.open SYNCHRONOUSLY on click', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    renderDialog()

    const button = await screen.findByTestId('job-open-original')
    fireEvent.click(button)

    // NO await between the click and this assertion — that is the whole point.
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(
      'https://jobs.dou.ua/companies/epam/vacancies/1',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('AC5: opening does NOT wait on (or fire) the status mutation', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    renderDialog()

    fireEvent.click(await screen.findByTestId('job-open-original'))

    expect(open).toHaveBeenCalledTimes(1)
    // Opening the original is not an outcome — the senior still has to say
    // whether they applied.
    expect(mutate).not.toHaveBeenCalled()
  })

  it('AC5: a non-https url is refused instead of being opened', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    mockQueue = { items: [suggestion({ url: 'javascript:alert(1)' })], total: 1 }
    renderDialog()

    fireEvent.click(await screen.findByTestId('job-open-original'))
    expect(open).not.toHaveBeenCalled()
  })

  // ── AC6 ────────────────────────────────────────────────────────────────────

  it('AC6: a description with an injected <script> renders as text, not markup', async () => {
    mockQueue = {
      items: [
        suggestion({
          descriptionMd: '<script>alert(document.cookie)</script>Real description text',
        }),
      ],
      total: 1,
    }
    renderDialog()

    const description = await screen.findByTestId('job-suggestion-description')
    expect(document.body.querySelector('script')).toBeNull()
    expect(description.innerHTML).not.toContain('<script')
    expect(description.textContent).toContain('Real description text')
  })

  it('AC6: an <img onerror> payload never becomes an element', async () => {
    mockQueue = {
      items: [suggestion({ descriptionMd: '<img src=x onerror="alert(1)"> Job text' })],
      total: 1,
    }
    renderDialog()

    const description = await screen.findByTestId('job-suggestion-description')
    // No element, and no element carrying the handler as a real ATTRIBUTE…
    expect(document.body.querySelector('img')).toBeNull()
    expect(document.body.querySelector('[onerror]')).toBeNull()
    // …the payload is inert TEXT. (Asserting `innerHTML` has no `onerror`
    // SUBSTRING would be wrong: escaped text legitimately contains the word,
    // and that is exactly the safe outcome.)
    expect(description.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  /**
   * Security-review round 2, HIGH-1 — LAYER INDEPENDENCE.
   *
   * Each test below feeds the description the API would produce IF the ingest
   * layer had failed completely, i.e. the raw attacker-authored markdown. They
   * pass only because of props this component sets itself (`urlTransform`,
   * `img`, `a`) — not because of anything the API did, and not because of
   * react-markdown's default behaviour, which the previous round leaned on
   * without knowing it.
   */
  it('HIGH-1: a markdown image beacon is not rendered even if it reaches the client', async () => {
    mockQueue = {
      items: [
        suggestion({
          descriptionMd:
            '[t](https://ok.example/x)![](https://evil.example/px.png?leak=1) Job text',
        }),
      ],
      total: 1,
    }
    renderDialog()

    await screen.findByTestId('job-suggestion-description')
    // No request to a foreign host is possible: no <img> is rendered at all.
    expect(document.body.querySelector('img')).toBeNull()
    expect(document.body.innerHTML).not.toContain('evil.example')
    expect(screen.getByTestId('job-suggestion-description').textContent).toContain('Job text')
  })

  it('HIGH-1: no <img> is rendered for ANY markdown image syntax', async () => {
    mockQueue = {
      items: [
        suggestion({ descriptionMd: '![alt](https://evil.example/a.png) and ![](/local.png)' }),
      ],
      total: 1,
    }
    renderDialog()

    await screen.findByTestId('job-suggestion-description')
    expect(document.body.querySelectorAll('img')).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain('evil.example')
  })

  it('HIGH-1: a phishing link injected as markdown still gets rel/noopener and https-only', async () => {
    mockQueue = {
      items: [suggestion({ descriptionMd: '[Apply here](https://evil.example/phish)' })],
      total: 1,
    }
    renderDialog()

    const link = (await screen.findByTestId('job-suggestion-description')).querySelector('a')
    // It is still a link (we cannot tell a phishing host from a real one), but
    // it can never reach back into our window and never leaks our URL.
    expect(link?.getAttribute('rel')).toContain('noopener')
    expect(link?.getAttribute('rel')).toContain('noreferrer')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('HIGH-1: a non-https markdown link is rendered as text, by OUR urlTransform', async () => {
    mockQueue = {
      items: [suggestion({ descriptionMd: '[click](http://insecure.example/x)' })],
      total: 1,
    }
    renderDialog()

    const description = await screen.findByTestId('job-suggestion-description')
    expect(description.querySelector('a')).toBeNull()
    expect(description.textContent).toContain('click')
  })

  it('renders the angle-bracket destination form the API now emits', async () => {
    mockQueue = {
      items: [suggestion({ descriptionMd: '[Apply](<https://jobs.dou.ua/x/1>)' })],
      total: 1,
    }
    renderDialog()

    const link = (await screen.findByTestId('job-suggestion-description')).querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://jobs.dou.ua/x/1')
  })

  it('AC6: a markdown link to javascript: is not rendered as a live href', async () => {
    mockQueue = {
      items: [suggestion({ descriptionMd: '[click me](javascript:alert(1))' })],
      total: 1,
    }
    renderDialog()

    const description = await screen.findByTestId('job-suggestion-description')
    const link = description.querySelector('a')
    // react-markdown's default urlTransform strips unsafe protocols; whatever it
    // leaves behind must not be a javascript: href.
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:')
  })

  // ── Statuses + empty state ────────────────────────────────────────────────

  it('«Откликнулись» sends APPLIED', async () => {
    renderDialog()
    fireEvent.click(await screen.findByTestId('job-mark-applied'))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        id: '33333333-3333-4333-8333-333333333333',
        status: 'APPLIED',
      }),
    )
  })

  it('«Не подходит» sends REJECTED', async () => {
    renderDialog()
    fireEvent.click(await screen.findByTestId('job-mark-rejected'))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        id: '33333333-3333-4333-8333-333333333333',
        status: 'REJECTED',
      }),
    )
  })

  it('shows an empty state when nothing passes the filters', async () => {
    mockQueue = { items: [], total: 0 }
    renderDialog()

    expect(await screen.findByTestId('job-suggestion-empty')).toHaveTextContent(
      'Подходящих вакансий нет',
    )
    expect(screen.getByTestId('job-open-original')).toBeDisabled()
    expect(screen.getByTestId('job-mark-applied')).toBeDisabled()
  })
})
