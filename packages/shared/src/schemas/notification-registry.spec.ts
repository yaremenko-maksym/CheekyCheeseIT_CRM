import { describe, expect, it } from 'vitest'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  NOTIFICATION_DETAIL_LINES,
  NOTIFICATION_DETAIL_LINE_CHARS,
  NOTIFICATION_TITLES,
  NOTIFICATION_TITLE_MESSAGES,
  describeNotification,
  notificationActions,
  notificationDataSchemaFor,
  notificationSubjectTypeSchema,
  notificationTextPreview,
  renderNotification,
  type NotificationSubjectType,
} from './notification-registry'
import { notificationTypeSchema } from './notifications'

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const datetime = '2026-09-07T10:00:00.000Z'
const UK = 'uk' as const

const base = {
  id: uuid,
  title: 'Сохранённый заголовок',
  body: null,
  link: null,
  readAt: null,
  createdAt: datetime,
  subjectType: null,
  subjectId: null,
  secondaryId: null,
  data: null,
  subjectMissing: false,
  subjectArchived: false,
}

describe('тринадцать типов — реестр', () => {
  // task-i18n-stage4-task6: 13 = 10 исходных + 3 замороженных типа (инвойсы,
  // вакансии), зарегистрированных в `NEW_NOTIFICATION_TYPES`. Порядок — по
  // группам (`INFORMING_NOTIFICATION_TYPES`, `ACTION_REQUIRED_NOTIFICATION_
  // TYPES`, `ADMIN_NOTIFICATION_TYPES`), «три старых» больше НЕ дублируются
  // литералом в `notifications.ts` — иначе `z.enum` несёт повторяющиеся
  // значения.
  it('enum несёт ровно тринадцать типов, по группам', () => {
    expect(notificationTypeSchema.options).toEqual([
      'TRANSACTION_ADDED',
      'TRANSACTION_STATUS_CHANGED',
      'TEAM_MEMBER_ADDED',
      'PROJECT_MEMBER_ADDED',
      'TEAM_NEW_MEMBER',
      'VACANCY_APPLICATION',
      'INVOICE_SIGN_REQUIRED',
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'DOCUMENT_SIGN_REQUIRED',
      'APPROVAL_CONFIRMED',
      'APPROVAL_REJECTED',
      'INVOICE_SIGNED',
    ])
  })

  it('у каждого из тринадцати есть легаси-заголовок без точки на конце', () => {
    const titles = Object.entries(NOTIFICATION_TITLES)
    expect(titles).toHaveLength(13)
    for (const [type, title] of titles) {
      expect(title.length, type).toBeGreaterThan(0)
      expect(title.endsWith('.'), type).toBe(false)
    }
  })

  /**
   * COPY-H-1 (copy-review круг 1, #664): семейный префикс «Ждёт решения: »
   * съедал больше половины 24-символьного бюджета попапа (`w-80`, `truncate`)
   * и на 320/375/768px обрезал ровно то единственное слово, что сообщало
   * пользователю, чего от него хотят. Семья теперь узнаётся по общему значку
   * (`TypeIcon`), а не по префиксу — заголовок обязан помещаться в бюджет
   * целиком (измерено по скриншотам AC7 — ≤19 знаков).
   *
   * task-i18n-stage4-task6: состав `ACTION_REQUIRED_NOTIFICATION_TYPES` НЕ
   * расширен замороженными типами именно из-за этого бюджета —
   * `INVOICE_SIGN_REQUIRED`'s uk-заголовок («Рахунок очікує підпису») в него
   * не помещается.
   */
  it('три типа, требующие действия, помещаются в бюджет попапа целиком (COPY-H-1, ≤19 знаков)', () => {
    expect([...ACTION_REQUIRED_NOTIFICATION_TYPES]).toEqual([
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'DOCUMENT_SIGN_REQUIRED',
    ])
    for (const type of ACTION_REQUIRED_NOTIFICATION_TYPES) {
      expect(Array.from(NOTIFICATION_TITLES[type]).length, type).toBeLessThanOrEqual(19)
      // Ни один заголовок семьи не начинается со старого общего префикса —
      // предмет обязан стоять первым словом (COPY-H-1's "предмет первым").
      expect(NOTIFICATION_TITLES[type].startsWith('Ждёт решения'), type).toBe(false)
    }
  })

  it('subjectType — закрытый набор', () => {
    expect(notificationSubjectTypeSchema.options).toEqual([
      'PROJECT',
      'TEAM',
      'USER',
      'TRANSACTION',
      'EMPLOYEE_CONTRACT',
    ])
  })
})

/**
 * task-i18n-stage4-task6, Step 1 — рабочий пример из плана: `INVOICE_SIGNED`
 * рендерится из реестра (`NOTIFICATION_TITLE_MESSAGES`), а не из
 * замороженного заголовка, ранее лежавшего в БД.
 */
describe('три замороженных типа — реестр, не замороженная строка БД (task-i18n-stage4-task6)', () => {
  it('INVOICE_SIGNED рендерится из реестра, заголовок не называет контрагента', () => {
    const data = notificationDataSchemaFor('INVOICE_SIGNED').parse({
      counterpartyName: 'ТОВ Ромашка',
    })
    const rendered = renderNotification({ ...base, type: 'INVOICE_SIGNED', data }, UK)
    expect(rendered.title).toBe('Рахунок підписано')
    expect(rendered.title).not.toContain('ТОВ Ромашка')
    // §10: контрагент назван РОВНО один раз — в деталях, не в заголовке.
    expect(rendered.detail).toBe('ТОВ Ромашка')
  })

  it('INVOICE_SIGN_REQUIRED рендерится из реестра, деталь — сума', () => {
    const data = notificationDataSchemaFor('INVOICE_SIGN_REQUIRED').parse({
      amount: '1500.000000',
      currency: 'USDT',
    })
    expect(describeNotification('INVOICE_SIGN_REQUIRED', data, UK)).toBe('1 500,00 USDT')
    expect(NOTIFICATION_TITLE_MESSAGES.INVOICE_SIGN_REQUIRED.message).toBe('Рахунок очікує підпису')
  })

  it('VACANCY_APPLICATION рендерится из реестра, деталь — назва вакансії', () => {
    const data = notificationDataSchemaFor('VACANCY_APPLICATION').parse({
      vacancyTitle: 'Senior Frontend Engineer',
    })
    expect(describeNotification('VACANCY_APPLICATION', data, UK)).toBe(
      'Вакансія «Senior Frontend Engineer»',
    )
    expect(NOTIFICATION_TITLE_MESSAGES.VACANCY_APPLICATION.message).toBe('Новий відгук на вакансію')
  })

  it('три замороженных типа несут неймспейс `notification.<TYPE>.title` в id заголовка', () => {
    expect(NOTIFICATION_TITLE_MESSAGES.INVOICE_SIGNED.id).toBe('notification.INVOICE_SIGNED.title')
    expect(NOTIFICATION_TITLE_MESSAGES.INVOICE_SIGN_REQUIRED.id).toBe(
      'notification.INVOICE_SIGN_REQUIRED.title',
    )
    expect(NOTIFICATION_TITLE_MESSAGES.VACANCY_APPLICATION.id).toBe(
      'notification.VACANCY_APPLICATION.title',
    )
  })
})

