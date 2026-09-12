/**
 * §7.4 «Деградация»: уведомление живёт дольше, чем то, о чём оно. Проект
 * архивировали, документ удалили, согласование погашено через `supersededAt` —
 * кнопка обязана вести к честному «объекта больше нет», а не в белый экран.
 *
 * Здесь — ЧИСТАЯ половина этого правила: какие объекты надо проверить, какие
 * строки согласования прочитать и как из результатов проверок получается
 * ответ «объекта больше нет». Половина с запросами живёт в
 * `NotificationsService.resolveSubjectMissing` — ей нужна база, и она тривиальна
 * ровно потому, что решение принимается здесь.
 *
 * Разделение не косметическое: гейт мутаций гоняет только unit-прогон и не
 * видит интеграционных спек (`.claude/rules/common/mutation-gate-integration-specs.md`),
 * так что правило, спрятанное внутри метода с запросами, осталось бы
 * непроверенным. Здесь оно проверяется без базы вообще.
 */
import type { ApprovalStatus, NotificationSubjectType } from '@crm/shared'

/**
 * Состояние объекта, о котором уведомление.
 *
 * QA-M-3 / QA-L-2 (manual-qa круг 2, #664): раньше здесь был булев ответ
 * «строка есть / строки нет», и архивированный проект попадал в «есть» —
 * кнопка оставалась активной, а джун, чьё членство завершилось каскадом
 * архивации, приезжал на страницу с текстом «Вас ещё не добавили в проект».
 * Ложь про событие, которое БЫЛО. Архив — третий ответ, а не разновидность
 * одного из двух: объект цел, но работа по нему закончена.
 *
 * Отсутствие в карте — «объекта больше нет»; поэтому вариантов здесь два, а
 * состояний у строки три.
 */
export type SubjectState = 'active' | 'archived'

/** Строка уведомления в объёме, достаточном для решения. */
export type SubjectRef = {
  userId: string
  type: string
  subjectType: NotificationSubjectType | null
  subjectId: string | null
  /**
   * QA-H-1 (manual-qa круг 3, #664): идентификатор КОНКРЕТНОЙ строки
   * `approvals`, о которой это уведомление. Берётся из `data.approvalId`
   * (`approvalIdFromData`), кладётся производителем. `null` — строка написана
   * сборкой, которая его ещё не клала (см. `computeSubjectState`).
   */
  approvalId: string | null
}

/**
 * Типы, чья актуальность зависит от живости строки согласования.
 *
 * QA-H-1 (manual-qa круг 3, #664). Здесь стоял `approvalSubjectTypeFor`,
 * который возвращал ВИД согласования (`PROJECT` / `PROJECT_SENIOR_SHARE` /
 * `USER_SENIOR_SHARE`) — он был частью ключа, которым уведомление
 * сопоставлялось со строкой `approvals`. Ключом была тройка «вид + объект +
 * подтверждающий», и в ней не было ничего, что различало бы ПОКОЛЕНИЯ: два
 * предложения по одной и той же доле одному и тому же синьору давали один и
 * тот же ключ. Живой прогон показал цену: предложить 30%, потом 35% — и оба
 * уведомления показываются активными, с разными процентами и двумя рабочими
 * кнопками.
 *
 * Теперь опознаётся СТРОКА (`approvalId` в данных), а не её описание,
 * поэтому виду согласования здесь делать нечего: остался вопрос «этот тип
 * вообще про согласование?», а на него отвечает `boolean`. Заодно исчезла
 * дублирующая карта видов, которую надо было держать в согласии с тремя
 * константами в `ProjectsService` / `UsersService`.
 */
export function awaitsApproval(type: string): boolean {
  return type === 'PROJECT_CONFIRM_REQUIRED' || type === 'SHARE_CONFIRM_REQUIRED'
}

/**
 * Идентификатор строки согласования из данных уведомления (`data.approvalId`).
 *
 * `data` — `jsonb`, то есть `unknown` по определению: форму гарантирует Zod на
 * записи (`notificationDataSchemaFor`), а не чтение. Поэтому здесь разбор, а
 * не приведение типа: строка, чьи данные не той формы, обязана приехать без
 * идентификатора, а не уронить чтение всего списка (AC2 — тот же принцип, что
 * у `renderNotification`).
 */
export function approvalIdFromData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const value = (data as Record<string, unknown>)['approvalId']
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Группирует идентификаторы по виду объекта — по одному запросу на вид. */
export function groupSubjectIds(rows: SubjectRef[]): Map<NotificationSubjectType, string[]> {
  const byType = new Map<NotificationSubjectType, Set<string>>()
  for (const row of rows) {
    if (row.subjectType === null || row.subjectId === null) continue
    const bucket = byType.get(row.subjectType) ?? new Set<string>()
    bucket.add(row.subjectId)
    byType.set(row.subjectType, bucket)
  }
  return new Map([...byType].map(([k, v]) => [k, [...v]]))
}

/**
 * ORCH-2 (fix-раунд 6, #664). Строка `approvals` с `supersededAt IS NULL`
 * (иначе её здесь не было бы — см. запрос в `NotificationsService`)
 * классифицируется в одно из двух: ЖИВАЯ (ещё ждёт ответа) или РЕШЁННАЯ (этот
 * же подтверждающий уже ответил, но генерацию никто не гасил). Разница важна
 * для подписи: живая даёт активную кнопку, решённая — «Решение уже принято»,
 * а всё остальное (нет строки вовсе, либо она погашена, либо `CANCELLED`) —
 * «Решение больше не требуется» (COPY-M-9, круг 3; см. `computeSubjectState`).
 *
 * Разбор ИСЧЕРПЫВАЮЩИЙ, тем же приёмом, что у `computeSubjectState` ниже:
 * `CANCELLED` сегодня всегда приходит С супersededAt (`cancelInTx` ставит оба
 * поля одной записью), то есть под фильтром `isNull(supersededAt)` такая
 * строка уже не должна встретиться, — но это инвариант СЕРВИСА, а не базы (нет
 * CHECK-ограничения), и явная ветка здесь defensively не даёт ему молча стать
 * «живым», если инвариант когда-нибудь нарушат.
 */
