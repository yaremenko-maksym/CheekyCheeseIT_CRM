/**
 * Mikado leaf 3 ($projectId.tsx decomposition) — characterization of the three
 * team/drop components moved into `ProjectTeamCards.tsx`.
 *
 * These pin the CURRENT behaviour (visible text, RBAC masking of the effective
 * team, testids, role badges, drop-share arithmetic). The move changed nothing;
 * these tests exist so the mutation gate — which runs the unit suite only, not
 * Playwright — can see the strings and branches of a file it now treats as new.
 * Expected values are literals computed by hand, not re-derived by the code.
 */
/*
 * Node access is needed in exactly two places: the dimmed-row class (`opacity-50`,
 * no testid/role on that wrapper — adding one would change the component) and the
 * Tooltip trigger wrapper of a disabled button (a disabled button gets no hover events).
 */
/* eslint-disable testing-library/no-container, testing-library/no-node-access */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDetailDto, ProjectMemberDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ROLE_VARIANT } from '../constants'
import { MemberRow, ProjectDropDistribution, ProjectEffectiveTeamCard } from '../ProjectTeamCards'

// Radix <AvatarImage> only mounts its <img> after a successful load, which jsdom never
// performs — stub it so "an image is rendered iff avatarUrl is set" is observable.
vi.mock('@/components/ui/avatar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/avatar')>()),
  AvatarImage: ({ src, alt }: { src: string; alt: string }) => (
    <img data-testid="avatar-img" src={src} alt={alt} />
  ),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string
    params: { userId: string }
    children: ReactNode
  }) => (
    <a href={to.replace('$userId', params.userId)} {...rest}>
      {children}
    </a>
  ),
}))

beforeEach(async () => {
  await loadCatalog('uk')
})

function wrap(ui: ReactNode) {
  return render(
    <I18nTestProvider>
      <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
    </I18nTestProvider>,
  )
}

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function project(overrides: Record<string, unknown> = {}): ProjectDetailDto {
  return {
    id: ID(100),
    dropId: null,
    members: [],
    ...overrides,
  } as unknown as ProjectDetailDto
}

// ── ProjectDropDistribution ──────────────────────────────────────────────────

describe('ProjectDropDistribution', () => {
  it('renders the $1000 formula: override senior % and effective drop %', () => {
    // senior 12.5% -> $125, drop 3% -> $30, remainder $845 split 50/50 -> $422.5
    wrap(
      <ProjectDropDistribution
        project={project({
          seniorSharePercentOverride: 12.5,
          seniorSharePercentDefault: 40,
          effectiveDropSharePercent: 3,
          dropSharePercent: 9,
        })}
      />,
    )
    const card = screen.getByTestId('project-drop-distribution')
    expect(card).toHaveTextContent('Розподіл доходу (приклад $1,000)')
    expect(card).toHaveTextContent('Частка сеньйора (12.5%)')
    expect(card).toHaveTextContent('Частка дропа (3%)')
    expect(card).toHaveTextContent('Партнерам (50 / 50)')
    expect(screen.getByTestId('dist-senior-share')).toHaveTextContent('$125')
    expect(screen.getByTestId('dist-drop-share')).toHaveTextContent('$30')
    expect(screen.getByTestId('dist-partner-share')).toHaveTextContent('$422.5 / $422.5')
  })

  it('falls back: senior override -> senior default; effective drop -> snapshot drop %', () => {
    wrap(
      <ProjectDropDistribution
        project={project({ seniorSharePercentDefault: 30, dropSharePercent: 10 })}
      />,
    )
    // 30% -> $300, 10% -> $100, remainder $600 -> $300 each
    expect(screen.getByTestId('dist-senior-share')).toHaveTextContent('$300')
    expect(screen.getByTestId('dist-drop-share')).toHaveTextContent('$100')
    expect(screen.getByTestId('dist-partner-share')).toHaveTextContent('$300 / $300')
  })

  it('falls back to the canonical 26% senior / 5% drop when the DTO carries neither', () => {
    wrap(<ProjectDropDistribution project={project()} />)
    expect(screen.getByTestId('dist-senior-share')).toHaveTextContent('$260')
    expect(screen.getByTestId('dist-drop-share')).toHaveTextContent('$50')
    expect(screen.getByTestId('dist-partner-share')).toHaveTextContent('$345 / $345')
  })

  it('amounts are rounded to at most two decimals', () => {
    // senior 12.3456% -> 123.456 -> $123.46; remainder 876.544 / 2 = 438.272 -> $438.27
    wrap(
      <ProjectDropDistribution
        project={project({ seniorSharePercentOverride: 12.3456, effectiveDropSharePercent: 0 })}
      />,
    )
    expect(screen.getByTestId('dist-senior-share').textContent).toBe('$123.46')
    expect(screen.getByTestId('dist-partner-share').textContent).toBe('$438.27 / $438.27')
  })

  it('an explicit 0% override is honoured (not treated as missing)', () => {
    wrap(
      <ProjectDropDistribution
        project={project({ seniorSharePercentOverride: 0, effectiveDropSharePercent: 0 })}
      />,
    )
    expect(screen.getByTestId('dist-senior-share')).toHaveTextContent('$0')
    expect(screen.getByTestId('dist-drop-share')).toHaveTextContent('$0')
    expect(screen.getByTestId('dist-partner-share')).toHaveTextContent('$500 / $500')
  })
})