describe('describeNotification — подробности из данных, не из базы', () => {
  // COPY-H-6 (copy-review круг 1, #664): полезное — вперёд, имя объекта — в
  // хвост, где его не жалко обрезать `line-clamp-2` при длинных именах.
  it('доля по проекту: полезные проценты вперёд, имя проекта в хвосте', () => {
    const data = notificationDataSchemaFor('SHARE_CONFIRM_REQUIRED').parse({
      scope: 'PROJECT',
      projectName: 'Acme',
      previousPercent: 26,
      proposedPercent: 30,
      approvalId: uuid,
    })
    expect(describeNotification('SHARE_CONFIRM_REQUIRED', data, UK)).toBe('26% → 30% · проєкт Acme')
  })

  // COPY-H-6 + COPY-M-3: причина — отдельной строкой (не приклеена к имени
  // проекта после двоеточия) и в кавычках (слова человека, не системы).
  it('отклонение несёт причину ПЕРВОЙ строкой, в кавычках (COPY-M-7 / UX-M-2)', () => {
    const data = notificationDataSchemaFor('APPROVAL_REJECTED').parse({
      approverName: 'Иван Петров',
      subjectTitle: 'Acme',
      subjectKind: 'PROJECT',
      reasonPreview: 'Доля не та',
    })
    expect(describeNotification('APPROVAL_REJECTED', data, UK)).toBe(
      '«Доля не та»\nИван Петров — проєкт Acme',
    )
  })
})

/**
 * COPY-L-7 (copy-review круг 3, #664). Попап деталь этого типа больше не
 * показывает — и ровно поэтому `documentTitle` перестал бы проверяться хоть
 * чем-нибудь (гейт мутаций круга 8 поймал это сразу: `z.object({})` вместо
 * формы с полем пережил весь прогон). Поле остаётся ОБЯЗАТЕЛЬНЫМ: его читает
 * экран ожиданий #667 и письмо позиции 7, где у строки нет своего заголовка.
 * Здесь проверяется именно требование формы, а не текст.
 */
describe('DOCUMENT_SIGN_REQUIRED — деталь снята, но название документа обязательно', () => {
  it('данные без documentTitle не принимаются', () => {
    expect(notificationDataSchemaFor('DOCUMENT_SIGN_REQUIRED').safeParse({}).success).toBe(false)
  })

  it('с названием — принимаются', () => {
    expect(
      notificationDataSchemaFor('DOCUMENT_SIGN_REQUIRED').safeParse({
        documentTitle: 'Ваш контракт',
      }).success,
    ).toBe(true)
  })
})

describe('renderNotification — клиент выводит подписи и кнопки по типу', () => {
  it('известный тип: заголовок и кнопка выведены, сохранённый заголовок не используется', () => {
    const rendered = renderNotification(
      {
        ...base,
        type: 'PROJECT_CONFIRM_REQUIRED',
        subjectType: 'PROJECT',
        subjectId: uuid,
        data: { projectName: 'Acme', approvalId: uuid },
      },
      UK,
    )
    expect(rendered.title).toBe('Проєкт очікує рішення')
    expect(rendered.detail).toBe('Проєкт Acme')
    expect(rendered.actions).toEqual([
      { label: 'Відкрити проєкт', href: `/projects/${uuid}`, disabled: false },
    ])
  })

  it('неизвестный тип не роняет попап — общий вид по сохранённому заголовку', () => {
    const rendered = renderNotification(
      {
        ...base,
        type: 'SOMETHING_FROM_THE_FUTURE' as never,
        title: 'Что-то случилось',
        link: '/finance',
      },
      UK,
    )
    expect(rendered.title).toBe('Что-то случилось')
    expect(rendered.actions).toEqual([{ label: 'Відкрити', href: '/finance', disabled: false }])
  })

  it('битые данные известного типа тоже дают общий вид, а не исключение', () => {
    const rendered = renderNotification(
      {
        ...base,
        type: 'PROJECT_MEMBER_ADDED',
        subjectType: 'PROJECT',
        subjectId: uuid,
        data: { projectName: 42 },
        title: 'Вас добавили в проект',
      },
      UK,
    )
    expect(rendered.title).toBe('Вас добавили в проект')
    expect(rendered.detail).toBeNull()
  })

  // COPY-M-4 (copy-review круг 1, #664): «объект» — слово из спеки, не из
  // интерфейса CRM; вид объекта уже известен в момент показа, честность
  // ничего не теряет от того, чтобы назвать объект конкретно.
  it('объект исчез — кнопка честно называет ЕГО ВИД и никуда не ведёт', () => {
    const rendered = renderNotification(
      {
        ...base,
        type: 'PROJECT_MEMBER_ADDED',
        subjectType: 'PROJECT',
        subjectId: uuid,
        data: { projectName: 'Acme' },
        subjectMissing: true,
      },
      UK,
    )
    expect(rendered.actions).toEqual([{ label: 'Проєкт видалено', href: null, disabled: true }])
  })
})

describe('notificationActions — маршрут выводится из subjectType', () => {
  it.each([
    ['PROJECT', `/projects/${uuid}`],
    ['TEAM', `/team/${uuid}`],
    ['USER', `/profile/${uuid}`],
    ['TRANSACTION', '/finance'],
    ['EMPLOYEE_CONTRACT', '/onboarding'],
  ] as const)('%s → %s', (subjectType, href) => {
    const actions = notificationActions(
      {
        ...base,
        type: 'APPROVAL_CONFIRMED',
        subjectType,
        subjectId: uuid,
        data: { approverName: 'И', subjectTitle: 'A', subjectKind: 'PROJECT' },
      },
      UK,
    )
    expect(actions[0]?.href).toBe(href)
  })
})