export type ApprovalRowClassification = 'live' | 'decided' | 'superseded'

export function classifyApprovalRow(status: ApprovalStatus): ApprovalRowClassification {
  switch (status) {
    case 'PENDING':
      return 'live'
    case 'APPROVED':
    case 'REJECTED':
      return 'decided'
    case 'CANCELLED':
      return 'superseded'
    default: {
      const exhaustive: never = status
      throw new Error(`classifyApprovalRow: неизвестный статус ${String(exhaustive)}`)
    }
  }
}

/**
 * Какие строки согласования надо прочитать для этой пачки уведомлений — по
 * идентификаторам, без повторов (одним запросом на весь список).
 */
export function approvalIdsToCheck(rows: SubjectRef[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!awaitsApproval(row.type)) continue
    if (row.approvalId === null) continue
    seen.add(row.approvalId)
  }
  return [...seen]
}

/**
 * Итог. Пять ответов вместо трёх (ORCH-2, fix-раунд 6, #664, расширяет
 * QA-M-3/QA-L-2):
 *   - `missing` — объект исчез (строки нет среди найденных);
 *   - `archived` — объект цел, но работа по нему закончена (QA-M-3/QA-L-2);
 *   - `approvalDecided` — объект жив, это уведомление про согласование, и
 *     ЭТОТ подтверждающий уже ответил (`classifyApprovalRow` → `decided`), но
 *     генерацию никто не гасил — вопрос закрыт с его стороны;
 *   - `approvalSuperseded` — объект жив, уведомление про согласование, а
 *     живого ответа для этого подтверждающего больше нет: предложение
 *     отозвали, пересоздали, погасил отказ соседа, либо строки не нашлось
 *     вовсе;
 *   - `active` — всё на месте, кнопка ведёт куда обещает.
 *
 * Раньше два последних состояния были одним «missing» — «Проект удалён» на
 * ЖИВОМ проекте, чьё предложение просто отозвали. Та же ложь, которую
 * QA-M-3/QA-L-2 нашёл для архива, только для согласования: подпись обязана
 * описывать то, что произошло, а не одалживать чужой смысл у соседнего
 * состояния.
 *
 * Строка БЕЗ структурного объекта (три старых типа) — не «исчезла»: у неё
 * никогда и не было объекта, её кнопка идёт по сохранённой ссылке.
 *
 * Порядок проверок содержателен, а не случаен: состояние ОБЪЕКТА решает
 * раньше живости согласования. Подпись выводится из вида объекта («Проект в
 * архиве»), и сказать про архивный проект «Проект удалён» (или «Предложение
 * отозвано») только потому, что предложение по нему погашено, — ровно та
 * ложь, ради которой заведена находка.
 */
export type SubjectResolution = SubjectState | 'missing' | 'approvalSuperseded' | 'approvalDecided'

export function computeSubjectState(
  row: SubjectRef,
  statesByType: Map<NotificationSubjectType, Map<string, SubjectState>>,
  liveApprovalIds: Set<string>,
  decidedApprovalIds: Set<string>,
): SubjectResolution {
  if (row.subjectType === null || row.subjectId === null) return 'active'
  const state = statesByType.get(row.subjectType)?.get(row.subjectId)
  if (state === undefined) return 'missing'
  // Разбор ИСЧЕРПЫВАЮЩИЙ, а не парой сравнений, и это не украшение: состояние
  // собирается вручную из колонки `archived_at` (`loadSubjectStates`), и
  // значение, которого мы не ждём, обязано ронять разбор, а не превращаться
  // молча в «живой» — молча это активная кнопка на объекте, про который
  // ничего не известно. Тот же приём, что у `describeNotification` (CR-M-1).
  // Гейт мутаций круга 5: при паре сравнений один из двух литералов всегда
  // оставался непроверенным — какой именно, зависело от того, с каким из них
  // сравнивают.
  switch (state) {
    case 'archived':
      return 'archived'
    case 'active':
      break
    default: {
      const exhaustive: never = state
      throw new Error(`computeSubjectState: неизвестное состояние ${String(exhaustive)}`)
    }
  }
  if (!awaitsApproval(row.type)) return 'active'
  // QA-H-1: уведомление без идентификатора строки согласования опознать
  // нечем — и сказать про него «решение больше не требуется» значило бы
  // утверждать факт, которого мы не знаем. Кнопка остаётся: она ведёт на
  // страницу объекта, где настоящее состояние предложения и показано. Такую
  // строку может написать только сборка до этого круга — оба производителя
  // кладут идентификатор, и форма данных (`notificationDataSchemaFor`) его
  // требует.
  if (row.approvalId === null) return 'active'
  if (liveApprovalIds.has(row.approvalId)) return 'active'
  // ORCH-2: «решено» проверяется ОТДЕЛЬНО от «нет живой строки вовсе» — тот
  // же приём, что различил архив и удаление. Ответившему подтверждающему
  // говорят, что он уже ответил, а не что предложение отозвали у него из-под
  // рук.
  if (decidedApprovalIds.has(row.approvalId)) return 'approvalDecided'
  return 'approvalSuperseded'
}
