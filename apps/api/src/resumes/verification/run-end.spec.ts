/** Unit spec of the run-ownership read (CD-3) over the recording DB double. */
import { describe, expect, it } from 'vitest'
import { fakeRunDb } from '../../test/fake-run-db'
import { ownsRun } from './run-end'

describe('ownsRun', () => {
  it('reads the row by its id and this run id', async () => {
    const db = fakeRunDb([[{ id: 'r-1' }]])
    await expect(ownsRun(db.service, 'r-1', 'run-1')).resolves.toBe(true)
    expect(db.log).toHaveLength(1)
    expect(db.log[0]?.op).toBe('select')
    expect(db.log[0]?.columns).toEqual(['id'])
    expect(db.log[0]?.where?.params).toEqual(['r-1', 'run-1'])
    expect(db.log[0]?.where?.sql).toContain('"verification_run_id" = $2')
  })

  it('a row gone, swept or owned by another run is no longer owned', async () => {
    await expect(ownsRun(fakeRunDb([[]]).service, 'r-1', 'run-1')).resolves.toBe(false)
  })
})