describe('describeNotification — все ветки, чтобы гейт мутаций видел каждую', () => {
  it.each([
    [
      'TRANSACTION_ADDED',
      { amount: '1200.00', currency: 'USD', projectName: 'Acme' },
      // COPY-H-4 (money() через formatMoney — тисячі через NBSP, кома, два
      // знаки) + COPY-H-6 (сума вперед, ім'я проєкту в хвості).
      '1 200,00 USD · проєкт Acme',
    ],
    [
      'TRANSACTION_ADDED',
      { amount: '1200.00', currency: 'USD', projectName: null },
      '1 200,00 USD',
    ],
    [
      'TRANSACTION_STATUS_CHANGED',
      { amount: '10.00', currency: 'USD', status: 'VALIDATED', rejectionReasonPreview: null },
      // COPY-L-6 (copy-review круг 3): «Доход» из детали снят — заголовок
      // типа уже «Рішення щодо доходу», слово занимало бы бюджет строки дважды.
      'Валідовано: 10,00 USD',
    ],
    [
      'TRANSACTION_STATUS_CHANGED',
      { amount: '10.00', currency: 'USD', status: 'REJECTED', rejectionReasonPreview: null },
      'Відхилено: 10,00 USD',
    ],
    [
      'TRANSACTION_STATUS_CHANGED',
      { amount: '10.00', currency: 'USD', status: 'REJECTED', rejectionReasonPreview: 'Нет чека' },
      // COPY-M-3: превью причины — в кавычках (слова человека, не системы).
      // COPY-L-6 (круг 3): факты первым рядом, цитата — вторым, как у
      // `APPROVAL_REJECTED`.
      '«Нет чека»\nВідхилено: 10,00 USD',
    ],
    ['TEAM_MEMBER_ADDED', { teamName: 'Alpha' }, 'Команда Alpha'],
    ['PROJECT_MEMBER_ADDED', { projectName: 'Acme' }, 'Проєкт Acme'],
    // COPY-H-6: кто пришёл — вперёд, имя команды — в хвост.
    ['TEAM_NEW_MEMBER', { teamName: 'Alpha', memberName: 'Иван' }, 'Иван · команда Alpha'],
    ['PROJECT_CONFIRM_REQUIRED', { projectName: 'Acme', approvalId: uuid }, 'Проєкт Acme'],
    [
      'SHARE_CONFIRM_REQUIRED',
      {
        scope: 'BASE',
        projectName: null,
        previousPercent: null,
        proposedPercent: 30,
        approvalId: uuid,
      },
      // COPY-H-3: «частка за замовчуванням», а «не задана» вместо «по
      // умолчанию» для значения — иначе одно слово в двух ролях в одной строке.
      'Частка за замовчуванням: не задана → 30%',
    ],
    [
      'SHARE_CONFIRM_REQUIRED',
      {
        scope: 'PROJECT',
        projectName: null,
        previousPercent: 26,
        proposedPercent: null,
        approvalId: uuid,
      },
      // COPY-H-6: проценты вперёд, имя проекта в хвосте.
      '26% → не задана · проєкт без назви',
    ],
    // COPY-L-7 (copy-review круг 3): деталь была подмножеством заголовка
    // («Контракт на подпись» + «Ваш контракт»), и «ваш» — единственное новое
    // слово, очевидное по построению: чужие контракты в личные уведомления не
    // приходят. Строку, которую можно удалить без потери смысла, удаляют.
    ['DOCUMENT_SIGN_REQUIRED', { documentTitle: 'Ваш контракт' }, null],
    [
      'APPROVAL_CONFIRMED',
      { approverName: 'Иван', subjectKind: 'BASE_SHARE', subjectTitle: null },
      // COPY-H-3: «базова частка» → «частка за замовчуванням» (#648).
      'Иван — частка за замовчуванням',
    ],
    [
      'APPROVAL_CONFIRMED',
      { approverName: 'Иван', subjectKind: 'PROJECT_SHARE', subjectTitle: 'Acme' },
      'Иван — частка за проєктом Acme',
    ],
    [
      'APPROVAL_CONFIRMED',
      { approverName: 'Иван', subjectKind: 'PROJECT', subjectTitle: null },
      'Иван — проєкт без назви',
    ],
  ] as const)('%s', (type, raw, expected) => {
    const data = notificationDataSchemaFor(type).parse(raw)
    expect(describeNotification(type, data as never, UK)).toBe(expected)
  })
})

/**
 * COPY-H-4 / QA-M-2 (copy-review + manual-qa круг 1, #664): `amount` приезжает
 * из `numeric('amount', { precision: 18, scale: 6 })` как строка вида
 * `1500.000000` — та самая порча, которую в проекте уже дважды чинили в
 * других потребителях той же колонки (`format-amount.ts`, `invoices.service.ts`).
 *
 * task-i18n-stage4-task6, Step 7: `money()` теперь идёт через `formatMoney`
 * (локаль читателя), а не жёстко `ru-RU` — на `uk` формат совпадает byte-в-byte
 * (NBSP-разделитель тысяч, запятая, два знака), см. `formatMoney` тесты.
 */
describe('money() — тот же формат, что и остальное приложение (COPY-H-4 / QA-M-2)', () => {
  it('шесть нулей после точки из NUMERIC(18,6) не долетают до сотрудника', () => {
    const data = notificationDataSchemaFor('TRANSACTION_ADDED').parse({
      amount: '1500.000000',
      currency: 'USDT',
      projectName: null,
    })
    expect(describeNotification('TRANSACTION_ADDED', data, UK)).toBe('1 500,00 USDT')
  })

  it('тысячи — через NBSP, дробная часть — запятой, всегда два знака', () => {
    const data = notificationDataSchemaFor('TRANSACTION_ADDED').parse({
      amount: '25.5',
      currency: 'USD',
      projectName: null,
    })
    expect(describeNotification('TRANSACTION_ADDED', data, UK)).toBe('25,50 USD')
  })

  it('нечисловой amount не роняет строку — сырой fallback вместо NaN', () => {
    const data = notificationDataSchemaFor('TRANSACTION_ADDED').parse({
      amount: 'n/a',
      currency: 'USD',
      projectName: null,
    })
    expect(describeNotification('TRANSACTION_ADDED', data, UK)).toBe('n/a USD')
  })
})

