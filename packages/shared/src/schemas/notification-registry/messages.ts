import type { MessageDescriptor } from '@lingui/core'
import type { NewNotificationType, NotificationSubjectType } from './types'

// ---------------------------------------------------------------------------
// Заголовки — нейтральные, без цифр, пригодные для письма
// ---------------------------------------------------------------------------

/**
 * ЛЕГАСИ. Тип и текст остаются РУССКИМИ для десяти исходных ключей — вне
 * периметра task-i18n-stage4-task6 (SPEC-H-2/SPEC-H-3): шесть производителей
 * (`approvals.service.ts`, `employee-contracts.service.ts`,
 * `transactions.service.ts`, `projects.service.ts`, `teams.service.ts`,
 * `users.service.ts`) пишут этот текст в НЕ читаемую для показа колонку
 * `notifications.title` (см. doc-комментарий над `NOTIFICATION_TITLE_MESSAGES`
 * ниже), плюс `NotificationSettingsTab.tsx` использует его как ярлык ТИПА в
 * списке настроек. Ни один из этих файлов не входит в Task 6 — трогать
 * значения тут для НИХ означало бы менять то, что не читается ни одним путём
 * показа, с риском typecheck вне периметра PR.
 *
 * Три новых ключа (замороженные типы) — компилятор требует их ЗДЕСЬ тоже
 * (`Record` закрыт по `NewNotificationType`): текст УЖЕ украинский (SPEC-H-3
 * fix-раунд 2 — легаси НЕ источник перевода для канона ниже, только
 * историческая точка отсчёта смысла), тот же, что в `NOTIFICATION_TITLE_MESSAGES`,
 * без i18n-обёртки — производители трёх замороженных типов кладут его в
 * `title` НАПРЯМУЮ (Step 5 плана).
 */
export const NOTIFICATION_TITLES: Record<NewNotificationType, string> = {
  // COPY-L-1 (copy-review круг 1, #664): голос группы «вас добавили…» —
  // три из пяти информирующих обращаются к читателю, четвёртый был безличным,
  // хотя адресат по построению — именно получатель денег.
  TRANSACTION_ADDED: 'Вам добавили транзакцию',
  // COPY-M-2: заголовок называл поле («статус изменился»), а не событие.
  // Событие ровно одно — бухгалтер принял или отклонил заявленный доход
  // (`notifyTransactionStatusChanged` вызывается только из `validateTransaction`).
  TRANSACTION_STATUS_CHANGED: 'Решение по доходу',
  TEAM_MEMBER_ADDED: 'Вас добавили в команду',
  PROJECT_MEMBER_ADDED: 'Вас добавили в проект',
  TEAM_NEW_MEMBER: 'В команде новый участник',
  // COPY-H-1: префикс «Ждёт решения: » съедал больше половины 24-символьного
  // бюджета попапа (`w-80`, `truncate`) и обрезался ровно там, где стояло
  // единственное слово, сообщавшее, чего хотят от человека. Предмет — первым,
  // ≤19 знаков, семья узнаётся по общему значку (`TypeIcon`), не по префиксу.
  PROJECT_CONFIRM_REQUIRED: 'Проект ждёт решения',
  // COPY-H-5: «новая доля» утверждала то, чего ещё нет (решение не принято) —
  // и расходилась с экраном самого предложения. COPY-H-1 закрывает вместе.
  SHARE_CONFIRM_REQUIRED: 'Предложение по доле',
  // COPY-M-5: один и тот же документ назывался «документ» / «договор» /
  // «контракт» на пути в один переход — сведено к одному слову.
  DOCUMENT_SIGN_REQUIRED: 'Контракт на подпись',
  // COPY-H-2: «Сотрудник подтвердил/отклонил» — висящий переходный глагол без
  // дополнения (тема письма, куда уходит title, ничего не сообщала) И второе
  // имя одного факта, который #648 уже свёл к «предложению» на пяти
  // поверхностях. Актор остаётся в деталях (`describeNotification`).
  //
  // «Принято», не «подтверждено» — «Предложение подтверждено» (24 знака) не
  // помещается в 202px бюджет строки попапа при непрочитанной точке;
  // «Принято» короче на 5 знаков и уже есть в этом же домене как канонический
  // антоним «отклонено».
  APPROVAL_CONFIRMED: 'Предложение принято',
  APPROVAL_REJECTED: 'Предложение отклонено',
  // task-i18n-stage4-task6, Step 3: три замороженных типа — уже украинский
  // текст, идентичный `NOTIFICATION_TITLE_MESSAGES` ниже (COPY-M-1, #714:
  // «Рахунок на підпис» — легаси-запись обновлена вместе с каноном, это тот
  // же литерал, что producer кладёт напрямую в колонку `title`).
  INVOICE_SIGNED: 'Рахунок підписано',
  INVOICE_SIGN_REQUIRED: 'Рахунок на підпис',
  VACANCY_APPLICATION: 'Новий відгук на вакансію',
}

