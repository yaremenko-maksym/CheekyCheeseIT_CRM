/**
 * task-drop-share-override-and-receiver — Surface A (drop-share ShareSlider)
 * + Surface C (paymentType Select) interaction tests for `ProjectEditFields`.
 *
 * `ProjectEditFields` is a subcomponent of the 2000-line `$projectId.tsx`
 * route page — exported (test-only addition, no behavior change) so these
 * interaction tests can mount it directly with a minimal `useForm` harness
 * instead of rendering the entire route.
 *
 * Pins:
 * 1. Surface A — drop-share section renders ONLY when `dropId != null`, and
 *    only for viewers who are neither HR nor JUNIOR; ADMIN/ACCOUNTANT edit,
 *    everyone else sees it disabled.
 * 2. Surface A — changing the slider makes the form dirty and the value
 *    reaches submit.
 * 3. Surface C — the "Тип оплаты" Select renders 3 options; ADMIN/ACCOUNTANT
 *    edit, everyone else (who can still open the dialog — HR) sees it
 *    disabled with a hint.
 * 4. Surface C — selecting an option makes the form dirty and the value
 *    reaches submit.
 */
import { render, screen, within, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useForm } from '@tanstack/react-form'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { IT_DOMAINS } from '@crm/shared'
import { api } from '@/lib/axios'
import { ProjectEditFields } from '../ProjectEditFields'

// task-i18n-stage3a (Task 1) blast-radius: `ProjectEditFields` renders
// `ImageUploadField` (`components/ui/`), which now calls `useLingui()` —
// outside this file's own perimeter (`routes/_authenticated/projects/**`
// migrates in a later wave), so only the render wrapper changes here.
beforeEach(async () => {
  await loadCatalog('uk')
})

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

type HarnessValues = {
  name: string
  companyName: string
  domain: string
  logoDocumentId: string | null
  logoExternalUrl: string | null
  rate: number
  currency: string
  seniorSharePercentOverride: number | null
  dropSharePercentOverride: number | null
  techStack: string
  teamSize: string
  benefits: string
  paymentType: string
  salaryReview: string
  corpTech: string
  notesGeneral: string
}

const defaultHarnessValues: HarnessValues = {
  name: 'AI Platform',
  companyName: 'TechCorp',
  domain: 'Other',
  logoDocumentId: null,
  logoExternalUrl: null,
  rate: 5000,
  currency: 'USDT',
  seniorSharePercentOverride: null,
  dropSharePercentOverride: null,
  techStack: '',
  teamSize: '',
  benefits: '',
  paymentType: 'FOP',
  salaryReview: '',
  corpTech: '',
  notesGeneral: '',
}

function Harness({
  onSubmit,
  canEditOverride,
  dropId,
  viewerRole,
  defaultDropSharePercent = 5,
  pendingShare,
  mode = 'info',
  initial,
  noProject = false,
}: {
  onSubmit: (values: HarnessValues) => void
  mode?: 'info' | 'members'
  /** Overrides for the form's default values (leaf-5 mutation coverage). */
  initial?: Record<string, unknown>
  /** Render without a `projectId` prop (the create-flow shape). */
  noProject?: boolean
  canEditOverride: boolean
  dropId: string | null
  viewerRole: string | undefined
  defaultDropSharePercent?: number
  /** task-648-fix-round-2 (UX-H-3(r2)): the live proposal, if any. */
  pendingShare?: {
    percent: number | null
    effectivePercentAfterApproval: number
    approverId: string
    approverName: string
  } | null
}) {
  const form = useForm({
    defaultValues: { ...defaultHarnessValues, ...initial } as HarnessValues,
    onSubmit: async ({ value }) => onSubmit(value),
  })
  return (
    <I18nTestProvider>
      <QueryClientProvider client={new QueryClient()}>
        <ProjectEditFields
          form={form}
          mode={mode}
          canEditOverride={canEditOverride}
          defaultSharePercent={26}
          defaultDropSharePercent={defaultDropSharePercent}
          dropId={dropId}
          viewerRole={viewerRole}
          {...(noProject ? {} : { projectId: 'project-1' })}
          pendingShare={pendingShare ?? null}
        />
        <button type="button" data-testid="harness-submit" onClick={() => void form.handleSubmit()}>
          Submit
        </button>
      </QueryClientProvider>
    </I18nTestProvider>
  )
}

