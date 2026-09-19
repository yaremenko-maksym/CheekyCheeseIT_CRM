import { describe, expect, it } from 'vitest'
import { TOS_ACCEPT_IMPERSONATION_MESSAGE } from './tos'

/**
 * Fix-раунд 3 (task-680, SR-M-3). Литерал — SSOT для серверного 403 на
 * `POST /tos/accept` и клиентского пояснения под кнопкой принятия ToS
 * (`AcceptTosStep.tsx`). Мутационный гейт в `packages/shared` видит ТОЛЬКО
 * тесты этого пакета — ассертация в `apps/api`/`apps/web` на тот же
 * импортированный литерал этот мутант не убивает, потому что три пакета
 * гоняются раздельно (`mutation-gate-runbook.md`, «3-package matrix»).
 */
describe('TOS_ACCEPT_IMPERSONATION_MESSAGE', () => {
  it('точный текст — форма как у отказа по подписи контракта; без точки на конце', () => {
    expect(TOS_ACCEPT_IMPERSONATION_MESSAGE).toBe(
      'Пока вы вошли как другой сотрудник, принять условия использования за него нельзя — это должен сделать он сам',
    )
  })
})
