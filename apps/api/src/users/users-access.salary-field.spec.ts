/**
 * PR #1521 (ACCOUNTANT removed): the `salary` field is shown only for the two
 * salary roles, JUNIOR and HR — to ADMIN viewing them, and to the person
 * viewing themself. A SENIOR, DROP, ADMIN or unknown-role target never shows it.
 */
import { describe, expect, it } from 'vitest'
import { UsersAccessService } from './users-access.service'
import type { User } from '../database/schema'

const user = (id: string, role: string) => ({ id, role }) as unknown as User

const service = new UsersAccessService({ db: {} } as never)
const admin = user('admin-1', 'ADMIN')

describe('UsersAccessService.getViewPermissions — salary field', () => {
  it.each(['JUNIOR', 'HR'])('ADMIN viewing a %s sees salary', async (role) => {
    const p = await service.getViewPermissions(admin, user('target-1', role))
    expect(p.fields.salary).toBe(true)
  })

  it.each(['SENIOR', 'DROP', 'ADMIN', 'ACCOUNTANT', 'GUEST'])(
    'ADMIN viewing a %s does not see salary',
    async (role) => {
      const p = await service.getViewPermissions(admin, user('target-1', role))
      expect(p.fields.salary).toBe(false)
    },
  )

  it.each(['JUNIOR', 'HR'])('%s viewing self sees salary', async (role) => {
    const self = user('self-1', role)
    const p = await service.getViewPermissions(self, self)
    expect(p.fields.salary).toBe(true)
  })

  it.each(['SENIOR', 'DROP'])('%s viewing self does not see salary', async (role) => {
    const self = user('self-1', role)
    const p = await service.getViewPermissions(self, self)
    expect(p.fields.salary).toBe(false)
  })
})