/**
 * Канон показа — task-i18n-stage4-task6. Все тринадцать записей написаны
 * ЗАНОВО на украинском (по глоссарию `CONTEXT.md`), НЕ скопированы из
 * `NOTIFICATION_TITLES` выше (тот — легаси, справочная точка отсчёта смысла,
 * слова другие, SPEC-H-3). `renderNotification` (ниже) — единственный
 * читающий сайт, который меняется этим PR.
 *
 * `en`-текст — в `packages/shared/src/i18n/locales/en/messages.po`,
 * тем же коммитом (copywriting §5, «два оригинала»).
 */
export const NOTIFICATION_TITLE_MESSAGES: Record<NewNotificationType, MessageDescriptor> = {
  TRANSACTION_ADDED: /* i18n */ {
    id: 'notification.TRANSACTION_ADDED.title',
    message: 'Вам додали транзакцію',
  },
  TRANSACTION_STATUS_CHANGED: /* i18n */ {
    id: 'notification.TRANSACTION_STATUS_CHANGED.title',
    message: 'Рішення щодо доходу',
  },
  TEAM_MEMBER_ADDED: /* i18n */ {
    id: 'notification.TEAM_MEMBER_ADDED.title',
    message: 'Вас додали до команди',
  },
  PROJECT_MEMBER_ADDED: /* i18n */ {
    id: 'notification.PROJECT_MEMBER_ADDED.title',
    message: 'Вас додали до проєкту',
  },
  TEAM_NEW_MEMBER: /* i18n */ {
    id: 'notification.TEAM_NEW_MEMBER.title',
    message: 'У команді новий учасник',
  },
  // COPY-L-2 (copy-review круг 1, #714): «чекає», не «очікує» — навигация
  // (`DRAFT`-статус проекта) уже говорит «Чекають рішення», второй глагол для
  // того же состояния не заводим.
  PROJECT_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.PROJECT_CONFIRM_REQUIRED.title',
    message: 'Проєкт чекає рішення',
  },
  SHARE_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.SHARE_CONFIRM_REQUIRED.title',
    message: 'Пропозиція щодо частки',
  },
  DOCUMENT_SIGN_REQUIRED: /* i18n */ {
    id: 'notification.DOCUMENT_SIGN_REQUIRED.title',
    message: 'Контракт на підпис',
  },
  APPROVAL_CONFIRMED: /* i18n */ {
    id: 'notification.APPROVAL_CONFIRMED.title',
    message: 'Пропозицію прийнято',
  },
  APPROVAL_REJECTED: /* i18n */ {
    id: 'notification.APPROVAL_REJECTED.title',
    message: 'Пропозицію відхилено',
  },
  INVOICE_SIGNED: /* i18n */ {
    id: 'notification.INVOICE_SIGNED.title',
    message: 'Рахунок підписано',
  },
  // COPY-M-1 (copy-review круг 1, #714): «Рахунок очікує підпису» не називала,
  // ЧИЮ саме підпис чекають (легасі мало «ожидает вашей подписи»), а
  // «Рахунок очікує вашого підпису» не поміщається в бюджет попапа (216px >
  // 202). «Рахунок на підпис» — та сама конструкція, що вже є в
  // `DOCUMENT_SIGN_REQUIRED` («Контракт на підпис»), коротше і не втрачає сенсу.
  INVOICE_SIGN_REQUIRED: /* i18n */ {
    id: 'notification.INVOICE_SIGN_REQUIRED.title',
    message: 'Рахунок на підпис',
  },
  VACANCY_APPLICATION: /* i18n */ {
    id: 'notification.VACANCY_APPLICATION.title',
    message: 'Новий відгук на вакансію',
  },
}

