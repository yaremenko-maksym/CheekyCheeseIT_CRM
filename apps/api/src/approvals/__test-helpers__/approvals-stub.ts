/**
 * Двойник `ApprovalsService.proposeInTx` для спек, конструирующих
 * сервисы-производители напрямую.
 *
 * QA-H-1 (manual-qa круг 3, #664). До этого круга двойники писались как
 * `vi.fn(async () => [])` или даже `async () => undefined` — возврат никого не
 * интересовал, и двойник врал про базу бесплатно. Теперь производитель берёт
 * из возврата идентификатор ОТКРЫВШЕЙСЯ строки согласования и кладёт его в
 * уведомление, поэтому двойник обязан отвечать тем же, чем отвечает Postgres:
 * по строке на каждого подтверждающего, в том же порядке
 * (`insert(...).values(approverUserIds.map(...)).returning()`).
 *
 * Держится рядом с самим сервисом по той же причине, что и
 * `notifications-stub.ts`: следующая правка поверхности правится в одном
 * месте, а не в десяти спеках.
 */
import { vi } from 'vitest'

export type ProposeInTxStubInput = { approverUserIds: string[] }

/**
 * `idPrefix` — чтобы спека, которой важен КОНКРЕТНЫЙ идентификатор в данных
 * уведомления, могла его назвать, а не угадывать.
 */
export function makeProposeInTxStub(idPrefix = 'approval') {
  return vi.fn(async (_tx: unknown, input: ProposeInTxStubInput) =>
    input.approverUserIds.map((approverUserId, index) => ({
      id: `${idPrefix}-${index + 1}`,
      approverUserId,
    })),
  )
}