describe('ProjectEditFields — Surface A (drop-share ShareSlider)', () => {
  it('renders the section when dropId is set and viewer is ADMIN (editable)', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId="drop-1" viewerRole="ADMIN" />)
    expect(screen.getByTestId('project-edit-drop-share-section')).toBeInTheDocument()
    const input = screen.getByTestId('project-edit-drop-share-override')
    expect(input).not.toBeDisabled()
  })

  it('hides the section entirely when dropId is null (not a drop-project)', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    expect(screen.queryByTestId('project-edit-drop-share-section')).not.toBeInTheDocument()
  })

  it('hides the section for HR viewers even on a drop-project', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={false} dropId="drop-1" viewerRole="HR" />)
    expect(screen.queryByTestId('project-edit-drop-share-section')).not.toBeInTheDocument()
  })

  it('hides the section for JUNIOR viewers even on a drop-project', () => {
    render(
      <Harness onSubmit={vi.fn()} canEditOverride={false} dropId="drop-1" viewerRole="JUNIOR" />,
    )
    expect(screen.queryByTestId('project-edit-drop-share-section')).not.toBeInTheDocument()
  })

  it('shows the section disabled (read-only) for SENIOR/DROP viewers', () => {
    render(
      <Harness onSubmit={vi.fn()} canEditOverride={false} dropId="drop-1" viewerRole="SENIOR" />,
    )
    const section = screen.getByTestId('project-edit-drop-share-section')
    expect(section).toBeInTheDocument()
    expect(screen.getByTestId('project-edit-drop-share-override')).toBeDisabled()
    expect(
      within(section).getByText('Змінювати можуть лише Адміністратор або Бухгалтер.'),
    ).toBeInTheDocument()
  })

  it('defaults the slider value to defaultDropSharePercent when no override is set', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId="drop-1"
        viewerRole="ADMIN"
        defaultDropSharePercent={7}
      />,
    )
    expect(screen.getByTestId('project-edit-drop-share-override')).toHaveValue(7)
  })

  it('changing the slider value makes the form dirty and reaches submit', async () => {
    const onSubmit = vi.fn()
    render(
      <Harness onSubmit={onSubmit} canEditOverride={true} dropId="drop-1" viewerRole="ADMIN" />,
    )
    const input = screen.getByTestId('project-edit-drop-share-override')
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('harness-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ dropSharePercentOverride: 12 })
  })
})

// task-i18n-stage3c-pr4 — every field label in "info" mode used to be a
// LOCAL `Record<string, string>` inside the render (invisible to `lingui
// extract`, hoisted to module-level `EDIT_FIELD_LABEL_MESSAGES` per template
// G) — and none of them had a test reading the label text itself (only the
// `data-testid`s of their inputs were asserted). The mutation gate caught
// this: every label string, and the module-level map's own shape, survived
// mutation with every existing test green.
describe('ProjectEditFields — info-mode field labels (i18n)', () => {
  it('renders every field label text, once each, in the info form', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId="drop-1" viewerRole="ADMIN" />)
    for (const label of [
      'Логотип компанії',
      'Назва проєкту',
      'Компанія',
      'Домен',
      'Тип оплати',
      'Технологічний стек',
      'Склад команди',
      'Бенефіти',
      'Перегляд зарплати',
      'Корпоративна техніка',
      'Загальні нотатки',
      'Ставка',
      'Частка сеньйора (%)',
      'Частка дропа (%)',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })
})