/**
 * Сколько текста подробностей человек РЕАЛЬНО видит в попапе.
 *
 * COPY-M-7 (copy-review круг 2) + UX-M-2 (design-review круг 2), #664. Число
 * ИЗМЕРЕНО на живом стенде под русский текст (см. история находки в PR #664).
 *
 * task-i18n-stage4-task6, Step 9: бюджет НЕ пересчитан под украинский (uk
 * длиннее ru/en на 15-30% по аудиту) — эмпирическая проверка требует живого
 * рендера на 320px, которого у этой задачи нет (design-gate Tier 3, отдельный
 * проход по `apps/web`'s попапу). Зафиксировано как допущение/follow-up в PR
 * body, а не тихо занижено — граница деградирует честно: цитата усекается на
 * символ раньше положенного, но не рвёт разметку.
 */
export const NOTIFICATION_DETAIL_LINE_CHARS = 22
export const NOTIFICATION_DETAIL_LINES = 2

/**
 * Реестр «мелких» сообщений реестра — единый Record по той же причине, что
 * `DETAIL_MESSAGES`/`ACTION_LABELS` ниже: `pnpm i18n:extract` (babel-плагин
 * Lingui) реально видит `/* i18n *\/`-помеченный объект только как значение
 * СВОЙСТВА в объектном литерале, а НЕ как инициализатор одиночной
 * `const X = /* i18n *\/ {…} satisfies MessageDescriptor` — проверено
 * эмпирически на этом самом файле (10 таких деклараций не извлеклись, пока
 * их не собрали сюда).
 *
 * Экспортирован (как и все Record-реестры сообщений ниже) по ВТОРОЙ причине:
 * гейт мутаций. `createI18n(locale)` рендерит через СКОМПИЛИРОВАННЫЙ каталог
 * (`pnpm i18n:compile` — прогоняется раньше любого теста, `turbo.json`'s
 * `test` зависит от `//#i18n:compile`), а он ВСЕГДА побеждает inline-фолбэк
 * `{ message }` при совпавшем `id` — проверено эмпирически (`i18n._(id,
 * undefined, { message: 'ЗАВЕДОМО НЕВЕРНЫЙ' })` вернул каталожный текст, не
 * фолбэк). Значит мутация строки `message:` НЕ видна ни одному тесту, что
 * рендерит через `describeNotification`/`renderNotification`/
 * `notificationActions` — путь рендера просто не читает это поле. Экспорт +
 * прямые ассерты `.message`/`.id` в `notification-registry.spec.ts`
 * («реестр сообщений — источник для i18n:extract») читают поле НАПРЯМУЮ,
 * без i18n вообще, поэтому видят ту же мутацию, которую видит Stryker.
 */
