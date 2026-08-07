import type { Dictionary } from '../dictionary'

/**
 * `ru` — Russian copy, WRITTEN in Russian, not translated from `en.ts`
 * (task-landing-copy-refactor.md §2 / skill `copywriting` §5). Where the
 * English leans on noun phrases, the Russian leans on verbs, because that is
 * how the language actually reads:
 * Techniques, not quotes — a comment that restates the string below it is a
 * second source of truth and drifts on the first edit:
 * - hero: a nominal construction with a dash, where a literal rendering of
 *   the English would give a participial calque.
 * - about: the team-composition claim is stated from the positive side
 *   ("senior only") rather than the English "no juniors" — Russian has no
 *   natural genitive for a Latin `junior`, and a Cyrillic «джуниоров» beside
 *   a Latin `senior` was review round 2's finding.
 * - work: a parallel ellipsis, idiomatic in Russian, where the English uses
 *   "but".
 * - contact: names the staffing pain, as the English now does too.
 *
 * Every heading carries the SAME claim as the English — the registry is
 * `__tests__/heading-claims.ts`, and a test proves no heading escapes it.
 * Address form: «вы» со строчной, everywhere, no обращение на «Вы».
 * Industry terms stay in English where the Russian equivalent reads like a
 * textbook (senior, production, deploy, headless, MLOps, LLM/RAG), and the
 * choice is per TERM, not per occurrence. Key set MUST mirror `en.ts`
 * exactly (enforced by `__tests__/i18n.spec.ts`).
 */