// task-i18n-stage3c-pr4 — `cn(err && 'text-destructive')` on each Label
// mutates cleanly to `cn(true && …)`/`cn(false && …)` with every existing
// test green: nothing ever triggered the validators and read the Label's
// OWN class (only the separate `<p>` error message below each field was
// implicitly exercised by other Surface tests). One field per validator
// family — a `min(1)` string field and the senior/drop custom integer
// validators — is enough to exercise all four call sites (they share one
// `cn(err && …)` expression, so covering the branch pins them together).
describe('ProjectEditFields — error styling on Label (i18n)', () => {
  it('"Назва проєкту" label gains text-destructive after a min(1) validation error', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const input = screen.getByPlaceholderText('AI Platform v2')
    const label = screen.getByText('Назва проєкту')
    expect(label.className).not.toContain('text-destructive')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(label.className).toContain('text-destructive')
  })

  it('"Компанія" label gains text-destructive after a min(1) validation error', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const input = screen.getByPlaceholderText('TechCorp AI')
    const label = screen.getByText('Компанія')
    expect(label.className).not.toContain('text-destructive')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(label.className).toContain('text-destructive')
  })

  it('"Частка сеньйора (%)" label gains text-destructive after a non-integer value', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const input = screen.getByTestId('project-edit-senior-share-override')
    const label = screen.getByText('Частка сеньйора (%)')
    expect(label.className).not.toContain('text-destructive')

    fireEvent.change(input, { target: { value: '50.5' } })
    fireEvent.blur(input)

    expect(label.className).toContain('text-destructive')
    expect(screen.getByText('Введіть ціле число від 0 до 100')).toBeInTheDocument()
  })

  it('"Частка дропа (%)" label gains text-destructive after a non-integer value', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId="drop-1" viewerRole="ADMIN" />)
    const input = screen.getByTestId('project-edit-drop-share-override')
    const label = screen.getByText('Частка дропа (%)')
    expect(label.className).not.toContain('text-destructive')

    fireEvent.change(input, { target: { value: '50.5' } })
    fireEvent.blur(input)

    expect(label.className).toContain('text-destructive')
    expect(screen.getByText('Введіть ціле число від 0 до 100')).toBeInTheDocument()
  })
})

describe('ProjectEditFields — Surface C (paymentType Select)', () => {
  it('renders 3 payment-type options, editable for ADMIN', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const trigger = screen.getByTestId('project-payment-type-trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger).not.toBeDisabled()
    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getByText('ФОП')).toBeInTheDocument()
    expect(within(listbox).getByText('гіг-контракт')).toBeInTheDocument()
    expect(within(listbox).getByText('USDT')).toBeInTheDocument()
  })

  it('is disabled with a hint for non-ADMIN/ACCOUNTANT viewers (e.g. HR)', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={false} dropId={null} viewerRole="HR" />)
    expect(screen.getByTestId('project-payment-type-trigger')).toBeDisabled()
    expect(
      screen.getByText('Змінювати можуть лише Адміністратор або Бухгалтер.'),
    ).toBeInTheDocument()
  })

  it('selecting an option makes the form dirty and reaches submit', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    fireEvent.click(screen.getByTestId('project-payment-type-trigger'))
    fireEvent.click(screen.getByText('гіг-контракт'))
    fireEvent.click(screen.getByTestId('harness-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ paymentType: 'GIG_CONTRACT' })
  })
})

// ---------------------------------------------------------------------------
// task-648-fix-round-2 (UX-H-3(r2)) — the project edit form stops hiding a
// live proposal. The designer opened this dialog against a project with a
// live proposal and found the full dialog text mentioned it nowhere: the
// slider simply showed the ACTIVE value, so an ADMIN typing a new number
// superseded a proposal they had no way of knowing existed.
// ---------------------------------------------------------------------------

const PENDING = {
  percent: 55,
  effectivePercentAfterApproval: 55,
  approverId: 'senior-1',
  approverName: 'Олексій Коваленко',
}