export const MISC_MESSAGES = {
  percentText: /* i18n */ {
    id: 'notification.percentText',
    message: '{value, select, null {не задана} other {{value}%}}',
  },
  // COPY-H-3: «базова частка» — тот же принятый термин, что и `CONTEXT.md`
  // («Доля синьора» → «базова частка за замовчуванням»), «базов*» вычищено з
  // `apps/web` на #648, цей реєстр не повинен повернути його знову.
  //
  // SR-L-1 (security-review круг 1, #714): ветвление по ОТДЕЛЬНОМУ признаку
  // `hasName` ('yes'|'no'), а не по значению самого `name` — проект/сущность,
  // названные буквально строкой `"null"` (пользовательский ввод, `objectName`
  // не запрещает это имя), раньше совпадали с ICU-веткой `null` и показывали
  // «без назви» вместо настоящего имени.
  subjectPhrase: /* i18n */ {
    id: 'notification.subjectPhrase',
    message:
      '{kind, select, ' +
      'PROJECT {проєкт {hasName, select, no {без назви} other {{name}}}} ' +
      'PROJECT_SHARE {частка за проєктом {hasName, select, no {без назви} other {{name}}}} ' +
      'other {частка за замовчуванням}}',
  },
  // COPY-M-1: подпись кнопки для «админу» — зависит от вида объекта решения.
  actionApprovalProject: /* i18n */ {
    id: 'notification.action.approval.project',
    message: 'Відкрити проєкт',
  },
  actionApprovalProfile: /* i18n */ {
    id: 'notification.action.approval.profile',
    message: 'Відкрити профіль',
  },
  subjectMissingFallback: /* i18n */ {
    id: 'notification.subjectMissing.fallback',
    message: 'Цього більше немає в CRM',
  },
  // COPY-L-3 (copy-review круг 1, #714): пять типизированных записей
  // (`SUBJECT_ARCHIVED_LABELS` ниже) — конструкция «стан» («Проєкт в архіві»),
  // а заглушка была «дія» («Це прибрано в архів») с вказівним «це» без
  // референта. Приведено до тієї самої конструкції.
  subjectArchivedFallback: /* i18n */ {
    id: 'notification.subjectArchived.fallback',
    message: 'В архіві',
  },
  // ORCH-2 (fix-раунд 6, #664). COPY-M-9 (круг 3): «Решение больше не
  // требуется» / «Решение уже принято» — не «отозвано»: состояние выводится
  // из «живой строки согласования для ЭТОГО подтверждающего больше нет», а
  // туда ведут четыре пути, и два из них — не отзыв.
  approvalSuperseded: /* i18n */ {
    id: 'notification.approvalSuperseded',
    message: 'Рішення більше не потрібне',
  },
  approvalDecided: /* i18n */ {
    id: 'notification.approvalDecided',
    message: 'Рішення вже прийнято',
  },
  open: /* i18n */ {
    id: 'notification.action.open',
    message: 'Відкрити',
  },
  documentSignUnavailable: /* i18n */ {
    id: 'notification.action.documentSignUnavailable',
    message: 'Підпис більше не потрібен',
  },
  // i18n server-text PR4 (S4): the approver's name when the server has none.
  approverUnknown: /* i18n */ {
    id: 'notification.approverUnknown',
    message: 'Невідомо',
  },
} satisfies Record<string, MessageDescriptor>

