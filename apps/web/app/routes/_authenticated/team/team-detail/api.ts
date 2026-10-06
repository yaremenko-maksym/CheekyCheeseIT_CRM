import type { ProjectDto, TeamDto } from '@crm/shared'
import { api } from '@/lib/axios'

export async function fetchTeam(id: string): Promise<TeamDto> {
  const res = await api.get<TeamDto>(`/teams/${id}`)
  return res.data
}

export async function fetchProjects(): Promise<ProjectDto[]> {
  const res = await api.get<ProjectDto[]>('/projects')
  return res.data
}

export type UserOption = {
  id: string
  displayName: string
  email: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
}