describe('ProjectEditFields — live proposal notice', () => {
  it('names the proposed percent and the approver when a proposal is live', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId={null}
        viewerRole="ADMIN"
        pendingShare={PENDING}
      />,
    )
    const notice = screen.getByTestId('pending-share-edit-notice-project')
    expect(notice).toHaveTextContent('55%')
    expect(notice).toHaveTextContent('Олексій Коваленко')
  })

  it('is absent when no proposal is live', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId={null}
        viewerRole="ADMIN"
        pendingShare={null}
      />,
    )
    expect(screen.getByTestId('project-edit-senior-share-section')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-share-edit-notice-project')).toBeNull()
  })

  it('is absent for a viewer who cannot edit the override — the backend would 403 the withdraw', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={false}
        dropId={null}
        viewerRole="SENIOR"
        pendingShare={PENDING}
      />,
    )
    expect(screen.getByTestId('project-edit-senior-share-section')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-share-edit-notice-project')).toBeNull()
  })

  it('a "clear the override" proposal shows the RESOLVED fallback percent, never null', () => {
    // `percent === null` is a real proposal ("drop the project override, fall
    // back to team/default") — the server resolves what that would become
    // (`effectivePercentAfterApproval`) so the client never has to guess. The
    // round-1 findings COPY-H-2/H-3 were exactly this branch printing a wrong
    // number; here it must print the resolved one.
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId={null}
        viewerRole="ADMIN"
        pendingShare={{ ...PENDING, percent: null, effectivePercentAfterApproval: 26 }}
      />,
    )
    const notice = screen.getByTestId('pending-share-edit-notice-project')
    expect(notice).toHaveTextContent('Запропоновано 26%')
    expect(notice).not.toHaveTextContent('null')
  })

  it('a concrete proposal shows the proposed percent, not the resolved one', () => {
    // The mirror case: when `percent` is a number the two fields can differ
    // (a team override could change what "effective" resolves to), and the
    // notice must name what was PROPOSED.
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId={null}
        viewerRole="ADMIN"
        pendingShare={{ ...PENDING, percent: 55, effectivePercentAfterApproval: 26 }}
      />,
    )
    const notice = screen.getByTestId('pending-share-edit-notice-project')
    expect(notice).toHaveTextContent('Запропоновано 55%')
    expect(notice).not.toHaveTextContent('Запропоновано 26%')
  })

  it('the slider hint tells the reader the new value is not live until confirmed', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId={null}
        viewerRole="ADMIN"
        pendingShare={null}
      />,
    )
    // task-648-fix-round-2 (COPY-H-6). Also pins the removal of round 1's
    // promise that the same value CANCELS an open proposal — that gesture
    // no longer does anything (SR-H-2), and text must not promise it.
    const section = screen.getByTestId('project-edit-senior-share-section')
    expect(section).toHaveTextContent('почне діяти після підтвердження сеньйора')
    expect(section).not.toHaveTextContent('скасувати надіслану пропозицію')
  })

  // task-648-fix-round-3 (COPY-M-16). The hint used to carry two tenses about
  // one save — «Это же значение СБРАСЫВАЕТ переопределение» (present, and no
  // longer true: nothing on this form takes effect on save) next to «начнёт
  // действовать после подтверждения» (future) — plus a word the product does
  // not use anywhere else.
  it('the hint speaks in ONE tense, and in the product vocabulary', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId={null}
        viewerRole="ADMIN"
        pendingShare={null}
      />,
    )
    const section = screen.getByTestId('project-edit-senior-share-section')
    // Both claims about this save are in the FUTURE, because both are.
    expect(section).toHaveTextContent('знімає індивідуальну частку по проєкту')
    expect(section).toHaveTextContent('Будь-яка зміна почне діяти після підтвердження')
    // The present tense promised something that does not happen on save.
    expect(section).not.toHaveTextContent('скидає')
    // CONTEXT.md's «Доля синьора» entry calls the personal level
    // «(за замовчуванням)»; «перевизначення» is jargon this UI invented.
    expect(section).not.toHaveTextContent('перевизначення')

    // task-648-fix-round-4 (COPY-L-16): the caveat comes FIRST. Round 3 left
    // it third, so the reader met «те саме значення знімає індивідуальну
    // частку» as an unqualified promise and learnt only afterwards that it
    // waits for the senior — two claims to hold at once to answer one
    // question. Asserted by POSITION, not by presence: both sentences were
    // already on screen when the defect was raised, so a presence assertion
    // could not have caught it and cannot catch its return.
    const hint = section.textContent ?? ''
    const caveatAt = hint.indexOf('Будь-яка зміна почне діяти')
    const clearsAt = hint.indexOf('знімає індивідуальну частку по проєкту')
    expect(caveatAt).toBeGreaterThanOrEqual(0)
    expect(clearsAt).toBeGreaterThanOrEqual(0)
    expect(caveatAt).toBeLessThan(clearsAt)

    // The percent is glued to the sentence by a `{' '}` JSX fragment, which is
    // a string literal like any other — empty it and the hint reads «За
    // замовчуванням —26%». Position and presence assertions both stay green
    // on that; only reading the joint does not. (Found by the mutation gate
    // on this very line, not guessed.)
    expect(hint).toContain('За замовчуванням — 26%: те саме значення знімає')
  })
})

