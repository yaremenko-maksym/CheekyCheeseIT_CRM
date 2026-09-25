/**
 * Решения очереди писем — чистыми функциями, отдельно от сервиса и крона.
 *
 * Почему отдельно: гейт мутаций не исполняет ни одной интеграционной спеки
 * (`.claude/rules/common/mutation-gate-integration-specs.md`), а ошибиться
 * здесь дороже всего. «Заводить ли строку» молча теряет единственный канал,
 * доходящий до закрытой вкладки; «слать ли и куда» шлёт письмо не тому
 * человеку — в том числе уволенному, на личную почту. Все функции проверяются
 * юнит-тестом, который гейт видит.
 *
 * **Два момента решения, а не один.** Постановка (`decideEnqueue`) знает
 * только тип события и то, жив ли получатель. Отправка (`decideDelivery`)
 * знает ещё и настройку канала, и адреса — и именно она решает, уйдёт ли
 * письмо. Так требует задание (§5: «Отправщик проверяет настройку в момент
 * отправки, не при постановке в очередь»), и причина не формальная: между
 * событием и отправкой проходит до пятнадцати секунд, а при ретраях — часы.
 * Человек, включивший канал в этом окне, письмо получает; выключивший — не
 * получает. Решение, принятое на постановке, обе эти правки игнорирует
 * молча.
 */
import {
  isActionRequiredNotificationType,
  isEmailChannelLocked,
  isNewNotificationType,
  type NewNotificationType,
} from '@crm/shared'
import type { SubjectResolution } from './notification-subject-resolver'

/** Потолок попыток. Шестой не будет — строка уходит в `FAILED`. */
export const MAX_EMAIL_ATTEMPTS = 5

/**
 * SR-M-1 / CR-M-1 (security-review + code-review круг 1, PR #714). Три
 * замороженных типа (task-i18n-stage4-task6) попали в `NEW_NOTIFICATION_TYPES`
 * этим самым PR — и `isNewNotificationType()` ниже, до этого исключения, молча
 * включала им письма: `INVOICE_SIGN_REQUIRED` контрагенту, `INVOICE_SIGNED`
 * админу, `VACANCY_APPLICATION` каждому ADMIN/HR (последнее — с анонимной
 * публичной формы). Регистрация типа в реестре уведомлений и включение НОВОГО
 * ВНЕШНЕГО канала отправки (письмо на личную почту) — разные решения
 * (`autonomy-levels.md`: внешняя отправка вне A1); тексты писем для этих трёх
 * типов и не прошли copy-review как письма (`notification-email-copy.ts`
 * даёт им только заглушки на украинском, Task 7 их мигрирует).
 *
 * Поведение писем в ЭТОМ PR — ровно как на `origin/main`, где этих трёх типов
 * не существовало: явный список здесь отвязывает «есть письмо» от
 * `isNewNotificationType()`, а не полагается на побочный эффект регистрации.
 */
const NOTIFICATION_TYPES_WITHOUT_EMAIL_TEMPLATE = new Set<NewNotificationType>([
  'INVOICE_SIGNED',
  'INVOICE_SIGN_REQUIRED',
  'VACANCY_APPLICATION',
])

/**
 * «У типа есть шаблон письма» — старый тип (до реестра) тоже не имеет.
 *
 * Типовой предикат (`type is NewNotificationType`), не просто `boolean`:
 * `decideDelivery` ниже сужает `type` этим вызовом и передаёт его дальше в
 * `isEmailChannelLocked(type: NewNotificationType)` — обычный `boolean` не
 * сужал бы тип, и звонок ниже перестал бы компилироваться (тот же узкий
 * контракт, что раньше держал `isNewNotificationType` в одиночку).
 */
function hasEmailTemplate(type: string): type is NewNotificationType {
  return isNewNotificationType(type) && !NOTIFICATION_TYPES_WITHOUT_EMAIL_TEMPLATE.has(type)
}

/**
 * Почему письма не будет. Отличает «не смогли отправить» (`FAILED`) от «не
 * полагалось отправлять» (`SKIPPED` + причина) — без этого различия вопрос
 * «почему сотруднику не пришло письмо про X» не имеет ответа в данных
 * (SPEC-H-1 / CR-H-1 / SR-L-2).
 *
 * Дубль типа `notification_email_skip_reason` из `schema.ts` — намеренный и
 * под тестом: `notification-email-outbox.spec.ts` сверяет этот перечень с
 * `notificationEmailSkipReasonEnum.enumValues`. Иначе пришлось бы тащить
 * drizzle в модуль, который специально не знает про базу.
 *
 * `STALE` (бэклог 208) — согласование или контракт, о котором письмо,
 * перестали быть актуальными между постановкой в очередь и отправкой:
 * предложение отозвали, пересоздали, погасил отказ соседа, либо контракт уже
 * подписан. Отличается от `CHANNEL_OFF` тем, что не про настройку человека, а
 * от `LEGACY_TYPE` — тем, что у типа есть и шаблон, и объект, просто объект
 * больше не ждёт ответа.
 */