export const DETAIL_MESSAGES = {
  // SR-L-1: `hasProject` selects the branch — see doc comment on
  // `MISC_MESSAGES.subjectPhrase` for why (a project literally named `"null"`
  // must not collapse into the no-project branch).
  TRANSACTION_ADDED: /* i18n */ {
    id: 'notification.TRANSACTION_ADDED.detail',
    message: '{hasProject, select, no {{money}} other {{money} · проєкт {projectName}}}',
  },
  TRANSACTION_STATUS_CHANGED_VALIDATED: /* i18n */ {
    id: 'notification.TRANSACTION_STATUS_CHANGED.validated',
    message: 'Валідовано: {money}',
  },
  TRANSACTION_STATUS_CHANGED_REJECTED: /* i18n */ {
    id: 'notification.TRANSACTION_STATUS_CHANGED.rejected',
    message: 'Відхилено: {money}',
  },
  TRANSACTION_STATUS_CHANGED_REJECTED_WITH_REASON: /* i18n */ {
    id: 'notification.TRANSACTION_STATUS_CHANGED.rejectedWithReason',
    message: '{quote}\nВідхилено: {money}',
  },
  TEAM_MEMBER_ADDED: /* i18n */ {
    id: 'notification.TEAM_MEMBER_ADDED.detail',
    message: 'Команда {teamName}',
  },
  PROJECT_MEMBER_ADDED: /* i18n */ {
    id: 'notification.PROJECT_MEMBER_ADDED.detail',
    message: 'Проєкт {projectName}',
  },
  TEAM_NEW_MEMBER: /* i18n */ {
    id: 'notification.TEAM_NEW_MEMBER.detail',
    message: '{memberName} · команда {teamName}',
  },
  PROJECT_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.PROJECT_CONFIRM_REQUIRED.detail',
    message: 'Проєкт {projectName}',
  },
  SHARE_CONFIRM_REQUIRED_BASE: /* i18n */ {
    id: 'notification.SHARE_CONFIRM_REQUIRED.base',
    message: 'Частка за замовчуванням: {change}',
  },
  // SR-L-1: same `hasProject` fix as `TRANSACTION_ADDED` above.
  SHARE_CONFIRM_REQUIRED_PROJECT: /* i18n */ {
    id: 'notification.SHARE_CONFIRM_REQUIRED.project',
    message: '{change} · проєкт {hasProject, select, no {без назви} other {{projectName}}}',
  },
  APPROVAL_CONFIRMED: /* i18n */ {
    id: 'notification.APPROVAL_CONFIRMED.detail',
    message: '{approverName} — {subjectPhrase}',
  },
  APPROVAL_REJECTED_NO_REASON: /* i18n */ {
    id: 'notification.APPROVAL_REJECTED.noReason',
    message: '{approverName} — {subjectPhrase}',
  },
  APPROVAL_REJECTED_WITH_REASON: /* i18n */ {
    id: 'notification.APPROVAL_REJECTED.withReason',
    message: '{quote}\n{approverName} — {subjectPhrase}',
  },
  VACANCY_APPLICATION: /* i18n */ {
    id: 'notification.VACANCY_APPLICATION.detail',
    message: 'Вакансія «{vacancyTitle}»',
  },
  // COPY-M-4 (copy-review круг 1, #714): контрагент назван — а деталь не
  // говорила, ЯКИЙ саме рахунок підписано. У контрагента з кількома
  // рахунками це не розрізнити. §10 дозволяє цифри в попапі (не в письмі).
  // COPY-L-4 (copy-review круг 2, #714): сума — перед контрагентом, як у
  // решти реестра (`TRANSACTION_ADDED`: `{money} · проєкт {projectName}`).
  INVOICE_SIGNED: /* i18n */ {
    id: 'notification.INVOICE_SIGNED.detail',
    message: '{money} · {counterpartyName}',
  },
} satisfies Record<string, MessageDescriptor>

/**
 * COPY-M-1 (copy-review круг 1, #664): подпись кнопки — глагол + объект.
 *
 * `APPROVAL_CONFIRMED` / `APPROVAL_REJECTED` сюда НЕ входят: их объект — либо
 * PROJECT, либо USER, подпись обязана называть то, что реально откроется, и
 * решается в `actionLabelFor`.
 */
export const ACTION_LABELS: Record<
  Exclude<NewNotificationType, 'APPROVAL_CONFIRMED' | 'APPROVAL_REJECTED'>,
  MessageDescriptor