describe('подписи кнопок — по одной на тип, и каждая проверена', () => {
  // Гейт мутаций 2026-09-07: девять подписей из десяти пережили замену на
  // пустую строку. Тест «кнопка появилась» ничего не говорит о том, ЧТО на ней
  // написано, а подпись — это текст для сотрудника, то есть предмет ревью
  // текста ровно так же, как заголовок.
  //
  // COPY-M-1 (copy-review круг 1, #664): «глагол + объект» — «К транзакциям»
  // было предлогом, не действием; «Посмотреть и подтвердить» — два глагола И
  // обещание исхода, которого может не быть (сотрудник вправе отклонить);
  // «Открыть»/«Подписать» без объекта — ровно случай, названный `copywriting`.
  // APPROVAL_CONFIRMED/REJECTED теперь несут ДВЕ строки каждый — подпись
  // зависит от вида объекта решения (PROJECT vs USER), см. `actionLabelFor`.
  it.each([
    ['TRANSACTION_ADDED', 'TRANSACTION', 'Відкрити фінанси'],
    ['TRANSACTION_STATUS_CHANGED', 'TRANSACTION', 'Відкрити фінанси'],
    ['TEAM_MEMBER_ADDED', 'TEAM', 'Відкрити команду'],
    ['TEAM_NEW_MEMBER', 'TEAM', 'Відкрити команду'],
    ['PROJECT_MEMBER_ADDED', 'PROJECT', 'Відкрити проєкт'],
    ['PROJECT_CONFIRM_REQUIRED', 'PROJECT', 'Відкрити проєкт'],
    ['SHARE_CONFIRM_REQUIRED', 'PROJECT', 'Відкрити пропозицію'],
    ['DOCUMENT_SIGN_REQUIRED', 'EMPLOYEE_CONTRACT', 'Підписати контракт'],
    ['APPROVAL_CONFIRMED', 'PROJECT', 'Відкрити проєкт'],
    ['APPROVAL_CONFIRMED', 'USER', 'Відкрити профіль'],
    ['APPROVAL_REJECTED', 'PROJECT', 'Відкрити проєкт'],
    ['APPROVAL_REJECTED', 'USER', 'Відкрити профіль'],
  ] as const)('%s (%s) → «%s»', (type, subjectType, label) => {
    const actions = notificationActions(
      {
        ...base,
        type,
        subjectType,
        subjectId: uuid,
        data: null,
      },
      UK,
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]?.label).toBe(label)
  })
})

describe('subjectKind — обе формы согласования знают все три вида', () => {
  it.each(['APPROVAL_CONFIRMED', 'APPROVAL_REJECTED'] as const)('%s', (type) => {
    for (const subjectKind of ['PROJECT', 'PROJECT_SHARE', 'BASE_SHARE'] as const) {
      const raw = {
        approverName: 'Иван',
        subjectKind,
        subjectTitle: 'Acme',
        ...(type === 'APPROVAL_REJECTED' ? { reasonPreview: 'Причина' } : {}),
      }
      expect(() => notificationDataSchemaFor(type).parse(raw)).not.toThrow()
    }
    const bad = {
      approverName: 'Иван',
      subjectKind: 'SOMETHING_ELSE',
      subjectTitle: 'Acme',
      reasonPreview: 'Причина',
    }
    expect(() => notificationDataSchemaFor(type).parse(bad)).toThrow()
  })
})

describe('notificationActions — крайние случаи', () => {
  // Три условия в одном `if` — три отдельных случая. Гейт мутаций показал, что
  // без них любое из трёх можно заменить на `true` незаметно.
  it('известный тип БЕЗ вида объекта, но с идентификатором — общий путь', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_MEMBER_ADDED',
          subjectType: null,
          subjectId: uuid,
          data: { projectName: 'Acme' },
          link: '/projects',
        },
        UK,
      ),
    ).toEqual([{ label: 'Відкрити', href: '/projects', disabled: false }])
  })

  it('известный тип С видом объекта, но БЕЗ идентификатора — общий путь', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_MEMBER_ADDED',
          subjectType: 'PROJECT',
          subjectId: null,
          data: { projectName: 'Acme' },
          link: '/projects',
        },
        UK,
      ),
    ).toEqual([{ label: 'Відкрити', href: '/projects', disabled: false }])
  })

  it('НЕизвестный тип с полным адресом объекта всё равно идёт общим путём', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'SOMETHING_FROM_THE_FUTURE' as never,
          subjectType: 'PROJECT',
          subjectId: uuid,
          data: null,
          link: '/finance',
        },
        UK,
      ),
    ).toEqual([{ label: 'Відкрити', href: '/finance', disabled: false }])
  })

  it('известный тип без идентификатора объекта и без ссылки не даёт кнопок', () => {
    expect(notificationActions({ ...base, type: 'TEAM_MEMBER_ADDED', data: null }, UK)).toEqual([])
  })

  it('известный тип без идентификатора объекта падает на сохранённую ссылку', () => {
    expect(
      notificationActions({ ...base, type: 'TEAM_MEMBER_ADDED', data: null, link: '/team' }, UK),
    ).toEqual([{ label: 'Відкрити', href: '/team', disabled: false }])
  })

  it('исчезнувший объект гасит кнопку даже у типа со ссылкой', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'TEAM_MEMBER_ADDED',
          subjectType: 'TEAM',
          subjectId: uuid,
          data: { teamName: 'Alpha' },
          subjectMissing: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Команду видалено', href: null, disabled: true }])
  })
})

/**
 * COPY-M-4 (copy-review круг 1, #664): «Объекта больше нет» — слово из спеки,
 * которого нет в интерфейсе CRM. Вид объекта в момент показа уже известен
 * (`subjectType`), поэтому честность ничего не теряет от того, чтобы назвать
 * объект конкретно. Тип уведомления в этой таблице фиксирован ровно потому,
 * что подпись при `subjectMissing` зависит ТОЛЬКО от `subjectType` — сама
 * проверка это и доказывает, перебирая виды объекта под одним типом.
 */
describe('subjectMissing — подпись называет вид объекта конкретно (COPY-M-4)', () => {
  it.each([
    ['PROJECT', 'Проєкт видалено'],
    ['TEAM', 'Команду видалено'],
    ['USER', 'Профіль видалено'],
    ['TRANSACTION', 'Транзакцію видалено'],
    // EMPLOYEE_CONTRACT — тоже через ОБЩУЮ ветку (`type` здесь не
    // DOCUMENT_SIGN_REQUIRED), потому что через СВОЙ обычный тип
    // (DOCUMENT_SIGN_REQUIRED) subjectMissing перехватывается раньше — см.
    // describe ниже. Без этой строки мутационный гейт не видит
    // `SUBJECT_MISSING_LABELS.EMPLOYEE_CONTRACT` вовсе: единственный
    // реальный потребитель этого вида объекта (DOCUMENT_SIGN_REQUIRED)
    // никогда не доходит до общей карты (нашёл гейт мутаций — 1 survived).
    ['EMPLOYEE_CONTRACT', 'Контракт видалено'],
  ] as const)('%s → «%s»', (subjectType, label) => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_MEMBER_ADDED',
          subjectType,
          subjectId: uuid,
          data: null,
          subjectMissing: true,
        },
        UK,
      ),
    ).toEqual([{ label, href: null, disabled: true }])
  })

  it('subjectType неизвестен (тип из будущего без структурного объекта) — общий честный ответ', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'SOMETHING_FROM_THE_FUTURE' as never,
          subjectType: null,
          subjectId: null,
          data: null,
          link: '/finance',
          subjectMissing: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Цього більше немає в CRM', href: null, disabled: true }])
  })
})