export const SKIP_REASONS = [
  'NO_ADDRESS',
  'USER_ARCHIVED',
  'CHANNEL_OFF',
  'LEGACY_TYPE',
  'STALE',
] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

/**
 * Сколько ждать перед следующей попыткой после `attempt`-й неудачи.
 *
 * `min(2^attempts, 60)` минут — задание, §2, дословно: 2/4/8/16/32/60. Две
 * минуты на первой неудаче, а не одна: типовой отказ здесь — `429` или
 * пятисотка провайдера, и повтор через минуту означает пять попыток за пять
 * минут, то есть пять отказов вместо одного. Потолок нужен, чтобы пятая
 * попытка случилась в тот же рабочий день.
 */
export function backoffMs(attempt: number): number {
  const minute = 60_000
  return Math.min(minute * 2 ** attempt, 60 * minute)
}

/** Что делать со строкой очереди в момент записи уведомления. */
export type EnqueueDecision =
  | { status: 'QUEUED' }
  | { status: 'SKIPPED'; skipReason: Extract<SkipReason, 'LEGACY_TYPE' | 'USER_ARCHIVED'> }

/**
 * Заводить ли строку очереди и в каком состоянии.
 *
 * Строка заводится ВСЕГДА — вопрос только в статусе. «Строки нет» не
 * отвечает на вопрос, почему письма не было: ровно за этим ответом заказаны
 * `SKIPPED` и `skip_reason` (§1 задания).
 *
 * Настройку канала эта функция не принимает и принимать не должна — см.
 * заголовок файла.
 */
export function decideEnqueue(type: string, recipientArchived: boolean): EnqueueDecision {
  // Порядок причин: у типа, писем не имеющего ВОВСЕ (легаси-типы до реестра,
  // и — SR-M-1/CR-M-1, PR #714 — три замороженных типа этого PR, у которых
  // ЕСТЬ шаблон текста в попапе, но ещё нет утверждённого шаблона ПИСЬМА, см.
  // `hasEmailTemplate` выше), вопрос «кто получатель» не встаёт. Ни шаблона,
  // ни настройки у него нет, и след «письма этому типу не положены» точнее,
  // чем след про состояние человека.
  if (!hasEmailTemplate(type)) return { status: 'SKIPPED', skipReason: 'LEGACY_TYPE' }
  if (recipientArchived) return { status: 'SKIPPED', skipReason: 'USER_ARCHIVED' }
  return { status: 'QUEUED' }
}

export interface AddressRow {
  email: string
  kind: 'WORK' | 'PERSONAL'
}

/** Всё о получателе, что нужно знать в момент отправки. */
export interface DeliveryContext {
  /** `users.archived_at IS NOT NULL` — то есть человек уволен. */
  archived: boolean
  addresses: readonly AddressRow[]
  /**
   * Запись настройки ЭТОГО типа, если человек её менял; `null` — записи нет.
   *
   * Отсутствие записи означает «письма идут»: умолчание «выключено» означало
   * бы, что подсистема не работает ни для кого, пока каждый не зайдёт в
   * настройки. Три состояния (`true` / `false` / нет записи) не сводятся к
   * двум: «включил сам» и «не трогал» ведут себя одинаково сегодня, но
   * различить их в данных нужно, чтобы смена умолчания не переписала чужой
   * выбор.
   */
  emailEnabled: boolean | null
  /**
   * Состояние объекта письма, вычисленное ТЕМ ЖЕ резолвером, что и попап
   * (`computeSubjectState` / `NotificationSubjectStateService`) — бэклог 208.
   *
   * `undefined` значит «не проверялось»: для информирующих и админских типов
   * (§7.2, «письмо о факте не деградирует») вызывающий (крон) резолвер не
   * зовёт вовсе, и эта функция обязана пропустить их так же, как раньше —
   * письмо о случившемся факте не устаревает оттого, что сам факт потом
   * удалили. Для трёх типов, требующих действия
   * (`isActionRequiredNotificationType`), вызывающий обязан подставить сюда
   * настоящий ответ резолвера; `'active'` — единственное значение, при
   * котором письмо всё ещё уходит.
   */
  subjectState?: SubjectResolution | undefined
}

export type SendDecision = { send: true; to: string } | { send: false; skipReason: SkipReason }