export const ru: Dictionary = {
  hiringStrip: {
    // review round 1 MED-1 — CLDR one/few/many (1 / 2-4 / 0,5-20,25+; ru
    // "teen exception": 11-14 → many, NOT few — see lib/plural.ts).
    text: {
      one: 'Мы нанимаем — {count} открытая позиция',
      few: 'Мы нанимаем — {count} открытые позиции',
      many: 'Мы нанимаем — {count} открытых позиций',
      other: 'Мы нанимаем — {count} открытых позиций',
    },
    close: 'Закрыть',
  },
  nav: {
    services: 'Услуги',
    work: 'Кейсы',
    careers: 'Вакансии',
    contact: 'Контакты',
    startProject: 'Начать проект',
    toggleMenu: 'Открыть меню',
    primaryNav: 'Основная навигация',
    primaryMobileNav: 'Основная навигация (мобильная)',
    brandHome: 'CheekyCheeseIT — на главную',
  },
  footer: {
    tagline: 'Senior-инженеры для AI, EdTech и E-Commerce',
    studioHeading: 'Студия',
    selectedWork: 'Кейсы',
    howWeWork: 'Как мы работаем',
    companyHeading: 'Компания',
    careers: 'Вакансии',
    aboutUs: 'О нас',
    contact: 'Контакты',
    getInTouch: 'Связаться с нами',
    writeToUs: 'Написать нам',
    rights: '© 2026 CheekyCheeseIT. Все права защищены.',
  },
  languageSwitcher: {
    label: 'Язык',
    names: { en: 'English', uk: 'Українська', ru: 'Русский', es: 'Español', pt: 'Português' },
  },
  home: {
    seoTitle: 'CheekyCheeseIT — senior-команды для AI, EdTech, E-Commerce',
    seoDescription:
      'Senior-only студия разработки для международных продуктовых команд. Аутсорс и аутстаффинг в AI, EdTech и E-Commerce — рабочий результат каждую неделю.',
    heroChip: 'Аутсорс и аутстаффинг · AI · EdTech · E-Commerce',
    heroH1Line1: 'Сложное —',
    heroH1Highlight: 'еженедельно',
    // Ревью раунд 2 (HIGH-1): было «Три домена, которые знаем досконально» —
    // граница, заявленная выше сгиба и раньше раздела услуг, где теперь
    // сказано обратное. Формулировка намеренно НЕ повторяет заголовок
    // («Домен любой») — то же утверждение, другие слова.
    heroParagraph:
      'Senior-only студия для международных продуктовых команд. Работаем в любом домене, 4+ часа пересечения с вашим рабочим днём.',
    ctaStartProject: 'Начать проект',
    ctaSeeRoles: 'Открытые вакансии',
    aboutEyebrow: 'О нас',
    aboutH2Line1: 'Малые команды,',
    aboutH2Line2: 'только senior',
    aboutP1:
      'Встраиваемся в вашу продуктовую команду как её часть — или берём задачу целиком. В обоих случаях вы общаетесь с теми, кто пишет код, а не с аккаунт-менеджером посередине.',
    aboutP2:
      'Подход намеренно узкий, и размен честный: меньше людей на проекте, все senior, каждый отвечает за результат, а не за очередь тикетов. Большая часть того, что мы построили, носит чужое имя — нас это устраивает.',
    aboutBullets: [
      'Только senior-инженеры',
      'Рабочий инкремент каждую неделю',
      'Отвечаем за результат, а не за тикет',
      '4+ часа пересечения по времени',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Реализованных проектов' },
      { value: '15', suffix: '+', label: 'Продуктовых клиентов' },
      { value: '3', suffix: '+', label: 'Года на рынке' },
      { value: '20', suffix: '+', label: 'Senior-инженеров' },
    ],
    workEyebrow: 'Кейсы',
    workH2: 'Имён нет — цифры есть',
    workP:
      'NDA не даёт назвать клиентов. Задачи, решения и цифры — ровно те, что были на самом деле.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Real-time инференс для vision SaaS',
        challenge:
          'Под нагрузкой задержка модели уходила за 400 мс, а расходы на инференс росли быстрее выручки.',
        solution:
          'Пересобрали слой обслуживания: батчевый инференс на GPU, тёплый кэш модели и автоскейлинг по запросу.',
        metrics: [
          { value: '80', suffix: 'мс', label: 'p95 задержка' },
          { value: '-64', suffix: '%', label: 'Расходы на инференс' },
          { value: '5', suffix: '×', label: 'Пропускная способность' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Адаптивное обучение для сети K-12',
        challenge:
          'Одна программа на всех: сильным скучно, отстающие не догоняют — завершаемость падала.',
        solution:
          'Собрали движок персональных траекторий: следующий урок подбирается по текущим сигналам усвоения.',
        metrics: [
          { value: '+38', suffix: '%', label: 'Завершаемость' },
          { value: '120', suffix: 'к', label: 'Активных учеников' },
          { value: '+22', suffix: '%', label: 'Удержание' },
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'Headless-витрина для глобального DTC-бренда',
        challenge:
          'Старый монолит ложился в дни запусков, а брошенных корзин становилось больше с каждым тормозящим экраном.',
        solution:
          'Перевели на headless-витрину с рендерингом на edge и идемпотентным оформлением заказа без простоя.',
        metrics: [
          { value: '1.2', suffix: 'с', label: 'LCP по миру' },
          { value: '+27', suffix: '%', label: 'Конверсия' },
          { value: '99.99', suffix: '%', label: 'Аптайм' },
        ],
      },
    ],
    challengeLabel: 'Задача',
    solutionLabel: 'Решение',
    servicesEyebrow: 'Услуги',
    // task-domains-expansion — обе половины утверждения обязаны дожить до
    // русского: домен любой И в трёх уже есть продакшен. Прежний заголовок
    // («Три домена, ценой ошибок») обещал ровно три и ничего сверх них.
    servicesH2Line1: 'Домен любой,',
    servicesH2Line2: 'три уже в проде',
    servicesP:
      'От индустрии к индустрии повторяется одно и то же: задержки, модель данных, платежи, нагрузка. Меняется словарь, и его мы разбираем на discovery. В AI, EdTech и E-Commerce у нас уже есть продакшен — за остальное берёмся так же.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Прикладной AI & ML',
        description:
          'Обслуживание моделей для vision-SaaS, RAG-пайплайны и рекомендательные системы — быстрые, наблюдаемые и посильные по деньгам в production.',
        bullets: [
          'Обслуживание моделей и MLOps',
          'LLM- и RAG-приложения',
          'Пайплайны данных и признаков',
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'EdTech-платформы',
        description:
          'Адаптивные траектории для сети школ K-12, движки оценивания и инструменты для контента — интересные ученику и измеримые для тех, кто за это платит.',
        bullets: [
          'Адаптивные траектории обучения',
          'Оценивание и аналитика',
          'Авторинг и LMS-инструменты',
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'E-Commerce системы',
        description:
          'Headless-витрина для глобального DTC-бренда, оформление заказа и склад под нагрузкой — держат дни запусков и остаются быстрыми в любой точке мира.',
        bullets: ['Headless-витрины', 'Edge-оформление заказа и платежи', 'Склад и фулфилмент'],
      },
      // Четвёртая карточка — та самая «не привязаны к домену», сказанная
      // прямо. Придуманный четвёртый кейс сделал бы ложью обещание из
      // раздела «Работы»: цифры там ровно те, что были.
      {
        domain: 'open',
        domainLabel: 'Любой домен',
        title: 'Ваш домен',
        description:
          'Кейса здесь пока нет, и придумывать его мы не станем. Переносится другое — практика: сначала discovery, дальше команда из сеньоров и рабочий инкремент на первой же неделе. Три соседние карточки начинались так же.',
        bullets: ['Discovery до кода', 'Только senior-инженеры', 'Ваш репозиторий, ваш стек'],
      },
    ],
    processEyebrow: 'Как мы работаем',
    processH2Line1: 'Четыре шага,',
    processH2Line2: 'без чёрного ящика',
    processSteps: [
      {
        stepNum: '01 / Discovery',
        title: 'Discovery',
        description:
          'Очерчиваем задачу, снимаем неизвестные риски и согласуем план, за который отвечаем.',
      },
      {
        stepNum: '02 / Разработка',
        title: 'Разработка',
        description:
          'Senior-команды поставляют инкременты еженедельно — в вашем репозитории, в вашем стеке, открыто.',
      },
      {
        stepNum: '03 / Запуск',
        title: 'Запуск',
        description:
          'Выкатываем в production с мониторингом, нагрузочными тестами и откатом, который вам не понадобится.',
      },
      {
        stepNum: '04 / Поддержка',
        title: 'Поддержка',
        description: 'Остаёмся надолго — производительность, надёжность и следующая итерация.',
      },
    ],
    techStackEyebrow: 'Технологии',
    techStackH2: 'Стек по умолчанию',
    careersEyebrow: 'Вакансии',
    careersH2: 'Ответственность с первой недели',
    careersP:
      'Берём тех, за кем уже есть сложные проекты в AI, EdTech или e-commerce. Удалённо, команды небольшие — сделанное вами не тонет в бэклоге. Если это про вас, давайте поговорим.',
    viewAllRoles: 'Все вакансии',
    contactH2: 'Есть задача, которую некому взять?',
    contactP:
      'Расскажите, что вы строите. Ответим в течение одного рабочего дня — инженеры, а не отдел продаж.',
    terminalAriaLabel:
      'Анимированный редактор кода с примерами проектов CheekyCheeseIT в AI, EdTech и E-Commerce',
    contactForm: {
      nameLabel: 'Имя',
      namePlaceholder: 'Ada Lovelace',
      companyLabel: 'Компания',
      companyPlaceholder: 'Acme Inc. (необязательно)',
      emailLabel: 'Email',
      emailPlaceholder: 'you@company.com',
      messageLabel: 'Что вы строите?',
      messagePlaceholder: 'Расскажите о задаче, сроках и команде, которая у вас есть сейчас.',
      submit: 'Отправить сообщение',
      submitting: 'Отправляем…',
      protectedBy: 'Защищено невидимой капчей — без головоломок.',
      orEmailUs: 'или напишите нам напрямую на',
      errorName: 'Пожалуйста, введите имя.',
      errorEmail: 'Введите корректный email.',
      errorMessage: 'Расскажите чуть подробнее (минимум 10 символов).',
      successHeading: 'Сообщение получено',
      successBody: 'Спасибо — мы получили его и ответим в течение одного рабочего дня.',
      apiErrorValidation:
        'Не удалось отправить сообщение. Проверьте введённые данные и попробуйте снова.',
      apiErrorTurnstile: 'Проверка «я не робот» не прошла — попробуйте ещё раз.',
      apiErrorTurnstileRepeat:
        'Проверка «я не робот» снова не прошла. Попробуйте ещё раз или напишите нам напрямую на',
      apiErrorRateLimited:
        'Вы недавно уже отправляли сообщения — попробуйте чуть позже или напишите нам напрямую.',
      apiErrorUnavailable: 'Форма временно недоступна — напишите нам напрямую.',
      apiErrorNetwork:
        'Не удалось отправить сообщение. Проверьте введённые данные и попробуйте снова.',
    },
  },
  careers: {
    seoTitle: 'Вакансии — CheekyCheeseIT',
    seoDescription:
      'Открытые senior-вакансии в CheekyCheeseIT — удалённо, только senior, реальная ответственность за результат.',
    eyebrow: 'Вакансии',
    h1: 'Сложные задачи и senior-коллеги',
    p1: 'Нанимаем медленно и держим команды небольшими, поэтому каждая вакансия здесь закрывает настоящую потребность. Удалённо, с реальной ответственностью: вы отвечаете за результат, а не за очередь тикетов.',
    p2: 'Ниже — открытые удалённые вакансии. Каждая senior-роль здесь — это живое место в работающей продуктовой команде, а не заявка «когда-нибудь».',
    emptyTitle: 'Сейчас открытых вакансий нет',
    emptyBody:
      'Мы нанимаем волнами и сейчас между ними. Всё равно пришлите резюме — мы храним каждый сильный профиль и напишем, как только появится подходящая роль.',
  },
  vacancyCard: {
    viewRole: 'Смотреть вакансию',
  },
  vacancy: {
    notFoundSeoTitle: 'Вакансия не найдена — CheekyCheeseIT Careers',
    notFoundSeoDescription: 'Эта вакансия больше недоступна.',
    notFoundH1: 'Вакансия не найдена',
    notFoundBody: 'Эта вакансия уже закрыта — но, возможно, есть другие.',
    backToCareers: 'Ко всем вакансиям',
    allRoles: 'Все вакансии',
    // Отраслевой жаргон не переводим (скилл `copywriting` §5: FinTech, SaaS,
    // iGaming на русском рынке живут как есть); обычные слова, у которых
    // есть нормальный русский эквивалент, — переводим.
    domainLabels: {
      AI: 'AI / ML',
      EDTECH: 'EdTech',
      ECOMMERCE: 'E-Commerce',
      FINTECH: 'FinTech',
      IGAMING: 'iGaming',
      // Раунд 2 (MED-3): единственное исключение из правила «обычные слова
      // переводим». В русскоязычном IT-найме вертикаль называется именно
      // «adult» латиницей («adult-индустрия», «adult-трафик»); «Взрослый
      // контент» в теге вакансии читается как описание, а не как индустрия.
      // es/pt переведены — там прижилось обратное.
      ADULT: 'Adult',
      SAAS: 'SaaS',
      HEALTHTECH: 'HealthTech',
      ADTECH: 'AdTech',
      LOGISTICS: 'Логистика',
      PROPTECH: 'PropTech',
      TRAVEL: 'Путешествия',
      MEDIA: 'Медиа',
      WEB3: 'Web3',
      HRTECH: 'HR Tech',
      CYBERSEC: 'Кибербезопасность',
      OTHER: 'Другое',
    },
    employmentTypeLabels: {
      FULL_TIME: 'Полная занятость',
      PART_TIME: 'Частичная занятость',
      CONTRACT: 'Контракт',
    },
    salaryPeriodLabels: {
      HOUR: 'в час',
      DAY: 'в день',
      WEEK: 'в неделю',
      MONTH: 'в месяц',
      YEAR: 'в год',
    },
    breadcrumbHome: 'Главная',
    breadcrumbCareers: 'Вакансии',
    titleSuffix: 'CheekyCheeseIT Careers',
    relatedHeading: 'Похожие вакансии',
    apply: {
      heading: 'Откликнуться на вакансию',
      subheading: 'Займёт около 3 минут. Поля со * обязательны.',
      requiredNote: 'обязательно',
      fullNameLabel: 'Имя и фамилия',
      emailLabel: 'Email',
      telegramLabel: 'Telegram',
      linkedinLabel: 'Ссылка на LinkedIn',
      githubLabel: 'Ссылка на GitHub',
      coverLetterLabel: 'Сопроводительное письмо',
      namePlaceholder: 'Ada Lovelace',
      emailPlaceholder: 'you@domain.com',
      telegramPlaceholder: '@handle',
      linkedinPlaceholder: 'linkedin.com/in/…',
      githubPlaceholder: 'github.com/…',
      coverPlaceholder:
        'Расскажите о сложной задаче, которую вы решали, и что хотели бы строить у нас.',
      cvLabel: 'Резюме (CV)',
      cvDropPrefix: 'Перетащите резюме сюда или',
      cvBrowse: 'выберите файл',
      cvHint: 'Только PDF · до 5 МБ',
      cvRemoveAriaLabel: 'Удалить файл',
      errorName: 'Пожалуйста, введите имя.',
      errorEmail: 'Введите корректный email.',
      errorLinkedin: 'Введите корректную ссылку на LinkedIn (https://…).',
      errorGithub: 'Введите корректную ссылку на GitHub (https://…).',
      errorFile: 'Пожалуйста, прикрепите резюме (PDF).',
      cvInvalidType: 'Резюме должно быть в формате PDF.',
      cvTooLarge: 'Файл больше 5 МБ.',
      submit: 'Отправить отклик',
      submitting: 'Отправляем…',
      processing: 'Обрабатываем…',
      protectedBy: 'Защищено невидимой капчей — без головоломок.',
      successHeading: 'Отклик получен',
      successThanks: 'Спасибо',
      successBodyBefore: '— мы получили ваш отклик на позицию',
      successBodyAfter:
        '. Рассматриваем каждый отклик и ответим в течение нескольких рабочих дней.',
      successBrowseMore: 'Смотреть другие вакансии',
      apiErrorValidation:
        'Не удалось отправить отклик. Проверьте введённые данные и попробуйте снова.',
      apiErrorTooLarge: 'Файл резюме больше 5 МБ. Сожмите его и попробуйте снова.',
      apiErrorUnsupportedMedia: 'Резюме должно быть в формате PDF.',
      apiErrorDuplicate: 'Вы уже откликались на эту вакансию недавно.',
      apiErrorNetwork:
        'Не удалось отправить отклик. Проверьте введённые данные и попробуйте снова.',
    },
  },
  notFoundPage: {
    seoTitle: 'Страница не найдена — CheekyCheeseIT',
    seoDescription: 'Страница, которую вы ищете, не существует или была перемещена.',
    h1: 'Страница не найдена',
    body: 'Страница, которую вы ищете, не существует или была перемещена.',
    backHome: 'На главную',
  },
}