/**
 * QA-M-1 (manual-qa круг 1, #664). Контракт в этой системе не удаляется —
 * `EmployeeContractsService` только меняет `status` (DRAFT → READY_TO_SIGN →
 * SIGNED, либо ручной откат в DRAFT/CANCELLED администратором). «Контракт
 * удалён» было бы неправдой; «подписан» — честный ответ на реальный переход.
 */
describe('DOCUMENT_SIGN_REQUIRED — честная деградация после подписи (QA-M-1)', () => {
  it('подписанный контракт — не «удалён», а «подписан»; кнопка недоступна', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'DOCUMENT_SIGN_REQUIRED',
          subjectType: 'EMPLOYEE_CONTRACT',
          subjectId: uuid,
          data: { documentTitle: 'Ваш контракт' },
          subjectMissing: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Підпис більше не потрібен', href: null, disabled: true }])
  })

  it('контракт ещё ждёт подписи — кнопка ведёт в визард, как и раньше', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'DOCUMENT_SIGN_REQUIRED',
          subjectType: 'EMPLOYEE_CONTRACT',
          subjectId: uuid,
          data: { documentTitle: 'Ваш контракт' },
          subjectMissing: false,
        },
        UK,
      ),
    ).toEqual([{ label: 'Підписати контракт', href: '/onboarding', disabled: false }])
  })
})

/**
 * CR-M-1 (код-ревью PR #664, круг 1). Одиннадцатый (теперь — четырнадцатый)
 * тип обязан ломать сборку в `describeNotification`, а не рендерить данные
 * чужой формы.
 */
describe('CR-M-1 — неописанный тип не проваливается в чужую форму', () => {
  it('падает с названием типа, а не показывает поля отказа', () => {
    expect(() =>
      describeNotification('SOMETHING_FROM_THE_FUTURE' as never, {} as never, UK),
    ).toThrow(/неописанный тип уведомления SOMETHING_FROM_THE_FUTURE/)
  })
})

/**
 * SR-H-1 (security-review PR #664, круг 1). Потолок разбора данных был уже
 * потолка записи: имя объекта `max(200)` против колонок `varchar(255)`,
 * причина отказа `max(1000)` в записи против входной схемы, у которой на
 * момент находки верхней границы не было вовсе. Производитель при этом сидит
 * ВНУТРИ транзакции события — значит легальное длинное значение отменяло
 * само событие.
 *
 * Здесь проверяется первая половина исправления: потолки сведены с сущностями,
 * а полный текст причины в уведомление не кладётся вовсе (§10 — уведомление
 * несёт суть и ссылку, причину читают в CRM).
 */