// ── MemberRow ────────────────────────────────────────────────────────────────

function member(overrides: Partial<ProjectMemberDto> = {}): ProjectMemberDto {
  return {
    id: ID(1),
    userId: ID(2),
    displayName: 'Ivan Petrenko',
    email: 'ivan@example.com',
    avatarUrl: null,
    avatarDocumentId: null,
    role: 'JUNIOR',
    joinedAt: '2026-01-01T00:00:00.000Z',
    leftAt: null,
    ...overrides,
  }
}

describe('ROLE_VARIANT', () => {
  it('maps the five badge roles to their variants (DROP is intentionally absent)', () => {
    expect(ROLE_VARIANT).toEqual({
      ADMIN: 'admin',
      SENIOR: 'senior',
      JUNIOR: 'junior',
      HR: 'hr',
      ACCOUNTANT: 'accountant',
    })
  })
})

describe('MemberRow', () => {
  it('active member: profile link, name, initials fallback, role label + variant', () => {
    wrap(<MemberRow member={member({ role: 'SENIOR' })} canManage={false} onRemove={() => {}} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', `/profile/${ID(2)}`)
    expect(link).toHaveTextContent('Ivan Petrenko')
    expect(link).toHaveTextContent('IP')
    const badge = screen.getByText('Сеньйор')
    expect(badge).toHaveClass('text-blue-400')
    expect(screen.queryByText(/дата виходу/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    ['ADMIN', 'Адміністратор', 'text-yellow-400'],
    ['HR', 'HR', 'text-purple-400'],
    ['ACCOUNTANT', 'Бухгалтер', 'text-orange-400'],
    ['JUNIOR', 'Джуніор', 'text-green-400'],
    ['DROP', 'Дроп', 'text-green-400'], // no ROLE_VARIANT entry -> junior
  ] as const)('role %s -> label and badge colour', (role, label, cls) => {
    wrap(<MemberRow member={member({ role })} canManage={false} onRemove={() => {}} />)
    expect(screen.getByText(label)).toHaveClass(cls)
  })

  it('renders the avatar image (src + alt) only when avatarUrl is set', () => {
    const { unmount } = wrap(
      <MemberRow
        member={member({ avatarUrl: 'https://example.com/a.png' })}
        canManage={false}
        onRemove={() => {}}
      />,
    )
    const img = screen.getByTestId('avatar-img')
    expect(img).toHaveAttribute('src', 'https://example.com/a.png')
    expect(img).toHaveAttribute('alt', 'Ivan Petrenko')
    unmount()
    wrap(<MemberRow member={member()} canManage={false} onRemove={() => {}} />)
    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument()
  })

  it('row layout classes and the exit date text are pinned', () => {
    wrap(
      <MemberRow
        member={member({ leftAt: '2026-03-15T00:00:00.000Z' })}
        canManage={false}
        onRemove={() => {}}
      />,
    )
    const row = screen.getByRole('link').parentElement!
    expect(row).toHaveClass('flex', 'items-center', 'gap-2', 'opacity-50')
    expect(screen.getByText(/дата виходу/).textContent).toBe('дата виходу: 15.03.2026')
  })

  it('left member: dimmed, shows exit date, no remove button even for managers', () => {
    const { container } = wrap(
      <MemberRow
        member={member({ leftAt: '2026-03-15T00:00:00.000Z' })}
        canManage
        onRemove={() => {}}
      />,
    )
    expect(screen.getByText(/дата виходу:/)).toHaveTextContent(/15/)
    expect(container.querySelector('.opacity-50')).not.toBeNull()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('exit date is formatted as a UTC calendar date (short style pins timeZone: UTC)', () => {
    // Not a TZ-env trick (unreliable across runners): observe the options handed to Intl.
    const Original = Intl.DateTimeFormat
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      return new Original(locales, options)
    } as unknown as typeof Intl.DateTimeFormat)
    try {
      wrap(
        <MemberRow
          member={member({ leftAt: '2026-03-15T23:30:00.000Z' })}
          canManage={false}
          onRemove={() => {}}
        />,
      )
      expect(screen.getByText(/дата виходу/).textContent).toBe('дата виходу: 15.03.2026')
      const options = spy.mock.calls.map((call) => call[1])
      expect(options).toContainEqual({ timeZone: 'UTC' })
    } finally {
      spy.mockRestore()
    }
  })

  it('active member is not dimmed', () => {
    const { container } = wrap(
      <MemberRow member={member()} canManage={false} onRemove={() => {}} />,
    )
    expect(container.querySelector('.opacity-50')).toBeNull()
  })

  it('manager sees the remove button and it fires onRemove', async () => {
    const onRemove = vi.fn()
    wrap(<MemberRow member={member()} canManage onRemove={onRemove} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})

// ── ProjectEffectiveTeamCard ─────────────────────────────────────────────────

const SENIOR = {
  id: ID(10),
  displayName: 'Senior Sidorenko',
  email: 's@example.com',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'SENIOR' as const,
  profileNavigable: true,
}
const DROP = {
  id: ID(11),
  displayName: 'Drop Dropenko',
  email: 'd@example.com',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'DROP' as const,
  dropSharePercent: 5,
}
const HR = {
  id: ID(12),
  userId: ID(22),
  displayName: 'Hanna Rudenko',
  email: 'h@example.com',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'HR' as const,
}
const ACC = {
  id: ID(13),
  userId: ID(23),
  displayName: 'Alla Corn',
  email: 'a@example.com',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'ACCOUNTANT' as const,
}
const JUN = member({ id: ID(14), userId: ID(24), displayName: 'Julia Nowak', role: 'JUNIOR' })

function fullProject(overrides: Record<string, unknown> = {}) {
  return project({
    effectiveTeam: { senior: SENIOR, drop: DROP, hrs: [HR], accountants: [ACC], juniors: [JUN] },
    ...overrides,
  })
}

describe('ProjectEffectiveTeamCard', () => {
  it('ADMIN view: heading, flat list in senior/drop/hr/accountant/junior order with links + badges', () => {
    wrap(<ProjectEffectiveTeamCard project={fullProject({ dropId: ID(11) })} viewerRole="ADMIN" />)
    const card = screen.getByTestId('effective-team-card')
    expect(card).toHaveTextContent('Ефективний склад')
    expect(card).toHaveTextContent('(HR/бухгалтер — з поточної команди сеньйора)')

    const rows = [
      screen.getByTestId('effective-team-senior'),
      screen.getByTestId('effective-team-drop'),
      screen.getByTestId('effective-team-hrs'),
      screen.getByTestId('effective-team-accountants'),
      screen.getByTestId('effective-team-juniors'),
    ]
    const order = within(card)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
    expect(order).toEqual([
      `/profile/${ID(10)}`,
      `/profile/${ID(11)}`,
      `/profile/${ID(22)}`,
      `/profile/${ID(23)}`,
      `/profile/${ID(24)}`,
    ])
    expect(rows[0]).toHaveTextContent('Senior Sidorenko')
    expect(within(rows[0]!).getByText('Сеньйор')).toHaveClass('text-blue-400')
    expect(rows[1]).toHaveTextContent('Drop Dropenko')
    expect(within(rows[1]!).getByText('Дроп')).toHaveClass('text-blue-400', 'bg-blue-500/10')
    // 'HR' is both the avatar initials and the badge label — the badge is the last match.
    expect(within(rows[2]!).getAllByText('HR').at(-1)).toHaveClass('text-purple-400')
    expect(within(rows[3]!).getByText('Бухгалтер')).toHaveClass('text-orange-400')
    expect(within(rows[4]!).getByText('Джуніор')).toHaveClass('text-green-400')
    // Navigable rows show the hover underline on the name.
    expect(screen.getByText('Senior Sidorenko')).toHaveClass('hover:underline', 'text-primary')
    expect(screen.queryByTestId('effective-team-juniors-empty')).not.toBeInTheDocument()
  })

  it('SENIOR viewer: drop and juniors are masked out', () => {
    wrap(<ProjectEffectiveTeamCard project={fullProject()} viewerRole="SENIOR" />)
    expect(screen.queryByTestId('effective-team-drop')).not.toBeInTheDocument()
    expect(screen.queryByText('Drop Dropenko')).not.toBeInTheDocument()
    expect(screen.queryByText('Julia Nowak')).not.toBeInTheDocument()
    expect(screen.getByText('Senior Sidorenko')).toBeInTheDocument()
    expect(screen.getByText('Hanna Rudenko')).toBeInTheDocument()
    expect(screen.getByText('Alla Corn')).toBeInTheDocument()
    // Senior present but no (visible) juniors -> amber hint.
    expect(screen.getByTestId('effective-team-juniors-empty')).toHaveTextContent(
      'Джуніор не призначений',
    )
  })

  it('JUNIOR viewer: drop masked but juniors stay visible', () => {
    wrap(<ProjectEffectiveTeamCard project={fullProject()} viewerRole="JUNIOR" />)
    expect(screen.queryByText('Drop Dropenko')).not.toBeInTheDocument()
    expect(screen.getByText('Julia Nowak')).toBeInTheDocument()
  })

  it('DROP viewer: rows are plain non-navigable divs (no profile links)', () => {
    wrap(<ProjectEffectiveTeamCard project={fullProject()} viewerRole="DROP" />)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    const senior = screen.getByTestId('effective-team-senior')
    expect(senior.tagName).toBe('DIV')
    expect(screen.getByText('Senior Sidorenko')).toHaveClass('text-primary')
    expect(screen.getByText('Senior Sidorenko')).not.toHaveClass('hover:underline')
  })

  it('admin-senior with profileNavigable=false renders a non-navigable row', () => {
    wrap(
      <ProjectEffectiveTeamCard
        project={project({
          effectiveTeam: {
            senior: { ...SENIOR, profileNavigable: false },
            hrs: [],
            accountants: [],
            juniors: [JUN],
          },
        })}
        viewerRole="ADMIN"
      />,
    )
    expect(screen.getByTestId('effective-team-senior').tagName).toBe('DIV')
    expect(screen.getByTestId('effective-team-juniors').tagName).toBe('A')
  })

  it('no senior: shows the placeholder, no juniors-empty hint', () => {
    wrap(
      <ProjectEffectiveTeamCard
        project={project({
          effectiveTeam: { senior: null, hrs: [], accountants: [], juniors: [] },
        })}
        viewerRole="ADMIN"
      />,
    )
    expect(screen.getByTestId('effective-team-senior')).toHaveTextContent('Сеньйор не призначений')
    expect(screen.queryByTestId('effective-team-juniors-empty')).not.toBeInTheDocument()
  })

  it('falls back to active JUNIOR members of project.members when effectiveTeam is absent', () => {
    wrap(
      <ProjectEffectiveTeamCard
        project={project({
          members: [
            member({ id: ID(31), userId: ID(41), displayName: 'Active Junior', role: 'JUNIOR' }),
            member({
              id: ID(32),
              userId: ID(42),
              displayName: 'Left Junior',
              role: 'JUNIOR',
              leftAt: '2026-02-01T00:00:00.000Z',
            }),
            member({ id: ID(33), userId: ID(43), displayName: 'A Senior', role: 'SENIOR' }),
          ],
        })}
        viewerRole="ADMIN"
      />,
    )
    expect(screen.getByText('Active Junior')).toBeInTheDocument()
    expect(screen.queryByText('Left Junior')).not.toBeInTheDocument()
    expect(screen.queryByText('A Senior')).not.toBeInTheDocument()
    // no HR / accountant rows on the fallback path
    expect(screen.queryByTestId('effective-team-hrs')).not.toBeInTheDocument()
    expect(screen.queryByTestId('effective-team-accountants')).not.toBeInTheDocument()
    // senior is null on the fallback path
    expect(screen.getByTestId('effective-team-senior')).toHaveTextContent('Сеньйор не призначений')
  })

  it('renders the avatar fallback initials per row', () => {
    wrap(<ProjectEffectiveTeamCard project={fullProject()} viewerRole="ADMIN" />)
    expect(screen.getByText('SS')).toBeInTheDocument()
    expect(screen.getByText('DD')).toBeInTheDocument()
  })

  it('a senior without an explicit profileNavigable flag is navigable (default true)', () => {
    const { profileNavigable: _omit, ...bare } = SENIOR
    wrap(
      <ProjectEffectiveTeamCard
        project={project({
          effectiveTeam: { senior: bare, hrs: [], accountants: [], juniors: [] },
        })}
        viewerRole="ADMIN"
      />,
    )
    expect(screen.getByTestId('effective-team-senior').tagName).toBe('A')
  })

  it('avatar image is rendered per row only when that person has an avatarUrl', () => {
    wrap(
      <ProjectEffectiveTeamCard
        project={project({
          effectiveTeam: {
            senior: { ...SENIOR, avatarUrl: 'https://example.com/s.png' },
            hrs: [HR],
            accountants: [],
            juniors: [],
          },
        })}
        viewerRole="ADMIN"
      />,
    )
    const imgs = screen.getAllByTestId('avatar-img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]).toHaveAttribute('src', 'https://example.com/s.png')
    expect(imgs[0]).toHaveAttribute('alt', 'Senior Sidorenko')
  })

  // React keys are invisible in the DOM; node identity across a re-render that changes
  // the person is how a wrong/empty key shows up (same key -> node reused, new key -> remount).
  it.each([
    ['senior', 'effective-team-senior'],
    ['drop', 'effective-team-drop'],
    ['hr', 'effective-team-hrs'],
    ['accountant', 'effective-team-accountants'],
    ['junior', 'effective-team-juniors'],
  ] as const)(
    'row key is tied to the %s identity (changing person remounts the row)',
    (kind, testId) => {
      const team = (suffix: number) => ({
        senior: { ...SENIOR, id: ID(1000 + (kind === 'senior' ? suffix : 0)) },
        drop: { ...DROP, id: ID(2000 + (kind === 'drop' ? suffix : 0)) },
        hrs: [{ ...HR, id: ID(3000 + (kind === 'hr' ? suffix : 0)) }],
        accountants: [{ ...ACC, id: ID(4000 + (kind === 'accountant' ? suffix : 0)) }],
        juniors: [{ ...JUN, id: ID(5000 + (kind === 'junior' ? suffix : 0)) }],
      })
      const ui = (suffix: number) => (
        <I18nTestProvider>
          <TooltipProvider>
            <ProjectEffectiveTeamCard
              project={project({ effectiveTeam: team(suffix) })}
              viewerRole="ADMIN"
            />
          </TooltipProvider>
        </I18nTestProvider>
      )
      const { rerender } = render(ui(1))
      const before = screen.getByTestId(testId)
      rerender(ui(2))
      expect(screen.getByTestId(testId)).not.toBe(before)
    },
  )

  describe('attach / detach drop controls', () => {
    it('attach button: shown only with canManageDrop and no dropId; enabled with candidates; fires', async () => {
      const onAttachDrop = vi.fn()
      wrap(
        <ProjectEffectiveTeamCard
          project={project({
            effectiveTeam: { senior: SENIOR, hrs: [], accountants: [], juniors: [] },
          })}
          viewerRole="ADMIN"
          canManageDrop
          dropCandidates={[{ id: ID(50), displayName: 'Cand' }]}
          onAttachDrop={onAttachDrop}
        />,
      )
      const btn = screen.getByTestId('attach-drop-btn')
      expect(btn).toHaveTextContent('Прив’язати дропа')
      expect(btn).toBeEnabled()
      await userEvent.click(btn)
      expect(onAttachDrop).toHaveBeenCalledTimes(1)
    })

    it('attach button is disabled with a tooltip hint when there are no candidates', async () => {
      wrap(
        <ProjectEffectiveTeamCard
          project={project({
            effectiveTeam: { senior: SENIOR, hrs: [], accountants: [], juniors: [] },
          })}
          viewerRole="ADMIN"
          canManageDrop
        />,
      )
      const btn = screen.getByTestId('attach-drop-btn')
      expect(btn).toBeDisabled()
      await userEvent.hover(btn.parentElement!)
      expect(await screen.findAllByText('Немає доступних дропів')).not.toHaveLength(0)
    })

    it('no «no drops» hint when candidates exist', async () => {
      wrap(
        <ProjectEffectiveTeamCard
          project={project({
            effectiveTeam: { senior: SENIOR, hrs: [], accountants: [], juniors: [] },
          })}
          viewerRole="ADMIN"
          canManageDrop
          dropCandidates={[{ id: ID(50), displayName: 'Cand' }]}
        />,
      )
      await userEvent.hover(screen.getByTestId('attach-drop-btn'))
      await new Promise((r) => setTimeout(r, 100))
      expect(screen.queryByText('Немає доступних дропів')).not.toBeInTheDocument()
    })

    it('no attach button without canManageDrop, nor when a drop is already attached', () => {
      const { unmount } = wrap(
        <ProjectEffectiveTeamCard project={fullProject()} viewerRole="ADMIN" />,
      )
      expect(screen.queryByTestId('attach-drop-btn')).not.toBeInTheDocument()
      unmount()
      wrap(
        <ProjectEffectiveTeamCard
          project={fullProject({ dropId: ID(11) })}
          viewerRole="ADMIN"
          canManageDrop
        />,
      )
      expect(screen.queryByTestId('attach-drop-btn')).not.toBeInTheDocument()
    })

    it('detach button on the DROP row: labelled, fires onDetachDrop without navigating', async () => {
      const onDetachDrop = vi.fn()
      wrap(
        <ProjectEffectiveTeamCard
          project={fullProject({ dropId: ID(11) })}
          viewerRole="ADMIN"
          canManageDrop
          onDetachDrop={onDetachDrop}
        />,
      )
      const btn = screen.getByTestId('detach-drop-btn')
      expect(btn).toHaveAccessibleName('Відв’язати дропа від проєкту')
      await userEvent.click(btn)
      expect(onDetachDrop).toHaveBeenCalledTimes(1)
      expect(screen.getAllByTestId('detach-drop-btn')).toHaveLength(1)
    })

    it('detach click without an onDetachDrop handler is a safe no-op', async () => {
      const onError = vi.fn()
      window.addEventListener('error', onError)
      wrap(
        <ProjectEffectiveTeamCard
          project={fullProject({ dropId: ID(11) })}
          viewerRole="ADMIN"
          canManageDrop
        />,
      )
      await userEvent.click(screen.getByTestId('detach-drop-btn'))
      window.removeEventListener('error', onError)
      expect(onError).not.toHaveBeenCalled()
    })

    it('no detach button without canManageDrop', () => {
      wrap(
        <ProjectEffectiveTeamCard project={fullProject({ dropId: ID(11) })} viewerRole="ADMIN" />,
      )
      expect(screen.queryByTestId('detach-drop-btn')).not.toBeInTheDocument()
    })
  })
})
