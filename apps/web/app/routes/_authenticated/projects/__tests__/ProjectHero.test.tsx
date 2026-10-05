/**
 * Mikado leaf 11 — characterization of the hero banner extracted from `$projectId.tsx` into
 * `ProjectHero.tsx`. Expected values are hand-written literals (labels, formatted numbers,
 * testids), not derived from the component. Every RBAC-gated element is asserted on BOTH
 * branches of its gate.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDetailDto, Role } from '@crm/shared'
import type { UnarchiveCascadeEntity } from '@/hooks/use-archive'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ProjectHero, type ProjectHeroProps } from '../ProjectHero'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string
    children: React.ReactNode
    className?: string
  }) => (
    <a href={to} className={className} data-testid="back-link">
      {children}
    </a>
  ),
}))
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src: string }) => <img data-testid="logo-img" src={src} alt="" />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="logo-fallback">{children}</span>
  ),
}))
// The unarchive button owns a mutation (covered by ProjectUnarchive.test.tsx); here only the
// hero's wiring of it (gate + `onCascadeRequired` pass-through) is under test.
const ENTITIES = [{ id: 'e1' }] as unknown as UnarchiveCascadeEntity[]
vi.mock('../ProjectUnarchive', () => ({
  ProjectUnarchiveHeaderButton: ({
    projectId,
    projectName,
    onCascadeRequired,
  }: {
    projectId: string
    projectName: string
    onCascadeRequired: (e: UnarchiveCascadeEntity[]) => void
  }) => (
    <button
      data-testid="project-unarchive-button"
      data-project-id={projectId}
      data-project-name={projectName}
      onClick={() => onCascadeRequired(ENTITIES)}
    />
  ),
}))

beforeEach(async () => {
  await loadCatalog('uk')
})

function makeProject(over: Partial<Record<string, unknown>> = {}): ProjectDetailDto {
  return {
    id: 'proj-1',
    name: 'Platform Rewrite',
    companyName: 'Acme Corp',
    domain: 'FinTech',
    status: 'ACTIVE',
    archivedAt: null,
    startDate: '2024-03-15',
    rate: 1500,
    currency: 'USDT',
    logoDocumentId: null,
    logoExternalUrl: null,
    dropId: null,
    seniorId: null,
    seniorName: null,
    dropName: null,
    rejectionReason: null,
    ...over,
  } as unknown as ProjectDetailDto
}

const RATES = { usdUah: '40', usdtUah: '40', eurUah: '44', date: '2024-03-15' }

function setup(
  props: Partial<ProjectHeroProps> = {},
  projectOver: Partial<Record<string, unknown>> = {},
) {
  const handlers = {
    onEdit: vi.fn<() => void>(),
    onArchive: vi.fn<() => void>(),
    onCascadeRequired: vi.fn<(e: UnarchiveCascadeEntity[]) => void>(),
  }
  render(
    <ProjectHero
      project={makeProject(projectOver)}
      viewerId={undefined}
      viewerRole={undefined}
      rates={undefined}
      isAdmin={false}
      canOpenEdit={false}
      {...handlers}
      {...props}
    />,
    { wrapper: I18nTestProvider },
  )
  return handlers
}

describe('ProjectHero — title block', () => {
  it('shows company name as h1, project name beneath, and the domain badge + domain chip', () => {
    setup()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acme Corp')
    expect(screen.getByText('Platform Rewrite')).toBeInTheDocument()
    // domain badge in the title block + domain stat chip
    expect(screen.getAllByText('FinTech')).toHaveLength(2)
    expect(screen.getByText('Домен')).toBeInTheDocument()
  })

  it('back link points to the projects list', () => {
    setup()
    expect(screen.getByTestId('back-link')).toHaveAttribute('href', '/projects')
  })

  it('renders the external logo image when set', () => {
    setup({}, { logoExternalUrl: 'https://img.example/acme.png' })
    expect(screen.getByTestId('logo-img')).toHaveAttribute('src', 'https://img.example/acme.png')
  })

  it('renders only the initials fallback when no logo is set', () => {
    setup()
    expect(screen.queryByTestId('logo-img')).toBeNull()
    expect(screen.getByTestId('logo-fallback')).toHaveTextContent('AC')
  })
})

describe('ProjectHero — status badge', () => {
  it('ACTIVE project reads «Активний»', () => {
    setup()
    expect(screen.getByTestId('project-status-badge')).toHaveTextContent('Активний')
    expect(screen.queryByTestId('project-archived-badge')).toBeNull()
  })

  it('archived project reads «В архіві»', () => {
    setup({}, { archivedAt: '2024-05-01T00:00:00.000Z' })
    expect(screen.getByTestId('project-archived-badge')).toHaveTextContent('В архіві')
  })
})

describe('ProjectHero — approval note gets the viewer id', () => {
  const draft = {
    status: 'DRAFT',
    seniorId: 'sen-1',
    seniorName: 'Oleksiy',
    seniorApprovalPending: false,
    dropId: 'drop-1',
    dropName: 'Nadiya',
    dropApprovalPending: true,
  }

  it('the senior who already acted sees the «waiting for drop» caption', () => {
    setup({ viewerId: 'sen-1' }, draft)
    expect(screen.getByTestId('project-header-approval-caption')).toHaveTextContent(
      'Ви підтвердили. Чекаємо дропа',
    )
  })

  it('another viewer sees the generic pending caption instead', () => {
    setup({ viewerId: 'someone-else' }, draft)
    expect(screen.getByTestId('project-header-approval-caption')).not.toHaveTextContent(
      'Ви підтвердили. Чекаємо дропа',
    )
  })
})

describe('ProjectHero — drop badge (RBAC on viewerRole)', () => {
  it.each<Role>(['ADMIN', 'HR', 'ACCOUNTANT'])('%s sees the badge on a drop-project', (role) => {
    setup({ viewerRole: role }, { dropId: 'drop-1' })
    expect(screen.getByTestId('project-drop-badge')).toHaveTextContent('Проєкт з дропом')
  })

  it.each<Role | undefined>(['SENIOR', 'JUNIOR', undefined])('%s never sees the badge', (role) => {
    setup({ viewerRole: role }, { dropId: 'drop-1' })
    expect(screen.queryByTestId('project-drop-badge')).toBeNull()
  })

  it('ADMIN does not see the badge on a project without a drop', () => {
    setup({ viewerRole: 'ADMIN' }, { dropId: null })
    expect(screen.queryByTestId('project-drop-badge')).toBeNull()
  })
})

describe('ProjectHero — header action buttons', () => {
  it('edit: visible only with canOpenEdit on a live project; click fires onEdit once', async () => {
    const { onEdit } = setup({ canOpenEdit: true })
    await userEvent.click(screen.getByTestId('project-edit-button'))
    expect(screen.getByTestId('project-edit-button')).toHaveTextContent('Редагувати')
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('edit: hidden without canOpenEdit', () => {
    setup({ canOpenEdit: false })
    expect(screen.queryByTestId('project-edit-button')).toBeNull()
  })

  it('edit: hidden on an archived project even with canOpenEdit', () => {
    setup({ canOpenEdit: true }, { archivedAt: '2024-05-01T00:00:00.000Z' })
    expect(screen.queryByTestId('project-edit-button')).toBeNull()
  })

  it('archive: visible to admin on a live project; click fires onArchive once', async () => {
    const { onArchive } = setup({ isAdmin: true })
    await userEvent.click(screen.getByTestId('project-archive-button'))
    expect(screen.getByTestId('project-archive-button')).toHaveTextContent('Архівувати')
    expect(onArchive).toHaveBeenCalledTimes(1)
  })

  it('archive: hidden for non-admin', () => {
    setup({ isAdmin: false })
    expect(screen.queryByTestId('project-archive-button')).toBeNull()
  })

  it('archive: hidden for admin on an archived project', () => {
    setup({ isAdmin: true }, { archivedAt: '2024-05-01T00:00:00.000Z' })
    expect(screen.queryByTestId('project-archive-button')).toBeNull()
  })

  it('unarchive: visible to admin on an archived project, wired with project id/name and the cascade callback', async () => {
    const { onCascadeRequired } = setup(
      { isAdmin: true },
      { archivedAt: '2024-05-01T00:00:00.000Z' },
    )
    const btn = screen.getByTestId('project-unarchive-button')
    expect(btn).toHaveAttribute('data-project-id', 'proj-1')
    expect(btn).toHaveAttribute('data-project-name', 'Platform Rewrite')
    await userEvent.click(btn)
    expect(onCascadeRequired).toHaveBeenCalledTimes(1)
    expect(onCascadeRequired).toHaveBeenCalledWith(ENTITIES)
  })

  it('unarchive: hidden for non-admin on an archived project', () => {
    setup({ isAdmin: false }, { archivedAt: '2024-05-01T00:00:00.000Z' })
    expect(screen.queryByTestId('project-unarchive-button')).toBeNull()
  })

  it('unarchive: hidden for admin on a live project', () => {
    setup({ isAdmin: true })
    expect(screen.queryByTestId('project-unarchive-button')).toBeNull()
  })
})

describe('ProjectHero — stat chips', () => {
  it('rate chip shows label and formatted rate + currency', () => {
    setup()
    expect(screen.getByText('Ставка')).toBeInTheDocument()
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '1\u00a0500 USDT'),
    ).toBeInTheDocument()
  })

  it('rate chip is absent when rate is masked (null)', () => {
    setup({}, { rate: null })
    expect(screen.queryByText('Ставка')).toBeNull()
  })

  it('rate chip is absent when currency is masked (null)', () => {
    setup({}, { currency: null })
    expect(screen.queryByText('Ставка')).toBeNull()
  })

  it('start chip shows the short formatted start date', () => {
    setup()
    expect(screen.getByText('Старт')).toBeInTheDocument()
    expect(screen.getByText('15.03.2024')).toBeInTheDocument()
  })

  it('archived-since chip appears only for an archived project', () => {
    setup({}, { archivedAt: '2024-05-01T00:00:00.000Z' })
    expect(screen.getByText('В архіві з')).toBeInTheDocument()
    expect(screen.getByText('01.05.2024')).toBeInTheDocument()
  })

  it('archived-since chip is absent for a live project', () => {
    setup()
    expect(screen.queryByText('В архіві з')).toBeNull()
  })
})

describe('ProjectHero — USD equivalent line under the rate', () => {
  it('EUR with rates loaded shows the converted amount', () => {
    setup({ rates: RATES }, { currency: 'EUR', rate: 100 })
    // 100 EUR * (44 / 40) = 110 USD
    expect(screen.getByText(/^≈\s*\$110,00$/)).toBeInTheDocument()
  })

  it('UAH with rates loaded shows the converted amount', () => {
    setup({ rates: RATES }, { currency: 'UAH', rate: 4000 })
    // 4000 UAH / 40 = 100 USD
    expect(screen.getByText(/^≈\s*\$100,00$/)).toBeInTheDocument()
  })

  it.each(['USD', 'USDT'])('%s never shows the equivalent line', (currency) => {
    setup({ rates: RATES }, { currency })
    expect(screen.queryByText(/≈/)).toBeNull()
  })

  it('no equivalent line until rates are loaded', () => {
    setup({ rates: undefined }, { currency: 'EUR', rate: 100 })
    expect(screen.queryByText(/≈/)).toBeNull()
  })
})