describe('SR-H-1 — потолки формы совпадают с потолками записи', () => {
  it('имя объекта в 255 символов — ровно колонка varchar(255) — форму проходит', () => {
    const name = 'я'.repeat(255)
    expect(() =>
      notificationDataSchemaFor('PROJECT_MEMBER_ADDED').parse({ projectName: name }),
    ).not.toThrow()
    expect(() =>
      notificationDataSchemaFor('TEAM_MEMBER_ADDED').parse({ teamName: name }),
    ).not.toThrow()
    expect(() =>
      notificationDataSchemaFor('TEAM_NEW_MEMBER').parse({ teamName: name, memberName: name }),
    ).not.toThrow()
  })

  it('имя длиннее колонки (256) форму не проходит — потолок остаётся потолком', () => {
    const tooLong = 'я'.repeat(256)
    expect(() =>
      notificationDataSchemaFor('PROJECT_MEMBER_ADDED').parse({ projectName: tooLong }),
    ).toThrow()
  })

  it('превью ровно в 200 символов остаётся собой — ни усечения, ни многоточия', () => {
    const exact = 'я'.repeat(200)
    expect(notificationTextPreview(exact)).toBe(exact)
  })

  it('201 символ усекается ровно до 200 — последний символ многоточие', () => {
    const preview = notificationTextPreview('я'.repeat(201))
    expect(preview).toHaveLength(200)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.slice(0, 199)).toBe('я'.repeat(199))
  })

  it('пять тысяч символов тоже сводятся к двумстам', () => {
    expect(notificationTextPreview('я'.repeat(5000))).toHaveLength(200)
  })

  /**
   * SR-M-3 (security-review круг 2). Длина мерялась в 16-битных единицах, а
   * усечение шло `slice` — по ним же. Эмодзи на позициях 198–199 оставляло на
   * срезе ОДИНОКИЙ СУРРОГАТ: форму такая строка проходила (ровно 200 единиц),
   * а Postgres отвергал её уже на `INSERT` в `jsonb`. То есть длина текста,
   * написанного человеком, снова решала судьбу события — в обход `refuse()`.
   *
   * `encodeURIComponent` бросает `URIError` ровно на одиноком суррогате — это
   * та же проверка, что `String.prototype.isWellFormed()`, но без зависимости
   * от версии lib в tsconfig.
   */
  it('эмодзи на границе не разрывается — превью остаётся корректной строкой', () => {
    const withEmojiOnBoundary = `${'a'.repeat(198)}😀${'b'.repeat(50)}`
    const preview = notificationTextPreview(withEmojiOnBoundary)

    expect(() => encodeURIComponent(preview)).not.toThrow()
    // Ровно потолок — но в СИМВОЛАХ, как их считает и колонка, и Postgres.
    expect(Array.from(preview)).toHaveLength(200)
    expect(preview.endsWith('…')).toBe(true)
    // Эмодзи доехало ЦЕЛИКОМ: 198 букв + оно = 199 символов, ровно потолок
    // без многоточия. Половины от него не осталось — старый `slice` по
    // единицам оставлял здесь один старший суррогат.
    expect(preview).toContain('😀')
  })

  it('двести эмодзи — это двести символов, а не четыреста: превью не трогает их', () => {
    const exact = '😀'.repeat(200)
    expect(notificationTextPreview(exact)).toBe(exact)
  })

  it('двести один эмодзи усекается до двухсот СИМВОЛОВ', () => {
    const preview = notificationTextPreview('😀'.repeat(201))
    expect(Array.from(preview)).toHaveLength(200)
    expect(Array.from(preview).slice(0, 199).join('')).toBe('😀'.repeat(199))
    expect(preview.endsWith('…')).toBe(true)
    expect(() => encodeURIComponent(preview)).not.toThrow()
  })

  it('превью из эмодзи ровно по потолку форму проходит — мерка у формы та же', () => {
    const schema = notificationDataSchemaFor('APPROVAL_REJECTED')
    expect(() =>
      schema.parse({
        approverName: 'Иван',
        subjectKind: 'PROJECT',
        subjectTitle: 'Acme',
        reasonPreview: '😀'.repeat(200),
      }),
    ).not.toThrow()
  })

  it('превью на символ длиннее потолка форму не проходит', () => {
    const schema = notificationDataSchemaFor('APPROVAL_REJECTED')
    expect(
      () =>
        schema.parse({
          approverName: 'Иван',
          subjectKind: 'PROJECT',
          subjectTitle: 'Acme',
          reasonPreview: '😀'.repeat(201),
        }),
      // Сообщение — не украшение: именно оно уезжает в журнал и телеметрию
      // отказа (см. `refuse()`), и по нему ищут сломавшегося производителя.
    ).toThrow(/at most 200 characters/)
  })

  /**
   * SR-M-3(б): потолок имени выводится из КОЛОНКИ (`varchar(255)`), а колонка
   * считает символы. Имя из 255 эмодзи в базу влезает — значит, и в форму
   * обязано: иначе легальное имя молча пропускало бы уведомление с ERROR в
   * журнале.
   */
  it('имя из 255 эмодзи форму проходит — колонка их принимает', () => {
    const name = '😀'.repeat(255)
    expect(() =>
      notificationDataSchemaFor('PROJECT_MEMBER_ADDED').parse({ projectName: name }),
    ).not.toThrow()
  })

  it('имя из 256 эмодзи форму не проходит — потолок остаётся потолком', () => {
    const name = '😀'.repeat(256)
    expect(() =>
      notificationDataSchemaFor('PROJECT_MEMBER_ADDED').parse({ projectName: name }),
    ).toThrow(/at most 255 characters/)
  })

  it('обрамляющие пробелы снимаются до подсчёта длины', () => {
    expect(notificationTextPreview('  причина  ')).toBe('причина')
    expect(notificationTextPreview(`  ${'я'.repeat(200)}  `)).toBe('я'.repeat(200))
  })

  it('текст из одних пробелов даёт пустую строку — производителю это «без причины»', () => {
    expect(notificationTextPreview('   ')).toBe('')
  })

  it('«сотрудник отклонил» принимает превью и его отсутствие, но не полный текст', () => {
    const schema = notificationDataSchemaFor('APPROVAL_REJECTED')
    const withReason = { approverName: 'Иван', subjectKind: 'PROJECT', subjectTitle: 'Acme' }
    expect(() => schema.parse({ ...withReason, reasonPreview: 'Доля не та' })).not.toThrow()
    expect(() => schema.parse({ ...withReason, reasonPreview: null })).not.toThrow()
    expect(() => schema.parse({ ...withReason, reasonPreview: 'я'.repeat(201) })).toThrow()
  })

  it('«статус транзакции изменился» несёт превью причины, не полный текст', () => {
    const schema = notificationDataSchemaFor('TRANSACTION_STATUS_CHANGED')
    const rejected = { amount: '10.00', currency: 'USD', status: 'REJECTED' }
    expect(() => schema.parse({ ...rejected, rejectionReasonPreview: 'Нет чека' })).not.toThrow()
    expect(() => schema.parse({ ...rejected, rejectionReasonPreview: null })).not.toThrow()
    expect(() => schema.parse({ ...rejected, rejectionReasonPreview: 'я'.repeat(201) })).toThrow()
  })

  it('отказ без причины описывается без обрыва строки', () => {
    expect(
      describeNotification(
        'APPROVAL_REJECTED',
        {
          approverName: 'Иван',
          subjectKind: 'PROJECT',
          subjectTitle: 'Acme',
          reasonPreview: null,
        },
        UK,
      ),
    ).toBe('Иван — проєкт Acme')
  })

  it('отказ с превью причины ставит её ПЕРВОЙ строкой в кавычках (COPY-M-7)', () => {
    expect(
      describeNotification(
        'APPROVAL_REJECTED',
        {
          approverName: 'Иван',
          subjectKind: 'PROJECT',
          subjectTitle: 'Acme',
          reasonPreview: 'Доля не та',
        },
        UK,
      ),
    ).toBe('«Доля не та»\nИван — проєкт Acme')
  })
})

/**
 * COPY-M-7 (copy-review круг 2) + UX-M-2 (design-review круг 2), #664.
 *
 * Обе находки — про одно: причина отказа, ради которой круг 1 заводил кавычки
 * и перенос строки, до читателя не доезжала. Попап показывает ДВЕ строки
 * (`line-clamp-2`) по ~30 знаков — а «кто — по какому объекту» съедал обе,
 * и причина жила на третьей, которой нет. У второго типа с цитатой
 * (`TRANSACTION_STATUS_CHANGED`) хвост клипа срезал закрывающую кавычку,
 * превращая чужую речь в обрыв строки.
 *
 * Тексты причин остаются оригинальными (человек мог написать их на любом
 * языке — это данные, не UI-текст) — механика усечения/кавычек одна и та же
 * на `uk`, что и была раньше (те же символы кавычек `«»`).
 */
function visibleInPopup(detail: string): string {
  const out: string[] = []
  for (const paragraph of detail.split('\n')) {
    const points = Array.from(paragraph)
    const rows = Math.max(1, Math.ceil(points.length / NOTIFICATION_DETAIL_LINE_CHARS))
    for (let row = 0; row < rows; row++) {
      if (out.length === NOTIFICATION_DETAIL_LINES) return out.join('')
      out.push(
        points
          .slice(row * NOTIFICATION_DETAIL_LINE_CHARS, (row + 1) * NOTIFICATION_DETAIL_LINE_CHARS)
          .join(''),
      )
    }
  }
  return out.join('')
}

