/**
 * Mikado leaf 13 — characterization of the project edit dialog extracted from
 * `$projectId.tsx` into `ProjectEditDialog.tsx`. SECURITY-SENSITIVE: the point of
 * this file is the field-scoped RBAC in the submitted PATCH body — HR/SENIOR/
 * JUNIOR (`canEditOverride=false`) must NEVER send `paymentType`,
 * `seniorSharePercentOverride` or `dropSharePercentOverride`. Expected values are
 * hand-written literals, not derived from the code under test.
 *
 * `ProjectEditFields` is stubbed: it is covered by its own spec; here it only
 * exposes the dialog-owned `form` so tests can put the form into a known state.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useStore } from '@tanstack/react-form'
import type { ProjectDetailDto } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ProjectEditDialog } from '../ProjectEditDialog'

interface StubForm {
  setFieldValue: (name: string, value: unknown) => void
  store: Parameters<typeof useStore>[0]
}
const h = vi.hoisted(() => ({
  form: null as unknown,
  fieldProps: null as unknown,
  options: null as unknown,
  renders: [] as string[],
}))

vi.mock('@tanstack/react-form', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-form')>()
  return {
    ...actual,
    useForm: (opts: unknown) => {
      h.options = opts
      return (actual.useForm as (o: unknown) => unknown)(opts)
    },
  }
})

vi.mock('../ProjectEditFields', () => ({
  ProjectEditFields: (props: { form: StubForm }) => {
    h.form = props.form
    h.fieldProps = props
    const values = useStore(props.form.store, (s) => (s as { values: unknown }).values)
    h.renders.push(String((values as Record<string, unknown>).name))
    return <pre data-testid="form-values">{JSON.stringify(values)}</pre>
  },
}))
vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

import { api } from '@/lib/axios'

function makeProject(over: Partial<Record<string, unknown>> = {}): ProjectDetailDto {
  return {
    id: 'proj-1',
    name: 'Alpha',
    companyName: 'Acme',
    domain: 'FinTech',
    logoDocumentId: null,
    logoExternalUrl: 'https://img.example/logo.png',
    rate: 40,
    currency: 'EUR',
    seniorSharePercentOverride: 30,
    dropSharePercentOverride: 7,
    seniorSharePercentDefault: 26,
    dropSharePercentDefault: null,
    dropId: 'drop-1',
    pendingSeniorShare: null,
    techStack: 'React',
    teamSize: '5',
    benefits: 'Gym',
    paymentType: 'GIG_CONTRACT',
    salaryReview: 'Yearly',
    corpTech: 'Slack',
    notesGeneral: 'Note',
    ...over,
  } as unknown as ProjectDetailDto
}

const form = (): StubForm => h.form as StubForm
const setField = (name: string, value: unknown): void => {
  act(() => form().setFieldValue(name, value))
}
const shownValues = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId('form-values').textContent ?? '{}') as Record<string, unknown>

type Props = React.ComponentProps<typeof ProjectEditDialog>

let qc: QueryClient
function tree(props: Props) {
  return (
    <QueryClientProvider client={qc}>
      <ProjectEditDialog {...props} />
    </QueryClientProvider>
  )
}
function baseProps(over: Partial<Props> = {}): Props {
  return {
    project: makeProject(),
    projectId: 'proj-1',
    viewerRole: 'ADMIN',
    canOpenEdit: true,
    canEditOverride: true,
    open: true,
    onClose: vi.fn(),
    ...over,
  }
}
function setup(over: Partial<Props> = {}) {
  const props = baseProps(over)
  const utils = render(tree(props), { wrapper: I18nTestProvider })
  return { props, ...utils }
}

async function save(): Promise<Record<string, unknown>> {
  await userEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
  const [url, body] = vi.mocked(api.patch).mock.calls[0] ?? []
  expect(url).toBe('/projects/proj-1')
  return body as Record<string, unknown>
}

beforeEach(async () => {
  await loadCatalog('uk')
  vi.mocked(api.patch).mockReset()
  vi.mocked(api.patch).mockResolvedValue({ data: {} })
  h.form = null
  h.fieldProps = null
  h.options = null
  h.renders = []
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

describe('ProjectEditDialog — open / reset-on-open', () => {
  it('renders nothing while closed', () => {
    setup({ open: false })
    expect(screen.queryByText('Редагувати — Acme')).toBeNull()
    expect(screen.queryByTestId('form-values')).toBeNull()
  })

  it('populates every field from the project when opened', async () => {
    setup()
    expect(await screen.findByText('Редагувати — Acme')).toBeTruthy()
    expect(shownValues()).toEqual({
      name: 'Alpha',
      companyName: 'Acme',
      domain: 'FinTech',
      logoDocumentId: null,
      logoExternalUrl: 'https://img.example/logo.png',
      rate: 40,
      currency: 'EUR',
      seniorSharePercentOverride: 30,
      dropSharePercentOverride: 7,
      techStack: 'React',
      teamSize: '5',
      benefits: 'Gym',
      paymentType: 'GIG_CONTRACT',
      salaryReview: 'Yearly',
      corpTech: 'Slack',
      notesGeneral: 'Note',
    })
  })

  it('falls back to FOP / null / empty for a legacy project and coerces an unknown domain to Other', () => {
    setup({
      project: makeProject({
        domain: 'Legacy-Domain',
        paymentType: null,
        seniorSharePercentOverride: null,
        dropSharePercentOverride: null,
        logoExternalUrl: null,
        techStack: null,
        teamSize: null,
        benefits: null,
        salaryReview: null,
        corpTech: null,
        notesGeneral: null,
      }),
    })
    const v = shownValues()
    expect(v.domain).toBe('Other')
    expect(v.paymentType).toBe('FOP')
    expect(v.seniorSharePercentOverride).toBeNull()
    expect(v.dropSharePercentOverride).toBeNull()
    expect(v.logoExternalUrl).toBeNull()
    expect(v.techStack).toBe('')
    expect(v.teamSize).toBe('')
    expect(v.benefits).toBe('')
    expect(v.salaryReview).toBe('')
    expect(v.corpTech).toBe('')
    expect(v.notesGeneral).toBe('')
  })

  it('re-reads the CURRENT project on reopen, discarding earlier edits', () => {
    const { rerender, props } = setup()
    setField('name', 'Typed but abandoned')
    rerender(tree({ ...props, open: false }))
    rerender(tree({ ...props, open: true, project: makeProject({ name: 'Beta', rate: 99 }) }))
    expect(shownValues().name).toBe('Beta')
    expect(shownValues().rate).toBe(99)
  })

  it('does not clobber in-progress edits when the project refetches while open', () => {
    const { rerender, props } = setup()
    setField('name', 'Typing…')
    rerender(tree({ ...props, project: makeProject({ name: 'Server renamed' }) }))
    expect(shownValues().name).toBe('Typing…')
  })

  it('exposes the initial form defaults derived from the project (before any open)', () => {
    setup({ open: false })
    expect((h.options as { defaultValues: unknown }).defaultValues).toEqual({
      name: 'Alpha',
      companyName: 'Acme',
      domain: 'FinTech',
      logoDocumentId: null,
      logoExternalUrl: 'https://img.example/logo.png',
      rate: 40,
      currency: 'EUR',
      seniorSharePercentOverride: 30,
      dropSharePercentOverride: 7,
      techStack: 'React',
      teamSize: '5',
      benefits: 'Gym',
      paymentType: 'GIG_CONTRACT',
      salaryReview: 'Yearly',
      corpTech: 'Slack',
      notesGeneral: 'Note',
    })
  })

  it('falls back to empty / null / USDT / FOP / Other defaults for a legacy project', () => {
    setup({
      open: false,
      project: makeProject({
        domain: 'Legacy-Domain',
        logoDocumentId: null,
        logoExternalUrl: null,
        rate: null,
        currency: null,
        paymentType: null,
        seniorSharePercentOverride: null,
        dropSharePercentOverride: null,
        techStack: null,
        teamSize: null,
        benefits: null,
        salaryReview: null,
        corpTech: null,
        notesGeneral: null,
      }),
    })
    expect((h.options as { defaultValues: unknown }).defaultValues).toStrictEqual({
      name: 'Alpha',
      companyName: 'Acme',
      domain: 'Other',
      logoDocumentId: null,
      logoExternalUrl: null,
      rate: '',
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
    })
  })

  it('populates a stored logo document id on open and in the initial defaults', () => {
    setup({ project: makeProject({ logoDocumentId: 'doc-9', logoExternalUrl: null }) })
    expect(
      (h.options as { defaultValues: Record<string, unknown> }).defaultValues.logoDocumentId,
    ).toBe('doc-9')
    expect(shownValues().logoDocumentId).toBe('doc-9')
    expect(shownValues().logoExternalUrl).toBeNull()
  })

  it('never renders the fields with stale values: not on first open, not on reopen', () => {
    const closedA = baseProps({ open: false })
    const { rerender } = render(tree(closedA), { wrapper: I18nTestProvider })
    const openB = { ...closedA, open: true, project: makeProject({ name: 'Beta' }) }
    rerender(tree(openB))
    expect(h.renders.length).toBeGreaterThan(0)
    expect(h.renders.every((n) => n === 'Beta')).toBe(true)

    setField('name', 'Typed')
    rerender(tree({ ...openB, open: false }))
    h.renders = []
    rerender(tree({ ...openB, open: true, project: makeProject({ name: 'Gamma' }) }))
    expect(h.renders.length).toBeGreaterThan(0)
    expect(h.renders.every((n) => n === 'Gamma')).toBe(true)
  })

  it('keeps the edited values after closing (no reset on close) until the next open', () => {
    const { rerender, props } = setup()
    setField('name', 'Typed')
    rerender(tree({ ...props, open: false }))
    const state = (form().store as unknown as { state: { values: Record<string, unknown> } }).state
    expect(state.values.name).toBe('Typed')
    expect(screen.queryByTestId('form-values')).toBeNull()
  })

  it('passes the page-supplied RBAC context through to the fields', () => {
    setup({ viewerRole: 'ACCOUNTANT', canEditOverride: true })
    const p = h.fieldProps as Record<string, unknown>
    expect(p.mode).toBe('info')
    expect(p.canEditOverride).toBe(true)
    expect(p.viewerRole).toBe('ACCOUNTANT')
    expect(p.projectId).toBe('proj-1')
    expect(p.defaultSharePercent).toBe(26)
    expect(p.defaultDropSharePercent).toBe(5)
    expect(p.dropId).toBe('drop-1')
  })

  it('passes the drop default share when the project has one', () => {
    setup({ project: makeProject({ dropSharePercentDefault: 9 }) })
    expect((h.fieldProps as Record<string, unknown>).defaultDropSharePercent).toBe(9)
  })

  it('shows neither fields nor footer when the viewer cannot open edit', () => {
    setup({ canOpenEdit: false })
    expect(screen.queryByTestId('form-values')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Скасувати' })).toBeNull()
  })
})

describe('ProjectEditDialog — SECURITY: field-scoped RBAC in the PATCH body', () => {
  it('canEditOverride=false: financial keys are ABSENT even when the form holds changed values', async () => {
    setup({ canEditOverride: false, viewerRole: 'HR' })
    setField('paymentType', 'USDT')
    setField('seniorSharePercentOverride', 45)
    setField('dropSharePercentOverride', 12)
    const body = await save()
    const keys = Object.keys(body)
    expect(keys).not.toContain('paymentType')
    expect(keys).not.toContain('seniorSharePercentOverride')
    expect(keys).not.toContain('dropSharePercentOverride')
    // the non-financial payload is still sent
    expect(body.name).toBe('Alpha')
    expect(body.rate).toBe(40)
  })

  it('canEditOverride=false: financial keys are ABSENT with unchanged values too', async () => {
    setup({ canEditOverride: false, viewerRole: 'SENIOR' })
    const keys = Object.keys(await save())
    expect(keys).not.toContain('paymentType')
    expect(keys).not.toContain('seniorSharePercentOverride')
    expect(keys).not.toContain('dropSharePercentOverride')
  })

  it('canEditOverride=true: paymentType is always sent; unchanged overrides are omitted', async () => {
    setup()
    const body = await save()
    expect(body.paymentType).toBe('GIG_CONTRACT')
    const keys = Object.keys(body)
    expect(keys).not.toContain('seniorSharePercentOverride')
    expect(keys).not.toContain('dropSharePercentOverride')
  })

  it('canEditOverride=true: paymentType is sent even for a legacy project defaulted to FOP', async () => {
    setup({ project: makeProject({ paymentType: null }) })
    expect((await save()).paymentType).toBe('FOP')
  })

  it('canEditOverride=true: a changed senior override is sent, the unchanged drop override is not', async () => {
    setup()
    setField('seniorSharePercentOverride', 35)
    const body = await save()
    expect(body.seniorSharePercentOverride).toBe(35)
    expect(Object.keys(body)).not.toContain('dropSharePercentOverride')
  })

  it('canEditOverride=true: a changed drop override is sent, the unchanged senior override is not', async () => {
    setup()
    setField('dropSharePercentOverride', 10)
    const body = await save()
    expect(body.dropSharePercentOverride).toBe(10)
    expect(Object.keys(body)).not.toContain('seniorSharePercentOverride')
  })

  it('canEditOverride=true: clearing an override to null is sent as an explicit null', async () => {
    setup()
    setField('seniorSharePercentOverride', null)
    setField('dropSharePercentOverride', null)
    const body = await save()
    expect(body.seniorSharePercentOverride).toBeNull()
    expect(body.dropSharePercentOverride).toBeNull()
  })

  it('canEditOverride=true: undefined vs null override counts as unchanged (null-normalised)', async () => {
    setup({
      project: makeProject({ seniorSharePercentOverride: null, dropSharePercentOverride: null }),
    })
    setField('seniorSharePercentOverride', undefined)
    setField('dropSharePercentOverride', undefined)
    const keys = Object.keys(await save())
    expect(keys).not.toContain('seniorSharePercentOverride')
    expect(keys).not.toContain('dropSharePercentOverride')
  })

  it('sends the override when the project had none and the user sets one (0 is a real change)', async () => {
    setup({
      project: makeProject({ seniorSharePercentOverride: null, dropSharePercentOverride: null }),
    })
    setField('seniorSharePercentOverride', 0)
    const body = await save()
    expect(body.seniorSharePercentOverride).toBe(0)
    expect(Object.keys(body)).not.toContain('dropSharePercentOverride')
  })
})

describe('ProjectEditDialog — payload trimming', () => {
  it('trims strings; empty / whitespace-only optional text becomes null, required text undefined', async () => {
    setup()
    setField('name', '   ')
    setField('companyName', '  Globex  ')
    setField('techStack', '   ')
    setField('teamSize', ' 8 ')
    setField('benefits', '  ')
    setField('salaryReview', '  Quarterly ')
    setField('corpTech', '   ')
    setField('notesGeneral', ' hi ')
    const body = await save()
    expect(body.name).toBeUndefined()
    expect(body.companyName).toBe('Globex')
    expect(body.techStack).toBeNull()
    expect(body.teamSize).toBe('8')
    expect(body.benefits).toBeNull()
    expect(body.salaryReview).toBe('Quarterly')
    expect(body.corpTech).toBeNull()
    expect(body.notesGeneral).toBe('hi')
  })

  it('coerces rate to a number; an empty/zero rate becomes undefined', async () => {
    setup()
    setField('rate', '55')
    expect((await save()).rate).toBe(55)
    vi.mocked(api.patch).mockClear()
    setField('rate', '')
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    const body = vi.mocked(api.patch).mock.calls[0]?.[1] as Record<string, unknown>
    expect(body.rate).toBeUndefined()
  })

  it('sends a stored logo document id and external url as-is', async () => {
    setup({ project: makeProject({ logoDocumentId: 'doc-9', logoExternalUrl: null }) })
    const body = await save()
    expect(body.logoDocumentId).toBe('doc-9')
    expect(body.logoExternalUrl).toBeNull()
  })

  it('sends a stored external logo url as-is', async () => {
    setup()
    const body = await save()
    expect(body.logoExternalUrl).toBe('https://img.example/logo.png')
    expect(body.logoDocumentId).toBeNull()
  })

  it('passes domain / currency / logo fields through; null logos stay null', async () => {
    setup({ project: makeProject({ logoExternalUrl: null }) })
    const body = await save()
    expect(body.domain).toBe('FinTech')
    expect(body.currency).toBe('EUR')
    expect(body.logoDocumentId).toBeNull()
    expect(body.logoExternalUrl).toBeNull()
  })
})

describe('ProjectEditDialog — mutation lifecycle', () => {
  it('closes the dialog and invalidates the projects queries on success', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { props } = setup()
    await save()
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('keeps the dialog open and does not invalidate when the PATCH fails', async () => {
    vi.mocked(api.patch).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { props } = setup()
    await save()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Зберегти' })).toBeTruthy())
    expect(props.onClose).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
  })

  it('disables Save and shows the pending label while the PATCH is in flight', async () => {
    let resolve: (v: { data: object }) => void = () => {}
    vi.mocked(api.patch).mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    setup()
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    const pending = await screen.findByRole('button', { name: 'Збереження…' })
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      resolve({ data: {} })
    })
  })

  it('Cancel closes the dialog without sending anything', async () => {
    const { props } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('Escape closes the dialog through onClose', async () => {
    const { props } = setup()
    await userEvent.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