// ---------------------------------------------------------------------------
// Mikado leaf 5 (extraction of ProjectEditFields into its own file). The
// mutation gate now evaluates this component as changed code and found the
// pre-existing coverage gaps below: mode gating, the logo field, validators,
// the senior/drop RBAC gating and the plain inputs. Pure assertions on the
// existing behaviour — nothing here changes it.
// ---------------------------------------------------------------------------

const adminHint = 'Змінювати можуть лише Адміністратор або Бухгалтер.'
/** The red validation-error paragraphs inside `root` (whole document by default). */
const errParas = (root: HTMLElement = document.body) =>
  within(root).queryAllByText((_content, el) => {
    return el?.tagName === 'P' && el.classList.contains('text-destructive')
  })

async function submitValues(onSubmit: ReturnType<typeof vi.fn>): Promise<HarnessValues> {
  fireEvent.click(screen.getByTestId('harness-submit'))
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  return onSubmit.mock.calls[0]![0] as HarnessValues
}

describe('ProjectEditFields — mode gating', () => {
  it('renders nothing for mode="members"', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId="drop-1"
        viewerRole="ADMIN"
        mode="members"
      />,
    )
    expect(screen.queryByText('Назва проєкту')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-edit-senior-share-section')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })
})

describe('ProjectEditFields — logo field', () => {
  it('seeds the logo field from the form values (external URL -> url mode)', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId={null}
        viewerRole="ADMIN"
        initial={{ logoExternalUrl: 'https://example.com/logo-1.png' }}
      />,
    )
    expect(screen.getByTestId('image-upload-field-url-input')).toHaveValue(
      'https://example.com/logo-1.png',
    )
  })

  it('a URL typed into the logo field reaches the form (onChange wiring)', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    fireEvent.click(screen.getByTestId('image-upload-field-mode-url'))
    const input = screen.getByTestId('image-upload-field-url-input')
    fireEvent.change(input, { target: { value: 'https://example.com/new.png' } })
    fireEvent.blur(input)
    const values = await submitValues(onSubmit)
    expect(values.logoExternalUrl).toBe('https://example.com/new.png')
    expect(values.logoDocumentId).toBeNull()
  })

  async function uploadLogo(noProject: boolean): Promise<FormData> {
    vi.mocked(api.post).mockClear()
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId={null}
        viewerRole="ADMIN"
        noProject={noProject}
      />,
    )
    const file = new File(['x'], 'logo.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('image-upload-field-file-input'), {
      target: { files: [file] },
    })
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    return vi.mocked(api.post).mock.calls[0]![1] as FormData
  }

  it('scopes a logo upload to the project when a projectId is given', async () => {
    const fd = await uploadLogo(false)
    expect(fd.get('projectId')).toBe('project-1')
    expect(fd.get('category')).toBe('LOGO')
  })

  it('sends no projectId when the form has none (create flow)', async () => {
    const fd = await uploadLogo(true)
    expect(fd.has('projectId')).toBe(false)
  })
})