/**
 * Уходит ли письмо и на какой адрес — решение в момент отправки.
 *
 * Порядок причин задан от самой сильной к самой слабой, и каждая ступень
 * закреплена тестом:
 *
 * 1. **архив** — увольнение. `JwtAuthGuard` уже отзывает доступ такому
 *    человеку, а письмо — единственный канал, который до него ДОХОДИТ
 *    (SR-H-1). Перебивает всё: причина «уволен» объясняет непришедшее письмо,
 *    «нет адреса» — нет.
 * 2. **старый тип** — письма нет вовсе (ни шаблона, ни настройки).
 * 3. **устарело** (бэклог 208) — объект, о котором письмо, больше не ждёт
 *    ответа: согласование отозвали/решили, контракт уже подписан. Раньше
 *    настройки канала — письмо о несостоявшемся событии недопустимо
 *    независимо от того, включён ли канал (§7.2).
 * 4. **выключенный канал** — человек так решил (AC6). Отличается от «нет
 *    адреса» тем, что не требует ничьего вмешательства.
 * 5. **нет адреса** — единственная причина, которая означает пробел в данных
 *    и требует действия администратора.
 */
export function decideDelivery(type: string, ctx: DeliveryContext): SendDecision {
  if (ctx.archived) return { send: false, skipReason: 'USER_ARCHIVED' }
  // SR-M-1/CR-M-1 (PR #714): same `hasEmailTemplate` gate as `decideEnqueue` —
  // see its doc comment above `NOTIFICATION_TYPES_WITHOUT_EMAIL_TEMPLATE`.
  if (!hasEmailTemplate(type)) return { send: false, skipReason: 'LEGACY_TYPE' }
  if (isActionRequiredNotificationType(type)) {
    // SR-L-1 (PR #678, круг 2): для action-required типа `subjectState`
    // ОБЯЗАН прийти определённым — единственный вызывающий, умеющий его не
    // передать (крон), уже подставляет его всегда через
    // `isActionRequiredNotificationType` в `deliver()`. `undefined` здесь —
    // не «не проверялось» (как для информирующих типов), а ошибка ВЫЗЫВАЮЩЕГО:
    // fail-loud throw, а не молчаливый `SKIPPED/STALE` — письмо, пропавшее
    // из-за бага, не должно быть неотличимо в данных от письма о
    // несуществующем согласовании (`decideDelivery` не маскирует одно под
    // другое). Крон ловит это исключение и переводит строку в `FAILED` с
    // текстом ошибки в `last_error` (без PII — сообщение называет только тип
    // уведомления).
    if (ctx.subjectState === undefined) {
      throw new Error(
        `decideDelivery: subjectState is required for action-required type "${type}" but was not passed`,
      )
    }
    if (ctx.subjectState !== 'active') {
      return { send: false, skipReason: 'STALE' }
    }
  }
  // Запертый тип игнорирует запись целиком — §3: «письма про подтверждения и
  // подписи отключить нельзя… иначе процесс встаёт молча». Такая запись не
  // проходит разбор запроса, но в базу может попасть мимо API (руками,
  // миграцией, прежней версией), и последний рубеж — здесь.
  if (ctx.emailEnabled === false && !isEmailChannelLocked(type)) {
    return { send: false, skipReason: 'CHANNEL_OFF' }
  }
  const to = pickEmailAddress(ctx.addresses)
  if (to === null) return { send: false, skipReason: 'NO_ADDRESS' }
  return { send: true, to }
}

/**
 * Куда слать: личный адрес, если он есть, иначе рабочий.
 *
 * Личный предпочитается независимо от `verified_at` — спека §5 о личном
 * адресе прямым текстом: «адрес существует, письма на него идут, войти по
 * нему нельзя». Подтверждение открывает ВХОД, а не почту.
 *
 * Цена ошибки в адресе ограничена конструкцией письма: оно не содержит ни
 * сумм, ни процентов, ни имён (§10, `notification-email-copy.ts`), поэтому
 * опечатка раскрывает только сам факт «для вас есть запрос в CRM».
 */
export function pickEmailAddress(rows: readonly AddressRow[]): string | null {
  // Второй проверки вида здесь НЕТ, и это не небрежность.
  //
  // У `user_email_kind` ровно два значения, личное отобрано строкой выше —
  // значит любая оставшаяся строка рабочая, и `kind === 'WORK'` было бы
  // условием, которое не может оказаться ложным. Мутационный гейт это и
  // показал: «всегда истина» на нём неотличима от самой проверки, а подавить
  // ТОЛЬКО эту половину нечем — `disable next-line` глушит и вторую, которую
  // тест как раз ловит.
  //
  // Инвариант «видов ровно два» держится не комментарием: его проверяет
  // `notification-email-outbox.spec.ts` прямо на `userEmailKindEnum`. Добавят
  // третий вид — тест покраснеет здесь, и выбор адреса придётся переписать
  // осознанно, а не обнаружить письмо о деньгах, ушедшее не туда.
  return rows.find((r) => r.kind === 'PERSONAL')?.email ?? rows[0]?.email ?? null
}
