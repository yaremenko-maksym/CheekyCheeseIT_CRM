import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.hoisted(() => vi.fn())
vi.mock('@/lib/axios', () => ({ api: { get } }))

import { fetchProjects, fetchTeam } from '../api'

describe('team-detail api', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('fetchTeam GETs /teams/:id and returns data', async () => {
    const team = { id: 't1', name: 'Alpha' }
    get.mockResolvedValue({ data: team })
    await expect(fetchTeam('t1')).resolves.toBe(team)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/teams/t1')
  })

  it('fetchProjects GETs /projects and returns data', async () => {
    const projects = [{ id: 'p1' }]
    get.mockResolvedValue({ data: projects })
    await expect(fetchProjects()).resolves.toBe(projects)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/projects')
  })
})