> = {
  TRANSACTION_ADDED: /* i18n */ {
    id: 'notification.action.TRANSACTION_ADDED',
    message: 'Відкрити фінанси',
  },
  TRANSACTION_STATUS_CHANGED: /* i18n */ {
    id: 'notification.action.TRANSACTION_STATUS_CHANGED',
    message: 'Відкрити фінанси',
  },
  TEAM_MEMBER_ADDED: /* i18n */ {
    id: 'notification.action.TEAM_MEMBER_ADDED',
    message: 'Відкрити команду',
  },
  PROJECT_MEMBER_ADDED: /* i18n */ {
    id: 'notification.action.PROJECT_MEMBER_ADDED',
    message: 'Відкрити проєкт',
  },
  TEAM_NEW_MEMBER: /* i18n */ {
    id: 'notification.action.TEAM_NEW_MEMBER',
    message: 'Відкрити команду',
  },
  PROJECT_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.action.PROJECT_CONFIRM_REQUIRED',
    message: 'Відкрити проєкт',
  },
  SHARE_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.action.SHARE_CONFIRM_REQUIRED',
    message: 'Відкрити пропозицію',
  },
  DOCUMENT_SIGN_REQUIRED: /* i18n */ {
    id: 'notification.action.DOCUMENT_SIGN_REQUIRED',
    message: 'Підписати контракт',
  },
  INVOICE_SIGNED: /* i18n */ {
    id: 'notification.action.INVOICE_SIGNED',
    message: 'Відкрити рахунок',
  },
  INVOICE_SIGN_REQUIRED: /* i18n */ {
    id: 'notification.action.INVOICE_SIGN_REQUIRED',
    message: 'Підписати рахунок',
  },
  VACANCY_APPLICATION: /* i18n */ {
    id: 'notification.action.VACANCY_APPLICATION',
    message: 'Відкрити вакансію',
  },
}

/**
 * COPY-M-4 (copy-review круг 1, #664): «Объекта больше нет» — слово из спеки,
 * которого нет в интерфейсе CRM. Вид объекта в момент показа уже известен
 * (`n.subjectType`), поэтому честность ничего не теряет от того, чтобы
 * назвать объект конкретно.
 */
export const SUBJECT_MISSING_LABELS: Record<NotificationSubjectType, MessageDescriptor> = {
  PROJECT: /* i18n */ { id: 'notification.subjectMissing.PROJECT', message: 'Проєкт видалено' },
  TEAM: /* i18n */ { id: 'notification.subjectMissing.TEAM', message: 'Команду видалено' },
  USER: /* i18n */ { id: 'notification.subjectMissing.USER', message: 'Профіль видалено' },
  TRANSACTION: /* i18n */ {
    id: 'notification.subjectMissing.TRANSACTION',
    message: 'Транзакцію видалено',
  },
  EMPLOYEE_CONTRACT: /* i18n */ {
    id: 'notification.subjectMissing.EMPLOYEE_CONTRACT',
    message: 'Контракт видалено',
  },
}

/**
 * QA-M-3 / QA-L-2 (manual-qa круг 2, #664): архив — не удаление.
 *
 * Транзакция и контракт сюда не попадают по построению (архива у них нет —
 * см. `loadSubjectStates`), но запись есть у всех пяти видов: `Record` без
 * пропусков — то, что сломает компиляцию на шестом виде объекта.
 */
export const SUBJECT_ARCHIVED_LABELS: Record<NotificationSubjectType, MessageDescriptor> = {
  PROJECT: /* i18n */ { id: 'notification.subjectArchived.PROJECT', message: 'Проєкт в архіві' },
  TEAM: /* i18n */ { id: 'notification.subjectArchived.TEAM', message: 'Команда в архіві' },
  USER: /* i18n */ { id: 'notification.subjectArchived.USER', message: 'Профіль в архіві' },
  TRANSACTION: /* i18n */ {
    id: 'notification.subjectArchived.TRANSACTION',
    message: 'Транзакція в архіві',
  },
  EMPLOYEE_CONTRACT: /* i18n */ {
    id: 'notification.subjectArchived.EMPLOYEE_CONTRACT',
    message: 'Контракт в архіві',
  },
}
