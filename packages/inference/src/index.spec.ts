import { describe, expect, it } from 'vitest'
import { INFERENCE_PACKAGE } from './index'
describe('@crm/inference', () => {
  it('builds and exports its name', () => expect(INFERENCE_PACKAGE).toBe('@crm/inference'))
})