describe('цитата причины доезжает до читателя целиком (COPY-M-7 / UX-M-2)', () => {
  const longReason = notificationTextPreview(
    'дублирует существующий проект того же клиента, я такой уже веду с марта, ' +
      'давайте обсудим на созвоне в четверг и решим, кто из нас его забирает',
  )

  it('отказ по доле: видна причина, а не одно только имя согласующего', () => {
    const detail = describeNotification(
      'APPROVAL_REJECTED',
      {
        approverName: 'Иван Петров',
        subjectKind: 'PROJECT_SHARE',
        subjectTitle: 'Acme Corporation',
        reasonPreview: longReason,
      },
      UK,
    )
    const visible = visibleInPopup(detail!)
    expect(visible.startsWith('«')).toBe(true)
    expect(visible).toContain('дублирует существу')
    expect(visible).toContain('Иван Петров')
  })

  it('отказ по доле: закрывающая кавычка видна, многоточие — ВНУТРИ кавычек', () => {
    const detail = describeNotification(
      'APPROVAL_REJECTED',
      {
        approverName: 'Иван Петров',
        subjectKind: 'PROJECT_SHARE',
        subjectTitle: 'Acme Corporation',
        reasonPreview: longReason,
      },
      UK,
    )
    const quoteLine = detail!.split('\n')[0]!
    expect(quoteLine.endsWith('…»')).toBe(true)
    expect(Array.from(quoteLine).length).toBeLessThanOrEqual(NOTIFICATION_DETAIL_LINE_CHARS)
    expect(visibleInPopup(detail!)).toContain(quoteLine)
  })

  it('отказ по доходу: причина ДО суммы, обе кавычки в видимой части', () => {
    const data = notificationDataSchemaFor('TRANSACTION_STATUS_CHANGED').parse({
      amount: '600.000000',
      currency: 'USDT',
      status: 'REJECTED',
      rejectionReasonPreview: notificationTextPreview(
        'Не тот проект, я заявил по другому — переоформите на FinTrack, пожалуйста',
      ),
    })
    const visible = visibleInPopup(describeNotification('TRANSACTION_STATUS_CHANGED', data, UK)!)
    expect(visible).toContain('«')
    expect(visible).toContain('»')
    expect(visible).toContain('600,00 USDT')
  })

  it('короткая причина не усекается вовсе — многоточия там взяться неоткуда', () => {
    const detail = describeNotification(
      'APPROVAL_REJECTED',
      {
        approverName: 'Иван',
        subjectKind: 'PROJECT',
        subjectTitle: 'Acme',
        reasonPreview: 'Не тот клиент',
      },
      UK,
    )
    expect(detail).toBe('«Не тот клиент»\nИван — проєкт Acme')
  })

  it('перевод строки внутри причины не уносит закрывающую кавычку на третий ряд', () => {
    const detail = describeNotification(
      'APPROVAL_REJECTED',
      {
        approverName: 'Иван',
        subjectKind: 'PROJECT',
        subjectTitle: 'Acme',
        reasonPreview: 'Первая\nвторая\nтретья',
      },
      UK,
    )
    expect(detail).toBe('«Первая вторая третья»\nИван — проєкт Acme')
  })

  it('вся цитата целиком помещается в видимую часть на каждом из двух типов', () => {
    const rejected = describeNotification(
      'APPROVAL_REJECTED',
      {
        approverName: 'Иван Петров',
        subjectKind: 'PROJECT_SHARE',
        subjectTitle: 'Acme Corporation',
        reasonPreview: longReason,
      },
      UK,
    )
    const income = describeNotification(
      'TRANSACTION_STATUS_CHANGED',
      notificationDataSchemaFor('TRANSACTION_STATUS_CHANGED').parse({
        amount: '1500.000000',
        currency: 'USDT',
        status: 'REJECTED',
        rejectionReasonPreview: longReason,
      }),
      UK,
    )
    for (const detail of [rejected!, income!]) {
      const quote = detail.slice(detail.indexOf('«'), detail.indexOf('»') + 1)
      expect(quote.length).toBeGreaterThan(2)
      expect(visibleInPopup(detail)).toContain(quote)
    }
  })
})

/**
 * QA-M-3 (MED) / QA-L-2 (LOW), manual-qa круг 2, #664.
 *
 * Архив — третий ответ, а не разновидность удаления. Живой прогон показал
 * цену смешения: архивированный проект оставлял кнопку активной, и джун,
 * чьё членство завершилось каскадом архивации, приезжал на страницу
 * «Вас ещё не добавили в проект». Подпись «Проект удалён» была бы вторым
 * враньём — проект цел и виден в архиве.
 */
describe('архивный объект — своя подпись, кнопка недоступна (QA-M-3 / QA-L-2)', () => {
  const archived = (subjectType: NotificationSubjectType, type: string) =>
    notificationActions(
      {
        ...base,
        type,
        subjectType,
        subjectId: uuid,
        subjectArchived: true,
      },
      UK,
    )

  it.each([
    ['PROJECT', 'PROJECT_MEMBER_ADDED', 'Проєкт в архіві'],
    ['TEAM', 'TEAM_MEMBER_ADDED', 'Команда в архіві'],
    ['USER', 'APPROVAL_CONFIRMED', 'Профіль в архіві'],
  ] as const)('%s → «%s»', (subjectType, type, label) => {
    expect(archived(subjectType, type)).toEqual([{ label, href: null, disabled: true }])
  })

  it('семь типов с объектом-проектом получают одну и ту же честную подпись', () => {
    // Находка задевает не один тип, а всю семью с `subjectType='PROJECT'` —
    // поэтому проверяется семья, а не один представитель.
    for (const type of [
      'PROJECT_MEMBER_ADDED',
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'APPROVAL_CONFIRMED',
      'APPROVAL_REJECTED',
      'TRANSACTION_ADDED',
      'INVOICE_SIGN_REQUIRED',
    ]) {
      expect(archived('PROJECT', type)).toEqual([
        { label: 'Проєкт в архіві', href: null, disabled: true },
      ])
    }
  })

  it('исчезнувший объект сильнее архивного: «удалён» не подменяется «в архиве»', () => {
    // Сервер такой пары не выдаёт (оба поля выводятся из одного состояния),
    // но порядок веток всё равно закреплён: иначе его молча переставят.
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_MEMBER_ADDED',
          subjectType: 'PROJECT',
          subjectId: uuid,
          subjectMissing: true,
          subjectArchived: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Проєкт видалено', href: null, disabled: true }])
  })

  it('вид объекта неизвестен — общий честный ответ, а не пустая кнопка', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'FUTURE_TYPE',
          link: '/finance',
          subjectArchived: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Це прибрано в архів', href: null, disabled: true }])
  })

  it('живой объект архивной подписи не получает — кнопка ведёт куда обещает', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_MEMBER_ADDED',
          subjectType: 'PROJECT',
          subjectId: uuid,
          subjectArchived: false,
        },
        UK,
      ),
    ).toEqual([{ label: 'Відкрити проєкт', href: `/projects/${uuid}`, disabled: false }])
  })
})

/**
 * ORCH-2 (fix-раунд 6, #664). Живой прогон круга 5 (открытый вопрос в теле
 * PR) поймал ложь: живой проект, чьё предложение отозвали, получал «Проект
 * удалён» — подпись объекта на состоянии согласования. Два новых поля дают
 * два честных ответа вместо одного неверного.
 */