describe('ProjectEditFields — name / company validation', () => {
  it.each([
    ['AI Platform v2', 'Назва проєкту'],
    ['TechCorp AI', 'Компанія'],
  ])('%s field: whitespace-only is rejected and the error is styled', (placeholder) => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const input = screen.getByPlaceholderText(placeholder)
    // Pristine: no error paragraph, no destructive border.
    expect(errParas()).toHaveLength(0)
    expect(input.className).not.toContain('border-destructive')

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)

    const errs = errParas()
    expect(errs).toHaveLength(1)
    expect(errs[0]).toHaveTextContent(/\S/)
    expect(input.className).toContain('border-destructive')
  })

  it.each([
    ['AI Platform v2', 'Назва проєкту'],
    ['TechCorp AI', 'Компанія'],
  ])('%s field: a valid value (surrounded by spaces) raises no error', (placeholder) => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const input = screen.getByPlaceholderText(placeholder)
    fireEvent.change(input, { target: { value: '  Valid  ' } })
    fireEvent.blur(input)
    expect(errParas()).toHaveLength(0)
    expect(input.className).not.toContain('border-destructive')
  })
})

describe('ProjectEditFields — plain inputs reach the form', () => {
  it('domain select lists every IT domain and writes the choice', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const select = screen.getByDisplayValue('Other')
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([...IT_DOMAINS])
    const other = IT_DOMAINS.find((d) => d !== 'Other')!
    fireEvent.change(select, { target: { value: other } })
    expect((await submitValues(onSubmit)).domain).toBe(other)
  })

  it('free-text field inputs and the notes textarea write to the form', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    // DOM order of the textboxes: name, company, techStack, teamSize,
    // benefits, salaryReview, corpTech, notes (textarea), amount.
    const boxes = screen.getAllByRole('textbox')
    expect(boxes).toHaveLength(9)
    fireEvent.change(boxes[2]!, { target: { value: 'React, Nest' } })
    expect(boxes[7]!.tagName).toBe('TEXTAREA')
    fireEvent.change(boxes[7]!, { target: { value: 'hello notes' } })
    const values = await submitValues(onSubmit)
    expect(values.techStack).toBe('React, Nest')
    expect(values.notesGeneral).toBe('hello notes')
  })

  it('the payment-type hint is absent for an editor', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    expect(screen.queryByText(adminHint)).not.toBeInTheDocument()
  })
})

describe('ProjectEditFields — rate and currency', () => {
  it('shows the current rate and currency, and writes edits back', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const amount = screen.getByTestId('amount-currency-amount-input')
    expect(amount).toHaveValue('5000')
    fireEvent.change(amount, { target: { value: '7500' } })

    const currencyTrigger = screen.getAllByRole('combobox').find((el) => el.textContent === 'USDT')!
    fireEvent.click(currencyTrigger)
    fireEvent.click(within(screen.getByRole('listbox')).getByText('EUR'))

    const values = await submitValues(onSubmit)
    expect(values.rate).toBe(7500)
    expect(values.currency).toBe('EUR')
  })
})

