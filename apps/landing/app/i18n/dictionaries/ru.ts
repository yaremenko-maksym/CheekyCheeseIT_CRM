import type { Dictionary } from '../dictionary'

/**
 * `ru` — Russian marketing copy. Own translation (task-landing-i18n.md:
 * "RU/UK копирайт: пиши сам, но качественно... требует вычитки владельцем"),
 * NOT a machine translation — terminology kept in English where a literal
 * translation reads worse (senior, remote, outstaffing, MLOps, LLM/RAG,
 * Kubernetes/Docker/AWS-style proper nouns). Key set MUST mirror `en.ts`
 * exactly (enforced by `__tests__/i18n.spec.ts`).
 */
export const ru: Dictionary = {
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
    tagline:
      'Аутсорс- и аутстаффинг-студия — создаём продукты в AI, EdTech и E-Commerce, готовые к росту.',
    studioHeading: 'Студия',
    selectedWork: 'Кейсы',
    howWeWork: 'Как мы работаем',
    companyHeading: 'Компания',
    careers: 'Вакансии',
    aboutUs: 'О нас',
    contact: 'Контакты',
    getInTouch: 'Связаться с нами',
    rights: '© 2026 CheekyCheeseIT. Все права защищены.',
  },
  languageSwitcher: {
    label: 'Язык',
    names: { en: 'English', uk: 'Українська', ru: 'Русский', es: 'Español', pt: 'Português' },
  },
  home: {
    seoTitle: 'CheekyCheeseIT — senior-студия разработки для AI, EdTech и E-Commerce',
    seoDescription:
      'Senior-only инженерная студия для международных продуктовых компаний. От модели до витрины — берём на себя самые сложные части, работая в вашем часовом поясе.',
    heroChip: 'Аутсорс и аутстаффинг · AI · EdTech · E-Commerce',
    heroH1Line1: 'Мы создаём продукты,',
    heroH1Highlight: 'которые растут.',
    heroParagraph:
      'Senior-only инженерная студия для международных продуктовых компаний. От модели до витрины — берём на себя самые сложные части, работая в вашем часовом поясе.',
    ctaStartProject: 'Начать проект',
    ctaSeeRoles: 'Открытые вакансии',
    aboutEyebrow: 'О нас',
    aboutH2Line1: 'Небольшие команды,',
    aboutH2Line2: 'senior-руки.',
    aboutP1:
      'Мы — IT-студия, которая встраивается в продуктовую команду как её продолжение — или берёт мандат целиком, от начала до конца. Никаких лишних слоёв и джуниоров, обучающихся за ваш счёт.',
    aboutP2:
      'Наш подход сознательно узкий: три домена, которые мы знаем досконально, senior-инженеры, отвечающие за результат, и еженедельные поставки — чтобы прогресс был виден всегда. Мы остаёмся тихо в тени отличных продуктов.',
    aboutBullets: [
      'Только senior-специалисты',
      'Еженедельные, готовые к поставке инкременты',
      'Отвечаем за результат, а не за тикет',
      'Пересечение часовых поясов 4+ часа',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Реализованных проектов' },
      { value: '15', suffix: '+', label: 'Продуктовых клиентов' },
      { value: '3', suffix: '+', label: 'Года на рынке' },
      { value: '20', suffix: '+', label: 'Senior-инженеров' },
    ],
    workEyebrow: 'Кейсы',
    workH2: 'Без имён, но по-настоящему.',
    workP:
      'По NDA мы не можем называть клиентов — но задачи, решения и цифры именно такие, какими они были на самом деле.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Платформа real-time инференса для vision SaaS',
        challenge:
          'Задержка модели под нагрузкой превышала 400 мс, а расходы на инференс росли быстрее выручки.',
        solution:
          'Пересобрали слой обслуживания моделей: батчевый инференс на GPU, тёплый кэш модели и автоскейлинг по запросу.',
        metrics: [
          { value: '80', suffix: 'мс', label: 'p95 задержка' },
          { value: '-64', suffix: '%', label: 'Расходы на инференс' },
          { value: '5', suffix: '×', label: 'Пропускная способность' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Платформа адаптивного обучения для сети K-12 школ',
        challenge:
          'Единая программа скучала продвинутым ученикам и не поспевала за отстающими — завершаемость курсов падала.',
        solution:
          'Построили движок персональных траекторий, который рекомендует следующий урок по актуальным сигналам усвоения.',
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
          'Устаревший монолит не выдерживал дни запусков; отказы от оформления заказа росли с каждым замедлением страницы.',
        solution:
          'Перешли на edge-рендеринг и headless-витрину с идемпотентным оформлением заказа без простоя.',
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
    servicesH2Line1: 'Три домена,',
    servicesH2Line2: 'изученных на практике.',
    servicesP:
      'Мы идём вглубь, а не вширь. Каждый инженер студии поставлял production-системы именно в своём домене.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Прикладной AI & ML',
        description:
          'Платформы инференса, RAG-пайплайны, рекомендательные и vision-системы — быстрые, наблюдаемые и экономичные в production.',
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
          'Адаптивное обучение, движки оценивания и инструменты для контента — увлекательные для учеников, измеримые для организаций.',
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
          'Headless-витрины, оформление заказа и склад в масштабе — устойчивые в дни запусков и быстрые для покупателей везде.',
        bullets: ['Headless-витрины', 'Edge-оформление заказа и платежи', 'Склад и фулфилмент'],
      },
    ],
    processEyebrow: 'Как мы работаем',
    processH2Line1: 'Четыре шага,',
    processH2Line2: 'без сюрпризов.',
    processSteps: [
      {
        stepNum: '01 / Discovery',
        title: 'Discovery',
        description:
          'Определяем границы задачи, снимаем неизвестные риски и согласуем план, за который держим ответ.',
      },
      {
        stepNum: '02 / Разработка',
        title: 'Разработка',
        description:
          'Senior-команды поставляют еженедельные инкременты в вашем репозитории и стеке, открыто.',
      },
      {
        stepNum: '03 / Запуск',
        title: 'Запуск',
        description:
          'Выпускаем в production с мониторингом, нагрузочными тестами и откатом, который вам не понадобится.',
      },
      {
        stepNum: '04 / Поддержка',
        title: 'Поддержка',
        description:
          'Остаёмся на связи надолго — производительность, надёжность и следующая итерация.',
      },
    ],
    techStackEyebrow: 'Технологии',
    techStackH2: 'Инструменты, которыми пользуемся.',
    careersEyebrow: 'Вакансии',
    careersH2: 'Ищем senior-инженеров.',
    careersP:
      'Удалённо, только senior, реальная ответственность за результат. Если вы уже поставляли сложные вещи в AI, EdTech или коммерции — нам есть о чём поговорить.',
    viewAllRoles: 'Все вакансии',
    contactH2: 'Есть сложная задача, которую стоит решить?',
    contactP:
      'Расскажите, что вы строите. Мы ответим в течение одного рабочего дня — senior-специалисты, а не презентация продаж.',
    terminalAriaLabel:
      'Анимированный редактор кода с примерами проектов CheekyCheeseIT в AI, EdTech и E-Commerce',
  },
  careers: {
    seoTitle: 'Вакансии — CheekyCheeseIT',
    seoDescription:
      'Открытые senior-вакансии в CheekyCheeseIT — удалённо, только senior, реальная ответственность за результат.',
    eyebrow: 'Вакансии',
    h1: 'Решайте сложные задачи вместе с senior-командой.',
    p1: 'Удалённо, только senior, реальная ответственность за результат. Мы нанимаем медленно и держим команды небольшими — каждая вакансия здесь закрывает настоящую потребность.',
    p2: 'Смотрите открытые удалённые IT-вакансии ниже — каждая senior-роль здесь это реальное место в живой продуктовой команде, а не заявка «когда-нибудь».',
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
    domainLabels: { AI: 'AI / ML', EDTECH: 'EdTech', ECOMMERCE: 'E-Commerce', OTHER: 'Другое' },
    employmentTypeLabels: {
      FULL_TIME: 'Полная занятость',
      PART_TIME: 'Частичная занятость',
      CONTRACT: 'Контракт',
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
