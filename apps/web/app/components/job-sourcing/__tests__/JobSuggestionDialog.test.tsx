import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobSuggestionDto, JobSuggestionListDto } from '@crm/shared'

import { JobSuggestionDialog, MARKDOWN_URL_TRANSFORM } from '../JobSuggestionDialog'
import { isSafeExternalUrl } from '../open-original'

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
const createExclusion = vi.fn()

vi.mock('@/hooks/use-job-sourcing', () => ({
  // Defaults for the ranking fields (task-vacancy-matching) are spread in HERE
  // rather than repeated in ~15 `mockQueue = …` assignments: a test that does
  // not care about ranking should not have to restate its shape, and one that
  // does overrides exactly the field it is about.
  useJobSuggestions: () => ({
    // `data` is undefined while loading / on error — the same shape the real
    // hook returns, which is what the `?? []` fallbacks in the dialog exist for.
    data:
      mockState.isLoading || mockState.isError
        ? undefined
        : { lowMatch: [], lowMatchCount: 0, threshold: 0.2, stackKeywords: [], ...mockQueue },
    isLoading: mockState.isLoading,
    isError: mockState.isError,
  }),
  useJobExclusions: () => ({ data: { items: [] }, isLoading: false }),
  useJobSources: () => ({ data: { items: [] }, isLoading: false, isError: false }),
  useUpdateJobSuggestionStatus: () => ({ mutate, isPending: false }),
  useCreateJobExclusion: () => ({ mutate: createExclusion, isPending: false }),
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
    matchScore: null,
    matchedKeywords: [],
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

let mockQueue: Partial<JobSuggestionListDto> & { items: JobSuggestionDto[]; total: number } = {
  items: [],
  total: 0,
}

let mockState = { isLoading: false, isError: false }

function renderDialog(canViewBudgets = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <JobSuggestionDialog
        open
        onClose={() => {}}
        seniorId={undefined}
        canViewBudgets={canViewBudgets}
      />
    </QueryClientProvider>,
  )
}

describe('JobSuggestionDialog', () => {
  beforeEach(() => {
    mockQueue = { items: [suggestion()], total: 3 }
    mockState = { isLoading: false, isError: false }
    mutate.mockClear()
    createExclusion.mockClear()
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

  /**
   * Round 3, BLOCKER 1 — the previous test called itself "by OUR urlTransform"
   * but was satisfied by the `a` component: deleting `urlTransform` entirely
   * left 23/23 green. The two props now have DISTINCT jobs, and these two tests
   * discriminate between them (verified by removing each prop separately):
   *
   *   prop removed      | "pins urlTransform" | "pins the a component"
   *   ------------------|---------------------|-----------------------
   *   urlTransform      | FAILS               | passes
   *   a                 | passes              | FAILS
   *
   * `http:` (not `javascript:`) is the probe on purpose: react-markdown's
   * DEFAULT transform already blocks dangerous schemes, so a `javascript:`
   * payload cannot tell our prop apart from the library's. Plain `http:` is
   * allowed by the default and rejected by ours — the one behaviour that is
   * unambiguously OURS.
   */
  it('pins urlTransform: an http: link never reaches the DOM as a live href', async () => {
    mockQueue = {
      items: [suggestion({ descriptionMd: '[click](http://insecure.example/x)' })],
      total: 1,
    }
    renderDialog()

    const description = await screen.findByTestId('job-suggestion-description')
    const hrefs = Array.from(description.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs.filter((h) => h && h.length > 0)).toEqual([])
    expect(description.innerHTML).not.toContain('insecure.example')
    expect(description.textContent).toContain('click')
  })

  it('pins the `a` component: an https link gets rel/noopener and a new tab', async () => {
    mockQueue = {
      items: [suggestion({ descriptionMd: '[Apply](https://jobs.dou.ua/x/1)' })],
      total: 1,
    }
    renderDialog()

    const link = (await screen.findByTestId('job-suggestion-description')).querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://jobs.dou.ua/x/1')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(link?.getAttribute('target')).toBe('_blank')
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

  it('AC6: a javascript: destination is rejected by OUR transform, not the library’s', async () => {
    // Round 3: this test used to assert only that no `javascript:` href reached
    // the DOM — a property react-markdown's DEFAULT transform already provides,
    // so it passed whether or not our code did anything. It now asserts our own
    // predicate directly (the same one that guards `window.open`), which is the
    // part we are actually responsible for.
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(MARKDOWN_URL_TRANSFORM('javascript:alert(1)')).toBe('')

    mockQueue = {
      items: [suggestion({ descriptionMd: '[click me](javascript:alert(1))' })],
      total: 1,
    }
    renderDialog()

    const description = await screen.findByTestId('job-suggestion-description')
    expect(description.querySelector('a[href]')).toBeNull()
    expect(description.textContent).toContain('click me')
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

  /**
   * Design review round 3: on a SENIOR's own screen the dialog passes
   * `seniorId={undefined}` (the API resolves the queue to the caller), and the
   * submit handler bailed out on exactly that — «Добавить» did nothing at all,
   * with no request reaching the server. The role that most needs a personal
   * exclusion was the one role that could not create one.
   */
  it('a SENIOR can add their own exclusion even though seniorId is undefined', async () => {
    renderDialog()

    const input = await screen.findByTestId('job-exclusion-input')
    fireEvent.change(input, { target: { value: 'Ciklum' } })

    const addButton = screen.getByTestId('job-exclusion-add')
    expect(addButton).not.toBeDisabled()
    fireEvent.click(addButton)

    await waitFor(() => expect(createExclusion).toHaveBeenCalledTimes(1))
    expect(createExclusion.mock.calls[0]?.[0]).toEqual({
      scope: 'SENIOR',
      kind: 'COMPANY',
      value: 'Ciklum',
    })
  })

  it('does not submit a value too short to be a company (visible refusal, not silence)', async () => {
    renderDialog()

    fireEvent.change(await screen.findByTestId('job-exclusion-input'), { target: { value: 'a' } })
    // The refusal is VISIBLE — the control is disabled, not silently inert.
    expect(screen.getByTestId('job-exclusion-add')).toBeDisabled()
    expect(createExclusion).not.toHaveBeenCalled()
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

  /**
   * task-vacancy-matching AC3 — "скрытая вакансия это нерассмотренная вакансия".
   *
   * The rule these tests defend is not "a counter is rendered" but "nothing is
   * lost": whatever the threshold demoted stays reachable, reviewable, and
   * counted honestly. The most dangerous case is the last one — an empty
   * headline queue while demoted vacancies exist, which is precisely when a
   * silent filter looks exactly like an empty feed.
   */
  describe('low-match tail (AC3)', () => {
    const weak = () => ({
      ...suggestion({ title: 'Middle PHP Developer' }),
      id: '44444444-4444-4444-8444-444444444444',
      matchScore: 0.05,
      matchedKeywords: [],
    })

    it('shows how many were collapsed, without dropping them', async () => {
      mockQueue = { items: [suggestion()], total: 4, lowMatch: [weak()], lowMatchCount: 3 }
      renderDialog()

      expect(await screen.findByTestId('job-low-match-count')).toHaveTextContent(
        'Ещё 3 с низким совпадением',
      )
    })

    it('keeps the collapsed ones out of the queue until they are expanded', async () => {
      mockQueue = { items: [suggestion()], total: 2, lowMatch: [weak()], lowMatchCount: 1 }
      renderDialog()

      expect(await screen.findByTestId('job-suggestion-title')).toHaveTextContent(
        'Senior Frontend Engineer',
      )
      expect(screen.getByTestId('job-low-match-toggle')).toHaveAttribute('aria-expanded', 'false')
    })

    it('expanding appends them to the queue instead of replacing it', async () => {
      mockQueue = { items: [suggestion()], total: 2, lowMatch: [weak()], lowMatchCount: 1 }
      renderDialog()

      fireEvent.click(await screen.findByTestId('job-low-match-toggle'))

      expect(screen.getByTestId('job-low-match-toggle')).toHaveAttribute('aria-expanded', 'true')
      // Still the strong match at the head — expanding must not reorder the good
      // ones behind the demoted ones.
      expect(screen.getByTestId('job-suggestion-title')).toHaveTextContent(
        'Senior Frontend Engineer',
      )
    })

    it('a demoted vacancy becomes reviewable once expanded', async () => {
      // The headline queue is EMPTY and one vacancy sits below the threshold —
      // without the toggle this screen would say "нет вакансий" while hiding a
      // real one. After expanding, the demoted vacancy is shown and actionable.
      mockQueue = { items: [], total: 1, lowMatch: [weak()], lowMatchCount: 1 }
      renderDialog()

      expect(await screen.findByTestId('job-suggestion-empty')).toHaveTextContent(
        'Вакансий с высоким совпадением нет',
      )

      fireEvent.click(screen.getByTestId('job-low-match-toggle'))

      expect(screen.getByTestId('job-suggestion-title')).toHaveTextContent('Middle PHP Developer')
      expect(screen.getByTestId('job-mark-applied')).toBeEnabled()
    })

    it('renders no counter when the threshold demoted nothing', async () => {
      mockQueue = { items: [suggestion()], total: 1, lowMatch: [], lowMatchCount: 0 }
      renderDialog()

      await screen.findByTestId('job-suggestion-card')
      expect(screen.queryByTestId('job-low-match-toggle')).toBeNull()
    })
  })

  /**
   * The render branches, one assertion each.
   *
   * Raised by the mutation gate: the guards around these sections could be
   * flipped and the strings blanked with the suite still green. They are all
   * user-visible states of the same dialog, so none of them is suppressible —
   * a "loading" screen that also renders the low-match counter, or an empty
   * state that says the wrong thing, is exactly what a reviewer would catch by
   * eye and a test should catch first.
   */
  describe('states that must not bleed into each other', () => {
    it('shows no low-match counter and no stack hint WHILE LOADING', async () => {
      mockQueue = { items: [], total: 0, lowMatch: [], lowMatchCount: 5 }
      mockState = { isLoading: true, isError: false }
      renderDialog()

      await screen.findByTestId('job-suggestion-dialog')
      expect(screen.queryByTestId('job-low-match-toggle')).toBeNull()
      expect(screen.queryByTestId('job-no-stack-hint')).toBeNull()
    })

    it('shows no low-match counter and no stack hint ON ERROR', async () => {
      mockQueue = { items: [], total: 0, lowMatch: [], lowMatchCount: 5 }
      mockState = { isLoading: false, isError: true }
      renderDialog()

      await screen.findByTestId('job-suggestion-error')
      expect(screen.queryByTestId('job-low-match-toggle')).toBeNull()
      expect(screen.queryByTestId('job-no-stack-hint')).toBeNull()
    })

    it('survives an undefined payload without throwing', async () => {
      // The `?? []` fallbacks: on error the hook returns no data at all, and the
      // dialog still has to render its own error state rather than crash.
      mockState = { isLoading: false, isError: true }
      renderDialog()
      expect(await screen.findByTestId('job-suggestion-error')).toBeInTheDocument()
    })

    it('the empty state names the reason: nothing at all vs nothing above the threshold', async () => {
      mockQueue = { items: [], total: 0, lowMatch: [], lowMatchCount: 0 }
      const { unmount } = renderDialog()
      const empty = await screen.findByTestId('job-suggestion-empty')
      expect(empty).toHaveTextContent('Подходящих вакансий нет')
      expect(empty).toHaveTextContent('Новые появятся после следующего сбора')
      unmount()

      mockQueue = { items: [], total: 4, lowMatch: [], lowMatchCount: 4 }
      renderDialog()
      const collapsed = await screen.findByTestId('job-suggestion-empty')
      expect(collapsed).toHaveTextContent('Вакансий с высоким совпадением нет')
      expect(collapsed).toHaveTextContent('Ниже — те, что совпали со стеком слабее')
    })

    it('explains where the expanded vacancies went, only once expanded', async () => {
      mockQueue = { items: [suggestion()], total: 2, lowMatch: [], lowMatchCount: 1 }
      renderDialog()

      const section = await screen.findByTestId('job-low-match')
      expect(section).not.toHaveTextContent('ничего не потеряно')

      fireEvent.click(screen.getByTestId('job-low-match-toggle'))
      expect(screen.getByTestId('job-low-match')).toHaveTextContent('ничего не потеряно')
    })

    it('hides the source budgets from anyone but an ADMIN', async () => {
      mockQueue = { items: [suggestion()], total: 1 }
      const { unmount } = renderDialog()
      await screen.findByTestId('job-suggestion-card')
      // Default is "not an admin" — the endpoint behind this panel is ADMIN-only,
      // so asking for it as anyone else buys a guaranteed 403.
      expect(screen.queryByTestId('job-source-budgets')).toBeNull()
      unmount()

      renderDialog(true)
      expect(await screen.findByTestId('job-source-budgets')).toBeInTheDocument()
    })
  })

  describe('match explanation (AC1)', () => {
    it('shows the score and the keywords it matched on', async () => {
      mockQueue = {
        items: [{ ...suggestion(), matchScore: 0.75, matchedKeywords: ['react', 'typescript'] }],
        total: 1,
        stackKeywords: ['react', 'typescript', 'nodejs', 'docker'],
      }
      renderDialog()

      expect(await screen.findByTestId('job-match-summary')).toHaveTextContent(
        'Совпадение со стеком: 75%',
      )
      expect(screen.getAllByTestId('job-match-keyword').map((n) => n.textContent)).toEqual([
        'react',
        'typescript',
      ])
    })

    it('says the queue is unranked when the senior has no stack on file', async () => {
      // 0 of 4 active seniors had a resume when this shipped, so this is the
      // DEFAULT experience, not an edge case. It must explain itself rather than
      // look like a ranking that rated everything equally.
      mockQueue = { items: [suggestion()], total: 1, stackKeywords: [] }
      renderDialog()

      expect(await screen.findByTestId('job-no-stack-hint')).toHaveTextContent('Стек не задан')
      expect(screen.queryByTestId('job-match-summary')).toBeNull()
    })

    it('shows no score hint once a stack exists', async () => {
      mockQueue = {
        items: [{ ...suggestion(), matchScore: 0.5, matchedKeywords: ['react'] }],
        total: 1,
        stackKeywords: ['react', 'docker'],
      }
      renderDialog()

      await screen.findByTestId('job-match-summary')
      expect(screen.queryByTestId('job-no-stack-hint')).toBeNull()
    })
  })
})
