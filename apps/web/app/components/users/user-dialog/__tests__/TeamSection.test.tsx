/**
 * Characterization tests for `TeamSection` after it moved out of `UserDialog.tsx`
 * verbatim. SECURITY-SENSITIVE (RBAC team assignment): pins which role/mode
 * renders which sub-block (DROP create, SENIOR create/edit incl. the
 * CREATE_NEW / JOIN_DROP_TEAM split, JUNIOR create/edit, no section for the
 * rest), the HR / accountant wiring, the vacant-drop-team picker and the JUNIOR
 * project lists through a real TanStack form.
 */
import { render as rtlRender, screen, fireEvent, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from '@tanstack/react-form'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ProjectDto, TeamDto, UserProfileDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { TeamSection } from '../TeamSection'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      onClick,
    }: {
      children?: React.ReactNode
      to?: string
      onClick?: () => void
    }) => (
      <a href={to ?? '#'} onClick={onClick}>
        {children}
      </a>
    ),
  }
})

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

const hr = (id: string, displayName: string) =>
  ({
    id,
    displayName,
    avatarUrl: null,
    email: `${id}@x.io`,
    role: 'HR',
  }) as unknown as UserProfileDto
const acc = (id: string, displayName: string) =>
  ({
    id,
    displayName,
    avatarUrl: null,
    email: `${id}@x.io`,
    role: 'ACCOUNTANT',
  }) as unknown as UserProfileDto

const HR_A = hr('hr-a', 'Hanna HR')
const HR_B = hr('hr-b', 'Hlib HR')
const ACC_A = acc('acc-a', 'Anna Accountant')

const dropTeam = (id: string, name: string, withDrop: boolean, hrs: string[]): TeamDto =>
  ({
    id,
    name,
    type: 'DROP',
    members: [
      ...(withDrop
        ? [{ userId: 'd1', role: 'DROP', leftAt: null, displayName: 'Dmytro Drop' }]
        : []),
      ...hrs.map((h, i) => ({ userId: `h${i}`, role: 'HR', leftAt: null, displayName: h })),
      { userId: 'x', role: 'HR', leftAt: '2026-01-01', displayName: 'Left HR' },
    ],
  }) as unknown as TeamDto

const project = (id: string, name: string, companyName: string): ProjectDto =>
  ({ id, name, companyName, members: [] }) as unknown as ProjectDto

interface Overrides {
  role?: string
  teamMode?: string
  isCreate?: boolean
  hrUsers?: UserProfileDto[]
  accountantUsers?: UserProfileDto[]
  selectedHrIds?: string[]
  hrError?: string
  selectedAccountantId?: string
  vacantDropTeams?: TeamDto[]
  availableJuniorProjects?: ProjectDto[]
  juniorActiveProjects?: ProjectDto[]
}

interface Spies {
  handleHrChange: Mock<(next: string[]) => void>
  setSelectedAccountantId: Mock<(next: string) => void>
  onClose: Mock<() => void>
}

function Harness({ o = {}, spies }: { o?: Overrides; spies: Spies }) {
  const form = useForm({
    defaultValues: {
      role: o.role ?? 'SENIOR',
      teamMode: o.teamMode ?? 'CREATE_NEW',
      dropTeamId: '',
      teamTelegramChannel: '',
      teamTelegramChannelDrop: '',
      projectId: '',
    },
  })
  const isCreate = o.isCreate ?? true
  return (
    <>
      <TeamSection
        form={form}
        isCreate={isCreate}
        isEdit={!isCreate}
        hrUsers={o.hrUsers ?? [HR_A, HR_B]}
        accountantUsers={o.accountantUsers ?? [ACC_A]}
        selectedHrIds={o.selectedHrIds ?? []}
        handleHrChange={spies.handleHrChange}
        hrError={o.hrError}
        selectedAccountantId={o.selectedAccountantId ?? ''}
        setSelectedAccountantId={spies.setSelectedAccountantId}
        vacantDropTeams={o.vacantDropTeams ?? []}
        availableJuniorProjects={o.availableJuniorProjects ?? []}
        juniorActiveProjects={o.juniorActiveProjects ?? []}
        onClose={spies.onClose}
      />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
    </>
  )
}