describe.each([
  {
    name: 'senior',
    sectionId: 'project-edit-senior-share-section',
    inputId: 'project-edit-senior-share-override',
    field: 'seniorSharePercentOverride',
    dropId: null as string | null,
    defaultPct: 26,
  },
  {
    name: 'drop',
    sectionId: 'project-edit-drop-share-section',
    inputId: 'project-edit-drop-share-override',
    field: 'dropSharePercentOverride',
    dropId: 'drop-1' as string | null,
    defaultPct: 5,
  },
])('ProjectEditFields — $name share section', (c) => {
  const renderIt = (
    over: { canEdit?: boolean; role?: string | undefined; initial?: Record<string, unknown> } = {},
  ) =>
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={over.canEdit ?? true}
        dropId={c.dropId}
        viewerRole={'role' in over ? over.role : 'ADMIN'}
        initial={over.initial ?? {}}
      />,
    )

  it('shows the default percent when there is no override, and the override when set', () => {
    renderIt()
    expect(screen.getByTestId(c.inputId)).toHaveValue(c.defaultPct)
    cleanup()
    renderIt({ initial: { [c.field]: 40 } })
    expect(screen.getByTestId(c.inputId)).toHaveValue(40)
  })

  it('treats an undefined override like no override (default shown, no error)', () => {
    renderIt({ initial: { [c.field]: undefined } })
    const input = screen.getByTestId(c.inputId)
    expect(input).toHaveValue(c.defaultPct)
    fireEvent.blur(input)
    expect(errParas(screen.getByTestId(c.sectionId))).toHaveLength(0)
  })

  it('is hidden for HR and JUNIOR viewers, visible for others', () => {
    renderIt({ role: 'HR' })
    expect(screen.queryByTestId(c.sectionId)).not.toBeInTheDocument()
    cleanup()
    renderIt({ role: 'JUNIOR' })
    expect(screen.queryByTestId(c.sectionId)).not.toBeInTheDocument()
    cleanup()
    renderIt({ role: 'SENIOR', canEdit: false })
    expect(screen.getByTestId(c.sectionId)).toBeInTheDocument()
    cleanup()
    renderIt({ role: undefined })
    expect(screen.getByTestId(c.sectionId)).toBeInTheDocument()
  })

  it('input is enabled for editors and disabled (with hint) for everyone else', () => {
    renderIt({ canEdit: true })
    expect(screen.getByTestId(c.inputId)).not.toBeDisabled()
    expect(within(screen.getByTestId(c.sectionId)).queryByText(adminHint)).toBeNull()
    cleanup()
    renderIt({ canEdit: false, role: 'SENIOR' })
    expect(screen.getByTestId(c.inputId)).toBeDisabled()
    expect(within(screen.getByTestId(c.sectionId)).getByText(adminHint)).toBeInTheDocument()
  })

  it.each([0, 100, 37])('accepts the in-range integer %i without an error', (n) => {
    renderIt({ initial: { [c.field]: 40 } })
    const input = screen.getByTestId(c.inputId)
    fireEvent.change(input, { target: { value: String(n) } })
    fireEvent.blur(input)
    const section = screen.getByTestId(c.sectionId)
    expect(errParas(section)).toHaveLength(0)
    expect(input.className).not.toContain('border-destructive')
  })

  it.each([-1, 101])('rejects the out-of-range integer %i with an error and red border', (n) => {
    renderIt({ initial: { [c.field]: n } })
    const input = screen.getByTestId(c.inputId)
    fireEvent.blur(input)
    const section = screen.getByTestId(c.sectionId)
    expect(within(section).getByText('Введіть ціле число від 0 до 100')).toBeInTheDocument()
    expect(input.className).toContain('border-destructive')
  })

  it('a non-integer shows the error paragraph and red border; a valid blur shows neither', () => {
    renderIt()
    const input = screen.getByTestId(c.inputId)
    const section = screen.getByTestId(c.sectionId)
    expect(errParas(section)).toHaveLength(0)
    fireEvent.change(input, { target: { value: '50.5' } })
    fireEvent.blur(input)
    expect(errParas(section)).toHaveLength(1)
    expect(input.className).toContain('border-destructive')
  })
})