describe('согласование по живому объекту больше не актуально (ORCH-2)', () => {
  it('погашено (отозвано, заменено, погасил отказ соседа) — «Решение больше не требуется»', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'SHARE_CONFIRM_REQUIRED',
          subjectType: 'PROJECT',
          subjectId: uuid,
          approvalSuperseded: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Рішення більше не потрібне', href: null, disabled: true }])
  })

  it('уже решено этим же подтверждающим — «Решение уже принято», не «отозвано»', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_CONFIRM_REQUIRED',
          subjectType: 'PROJECT',
          subjectId: uuid,
          approvalDecided: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Рішення вже прийнято', href: null, disabled: true }])
  })

  it('подпись одна и та же независимо от вида объекта — доля по пользователю', () => {
    // В отличие от subjectMissing/subjectArchived, здесь нет карты по
    // NotificationSubjectType: подпись описывает СОГЛАСОВАНИЕ, а не объект.
    expect(
      notificationActions(
        {
          ...base,
          type: 'SHARE_CONFIRM_REQUIRED',
          subjectType: 'USER',
          subjectId: uuid,
          approvalSuperseded: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Рішення більше не потрібне', href: null, disabled: true }])
  })

  it('исчезнувший объект сильнее — «удалён» не подменяется «отозвано»', () => {
    // Сервер такой пары не выдаёт (все четыре поля — из одного состояния), но
    // порядок веток закреплён отдельно: иначе его молча переставят.
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_CONFIRM_REQUIRED',
          subjectType: 'PROJECT',
          subjectId: uuid,
          subjectMissing: true,
          approvalSuperseded: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Проєкт видалено', href: null, disabled: true }])
  })

  it('архивный объект сильнее — «в архиве» не подменяется «отозвано»', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_CONFIRM_REQUIRED',
          subjectType: 'PROJECT',
          subjectId: uuid,
          subjectArchived: true,
          approvalSuperseded: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Проєкт в архіві', href: null, disabled: true }])
  })

  it('решено сильнее отозвано — если оба true, читатель видит «решено»', () => {
    // Сервер тоже не выдаёт эту пару (одно состояние → одна пара флагов), но
    // порядок веток `notificationActions` закреплён явно.
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_CONFIRM_REQUIRED',
          subjectType: 'PROJECT',
          subjectId: uuid,
          approvalDecided: true,
          approvalSuperseded: true,
        },
        UK,
      ),
    ).toEqual([{ label: 'Рішення вже прийнято', href: null, disabled: true }])
  })

  it('ничего из этого не выставлено — кнопка ведёт как обычно', () => {
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_CONFIRM_REQUIRED',
          subjectType: 'PROJECT',
          subjectId: uuid,
        },
        UK,
      ),
    ).toEqual([{ label: 'Відкрити проєкт', href: `/projects/${uuid}`, disabled: false }])
  })
})

/**
 * Пять выживших мутантов первого прогона гейта на этом круге. Каждый — не
 * придирка инструмента, а настоящая дыра: мутант менял поведение, и ни один
 * тест этого не замечал.
 */
describe('гейт мутаций круга 5 — то, что проходило незамеченным', () => {
  it('обрамляющие пробелы причины не попадают ВНУТРЬ кавычек', () => {
    // Мутант снимал `.trim()`: получалось «« причина »» — чужая речь с
    // пробелами у самых кавычек. Схема превью пробелы не снимает (`textPreview`
    // проверяет только длину), так что реестр обязан делать это сам.
    expect(
      describeNotification(
        'APPROVAL_REJECTED',
        {
          approverName: 'Иван',
          subjectKind: 'PROJECT',
          subjectTitle: 'Acme',
          reasonPreview: '   Не тот клиент   ',
        },
        UK,
      ),
    ).toBe('«Не тот клиент»\nИван — проєкт Acme')
  })

  it('подряд идущие пробелы схлопываются в ОДИН, а не остаются парой', () => {
    // Мутант менял `/\s+/` на `/\s/`: каждый пробельный знак заменялся
    // отдельно, и «а\n\nб» давало два пробела подряд вместо одного.
    expect(
      describeNotification(
        'APPROVAL_REJECTED',
        {
          approverName: 'Иван',
          subjectKind: 'PROJECT',
          subjectTitle: 'Acme',
          reasonPreview: 'Первая\n\n\tвторая',
        },
        UK,
      ),
    ).toBe('«Первая вторая»\nИван — проєкт Acme')
  })

  it('цитата в отказе по доходу занимает ровно свой ряд клипа (COPY-L-6)', () => {
    // Круг 5 пинил здесь арифметику общего бюджета (`22 * 2` минус занятое).
    // COPY-L-6 эту арифметику убрал вместе с дефектом, который она
    // обслуживала: у цитаты теперь СВОЙ ряд, и пинится он — точной строкой,
    // потому что «содержит кавычку» переживает любую подмену границы.
    const data = notificationDataSchemaFor('TRANSACTION_STATUS_CHANGED').parse({
      amount: '600.000000',
      currency: 'USDT',
      status: 'REJECTED',
      rejectionReasonPreview: 'Не тот проект, я заявил по другому — переоформите на FinTrack',
    })
    expect(describeNotification('TRANSACTION_STATUS_CHANGED', data, UK)).toBe(
      '«Не тот проект, я за…»\nВідхилено: 600,00 USDT',
    )
  })

  it('цитата видна и на четырёхзначной сумме — ряд фактов её не вытесняет', () => {
    // Порядок «цитата первой» — ТОТ ЖЕ, что у `APPROVAL_REJECTED`, выбран ради
    // единой раскладки с соседом, а не по вместимости: ряд фактов на этой
    // сумме — 152 px из 202 (промер copy-review круга 4), то есть один ряд.
    // Тест фиксирует, что цитата видна при любой сумме независимо от причины.
    const data = notificationDataSchemaFor('TRANSACTION_STATUS_CHANGED').parse({
      amount: '1234.500000',
      currency: 'USDT',
      status: 'REJECTED',
      rejectionReasonPreview: 'Не тот проект',
    })
    const detail = describeNotification('TRANSACTION_STATUS_CHANGED', data, UK)!
    expect(detail.split('\n')[0]).toBe('«Не тот проект»')
    expect(visibleInPopup(detail)).toContain('«Не тот проект»')
  })

  it.each([
    ['TRANSACTION', 'Транзакція в архіві'],
    ['EMPLOYEE_CONTRACT', 'Контракт в архіві'],
  ] as const)('архивная подпись для %s — не пустая строка', (subjectType, label) => {
    // Сервер этих двух состояний не порождает (у транзакции мягкое удаление, у
    // контракта — статус), поэтому записи легко было бы выпотрошить незаметно.
    // Реестр — чистое отображение: раз запись есть, она обязана быть проверена,
    // иначе `Record` без пропусков охраняет форму, но не содержимое.
    expect(
      notificationActions(
        {
          ...base,
          type: 'PROJECT_MEMBER_ADDED',
          subjectType,
          subjectId: uuid,
          subjectArchived: true,
        },
        UK,
      ),
    ).toEqual([{ label, href: null, disabled: true }])
  })
})