function setup(o: Overrides = {}) {
  const spies: Spies = {
    handleHrChange: vi.fn<(next: string[]) => void>(),
    setSelectedAccountantId: vi.fn<(next: string) => void>(),
    onClose: vi.fn<() => void>(),
  }
  render(<Harness o={o} spies={spies} />)
  return spies
}

function values() {
  return JSON.parse(screen.getByTestId('values').textContent ?? '{}') as Record<string, unknown>
}

function typeChannel(testId: string, value: string) {
  const el = screen.getByTestId(testId)
  fireEvent.change(el, { target: { value } })
  fireEvent.blur(el)
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('TeamSection — role gating', () => {
  it.each(['ADMIN', 'HR', 'ACCOUNTANT'])('%s renders no team section', (role) => {
    setup({ role })
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-hr-multiselect')).not.toBeInTheDocument()
  })

  it('DROP in edit mode renders no team section (role lock, PATCH path)', () => {
    setup({ role: 'DROP', isCreate: false })
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-hr-multiselect')).not.toBeInTheDocument()
  })
})

describe('TeamSection — DROP (create)', () => {
  it('renders the drop-team heading, HR + accountant pickers and the channel field', () => {
    setup({ role: 'DROP' })
    expect(screen.getByRole('heading', { name: 'Команда дропа' })).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-hr-multiselect')).toBeInTheDocument()
    expect(screen.getByText('Бухгалтер')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-drop-team-telegram-channel')).toBeInTheDocument()
    // No senior-only controls on the drop flow.
    expect(screen.queryByTestId('user-dialog-team-mode')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-team-telegram-channel')).not.toBeInTheDocument()
  })

  it('HR is marked required and shows the inline hrError', () => {
    setup({ role: 'DROP', hrError: 'Оберіть мінімум одного HR' })
    expect(screen.getByText('Оберіть мінімум одного HR')).toBeInTheDocument()
    expect(screen.getByText('*')).toBeInTheDocument()
  })

  it('shows no hrError text when none is set', () => {
    setup({ role: 'DROP' })
    expect(screen.queryByText('Оберіть мінімум одного HR')).not.toBeInTheDocument()
  })

  it('removing a selected HR forwards the remaining ids to handleHrChange', () => {
    const spies = setup({ role: 'DROP', selectedHrIds: ['hr-a', 'hr-b'] })
    fireEvent.click(screen.getByTestId('user-dialog-hr-remove-hr-a'))
    expect(spies.handleHrChange).toHaveBeenCalledWith(['hr-b'])
  })

  it('a single HR in the system is locked (onlyHr): no remove button', () => {
    setup({ role: 'DROP', hrUsers: [HR_A], selectedHrIds: ['hr-a'] })
    expect(screen.getByTestId('user-dialog-hr-chip-hr-a')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-hr-remove-hr-a')).not.toBeInTheDocument()
  })

  it('two HRs in the system are removable (onlyHr false)', () => {
    setup({ role: 'DROP', selectedHrIds: ['hr-a'] })
    expect(screen.getByTestId('user-dialog-hr-remove-hr-a')).toBeInTheDocument()
  })

  it('clearing the accountant calls setSelectedAccountantId("")', () => {
    const spies = setup({
      role: 'DROP',
      accountantUsers: [ACC_A, acc('acc-b', 'Borys Accountant')],
      selectedAccountantId: 'acc-a',
    })
    fireEvent.click(screen.getByTestId('user-dialog-accountant-clear'))
    expect(spies.setSelectedAccountantId).toHaveBeenCalledWith('')
  })

  it('a single accountant in the system is locked (onlyAccountant): no clear button', () => {
    setup({ role: 'DROP', selectedAccountantId: 'acc-a' })
    expect(screen.getByTestId('user-dialog-accountant-chip')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-accountant-clear')).not.toBeInTheDocument()
  })

  it('channel: invalid handle on blur shows the format error and no hint', () => {
    setup({ role: 'DROP' })
    typeChannel('user-dialog-drop-team-telegram-channel', 'ab')
    expect(
      screen.getByText('Канал у Telegram: 5–32 символи — латиниця, цифри або _'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Необов’язково. Канал для спілкування команди.'),
    ).not.toBeInTheDocument()
  })

  it.each(['team_channel', '@team_channel', '  @team_channel  '])(
    'channel: valid handle %j raises no error and keeps the hint',
    (handle) => {
      setup({ role: 'DROP' })
      typeChannel('user-dialog-drop-team-telegram-channel', handle)
      expect(
        screen.queryByText('Канал у Telegram: 5–32 символи — латиниця, цифри або _'),
      ).not.toBeInTheDocument()
      expect(screen.getByText('Необов’язково. Канал для спілкування команди.')).toBeInTheDocument()
    },
  )

  it('channel: blank / whitespace-only value is optional (no error)', () => {
    setup({ role: 'DROP' })
    typeChannel('user-dialog-drop-team-telegram-channel', 'abcde')
    typeChannel('user-dialog-drop-team-telegram-channel', '   ')
    expect(
      screen.queryByText('Канал у Telegram: 5–32 символи — латиниця, цифри або _'),
    ).not.toBeInTheDocument()
  })

  it('channel: untouched-but-blurred pristine field raises no error', () => {
    setup({ role: 'DROP' })
    fireEvent.blur(screen.getByTestId('user-dialog-drop-team-telegram-channel'))
    expect(
      screen.queryByText('Канал у Telegram: 5–32 символи — латиниця, цифри або _'),
    ).not.toBeInTheDocument()
  })

  it('channel input writes the teamTelegramChannelDrop form value', () => {
    setup({ role: 'DROP' })
    typeChannel('user-dialog-drop-team-telegram-channel', 'team_channel')
    expect(values().teamTelegramChannelDrop).toBe('team_channel')
  })
})

describe('TeamSection — SENIOR', () => {
  it('create: shows the team-mode picker with the senior heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'Команда' })).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-team-mode')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-team-mode-create-new')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-team-mode-join-drop')).toBeInTheDocument()
  })

  it('edit: no team-mode picker, legacy HR / accountant / channel controls', () => {
    setup({ isCreate: false })
    expect(screen.queryByTestId('user-dialog-team-mode')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-hr-multiselect')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-team-telegram-channel')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-drop-team-trigger')).not.toBeInTheDocument()
  })

  it('edit: HR is not marked required', () => {
    setup({ isCreate: false })
    expect(screen.queryByText('*')).not.toBeInTheDocument()
  })

  it('create + CREATE_NEW: HR is required and shows hrError; channel field present', () => {
    setup({ hrError: 'Оберіть мінімум одного HR' })
    expect(screen.getByText('Оберіть мінімум одного HR')).toBeInTheDocument()
    // team-mode field + HR field are both required in create
    expect(screen.getAllByText('*')).toHaveLength(2)
    expect(screen.getByTestId('user-dialog-team-telegram-channel')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-drop-team-trigger')).not.toBeInTheDocument()
  })

  it('CREATE_NEW: removing HR and clearing accountant forward to the parent handlers', () => {
    const spies = setup({
      selectedHrIds: ['hr-a', 'hr-b'],
      accountantUsers: [ACC_A, acc('acc-b', 'Borys Accountant')],
      selectedAccountantId: 'acc-a',
    })
    fireEvent.click(screen.getByTestId('user-dialog-hr-remove-hr-b'))
    expect(spies.handleHrChange).toHaveBeenCalledWith(['hr-a'])
    fireEvent.click(screen.getByTestId('user-dialog-accountant-clear'))
    expect(spies.setSelectedAccountantId).toHaveBeenCalledWith('')
  })

  it('CREATE_NEW: a single HR / accountant are locked', () => {
    setup({ hrUsers: [HR_A], selectedHrIds: ['hr-a'], selectedAccountantId: 'acc-a' })
    expect(screen.queryByTestId('user-dialog-hr-remove-hr-a')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-accountant-clear')).not.toBeInTheDocument()
  })

  it('CREATE_NEW: channel validator rejects a bad handle, accepts a good one, optional when blank', () => {
    setup()
    const err = 'Канал у Telegram: 5–32 символи — латиниця, цифри або _'
    fireEvent.blur(screen.getByTestId('user-dialog-team-telegram-channel'))
    expect(screen.queryByText(err)).not.toBeInTheDocument()
    typeChannel('user-dialog-team-telegram-channel', 'ab')
    expect(screen.getByText(err)).toBeInTheDocument()
    expect(
      screen.queryByText('Необов’язково. Канал для спілкування команди.'),
    ).not.toBeInTheDocument()
    typeChannel('user-dialog-team-telegram-channel', '@good_channel')
    expect(screen.queryByText(err)).not.toBeInTheDocument()
    expect(screen.getByText('Необов’язково. Канал для спілкування команди.')).toBeInTheDocument()
    typeChannel('user-dialog-team-telegram-channel', '   ')
    expect(screen.queryByText(err)).not.toBeInTheDocument()
    expect(values().teamTelegramChannel).toBe('   ')
  })

  it('JOIN radio is disabled and says so when there are no vacant drop-teams', () => {
    setup()
    expect(screen.getByTestId('user-dialog-team-mode-join-drop')).toBeDisabled()
    expect(screen.getByText('Немає команд дропа без активного сеньйора.')).toBeInTheDocument()
  })

  it('JOIN radio is enabled and pluralises the vacant count', () => {
    setup({ vacantDropTeams: [dropTeam('t1', 'Alpha', true, ['H1'])] })
    expect(screen.getByTestId('user-dialog-team-mode-join-drop')).toBeEnabled()
    expect(screen.getByText('1 команда доступна.')).toBeInTheDocument()
    expect(screen.queryByText('Немає команд дропа без активного сеньйора.')).not.toBeInTheDocument()
  })

  it('JOIN radio pluralises few / many', () => {
    setup({
      vacantDropTeams: [
        dropTeam('t1', 'A', true, []),
        dropTeam('t2', 'B', true, []),
        dropTeam('t3', 'C', true, []),
      ],
    })
    expect(screen.getByText('3 команди доступні.')).toBeInTheDocument()
  })

  it('picking JOIN_DROP_TEAM swaps HR/accountant/channel for the drop-team picker', async () => {
    const user = userEvent.setup()
    setup({ vacantDropTeams: [dropTeam('t1', 'Alpha', true, ['H1'])] })
    await user.click(screen.getByTestId('user-dialog-team-mode-join-drop'))
    await waitFor(() => expect(values().teamMode).toBe('JOIN_DROP_TEAM'))
    expect(screen.getByTestId('user-dialog-drop-team-trigger')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-hr-multiselect')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-team-telegram-channel')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('user-dialog-team-mode-create-new'))
    await waitFor(() => expect(values().teamMode).toBe('CREATE_NEW'))
    expect(screen.getByTestId('user-dialog-hr-multiselect')).toBeInTheDocument()
  })

  it('JOIN_DROP_TEAM + no vacant teams: shows the empty hint, no select', () => {
    setup({ teamMode: 'JOIN_DROP_TEAM' })
    expect(
      screen.getByText(
        'Немає команд дропа без активного сеньйора. Створіть дропа або оберіть «Створити свою команду».',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-drop-team-trigger')).not.toBeInTheDocument()
  })

  it('JOIN_DROP_TEAM: lists vacant teams with active drop + active HRs and writes dropTeamId', async () => {
    const user = userEvent.setup()
    setup({
      teamMode: 'JOIN_DROP_TEAM',
      vacantDropTeams: [
        dropTeam('t1', 'Alpha', true, ['Hanna', 'Hlib']),
        dropTeam('t2', 'Beta', false, []),
      ],
    })
    await user.click(screen.getByTestId('user-dialog-drop-team-trigger'))
    const listbox = await screen.findByRole('listbox')
    const alpha = within(listbox).getByRole('option', { name: /Alpha/ })
    expect(alpha).toHaveTextContent('Dmytro Drop · HR: Hanna, Hlib')
    expect(alpha).not.toHaveTextContent('Left HR')
    const beta = within(listbox).getByRole('option', { name: /Beta/ })
    expect(beta).toHaveTextContent('Дропа не призначено')
    expect(beta).not.toHaveTextContent('HR:')
    await user.click(alpha)
    await waitFor(() => expect(values().dropTeamId).toBe('t1'))
  })

  it('JOIN_DROP_TEAM: dropTeamId required error only after the field is dirtied then emptied', async () => {
    const user = userEvent.setup()
    setup({
      teamMode: 'JOIN_DROP_TEAM',
      vacantDropTeams: [dropTeam('t1', 'Alpha', true, [])],
    })
    // Pristine blur must not raise the error.
    fireEvent.blur(screen.getByTestId('user-dialog-drop-team-trigger'))
    expect(screen.queryByText('Оберіть команду дропа')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('user-dialog-drop-team-trigger'))
    await user.click(await screen.findByRole('option', { name: /Alpha/ }))
    await waitFor(() => expect(values().dropTeamId).toBe('t1'))
  })
})

describe('TeamSection — JUNIOR', () => {
  it('create: lists eligible projects and writes projectId; "none" resets it', async () => {
    const user = userEvent.setup()
    setup({
      role: 'JUNIOR',
      availableJuniorProjects: [project('p1', 'Website', 'Acme'), project('p2', 'App', 'Beta')],
    })
    expect(screen.getByRole('heading', { name: 'Команда' })).toBeInTheDocument()
    expect(screen.getByText('Проєкт')).toBeInTheDocument()
    expect(screen.getByText('Можна прикріпити пізніше в розділі «Проєкти»')).toBeInTheDocument()
    await user.click(screen.getByRole('combobox'))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: 'Acme — Website' })).toBeInTheDocument()
    expect(within(listbox).getByRole('option', { name: 'Beta — App' })).toBeInTheDocument()
    await user.click(within(listbox).getByRole('option', { name: 'Acme — Website' }))
    await waitFor(() => expect(values().projectId).toBe('p1'))
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: '— не обрано —' }))
    await waitFor(() => expect(values().projectId).toBe(''))
  })

  it('create: placeholder shows "— не обрано —" while nothing is chosen', () => {
    setup({ role: 'JUNIOR', availableJuniorProjects: [project('p1', 'Website', 'Acme')] })
    expect(screen.getByRole('combobox')).toHaveTextContent('— не обрано —')
  })

  it('create: no eligible projects shows the empty hint instead of a select', () => {
    setup({ role: 'JUNIOR' })
    expect(screen.getByText('Немає проєктів без активного джуніора')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('create: ignores juniorActiveProjects (edit-only data)', () => {
    setup({
      role: 'JUNIOR',
      juniorActiveProjects: [project('p9', 'Hidden', 'Nope')],
    })
    expect(screen.queryByText('Nope — Hidden')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-junior-projects')).not.toBeInTheDocument()
  })

  it('edit: shows active projects as badges and the manage link, no select', () => {
    setup({
      role: 'JUNIOR',
      isCreate: false,
      availableJuniorProjects: [project('p1', 'Website', 'Acme')],
      juniorActiveProjects: [project('p9', 'Portal', 'Gamma')],
    })
    expect(screen.getByText('Активні проєкти')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-junior-projects')).toHaveTextContent('Gamma — Portal')
    expect(screen.queryByText('Acme — Website')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText('Немає активних проєктів')).not.toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Керувати в розділі «Проєкти» →' })
    expect(link).toHaveAttribute('href', '/projects')
  })

  it('edit: empty active projects shows the empty hint, still offers the link', () => {
    const spies = setup({ role: 'JUNIOR', isCreate: false })
    expect(screen.getByText('Немає активних проєктів')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-junior-projects')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Керувати в розділі «Проєкти» →' }))
    expect(spies.onClose).toHaveBeenCalledTimes(1)
  })
})
