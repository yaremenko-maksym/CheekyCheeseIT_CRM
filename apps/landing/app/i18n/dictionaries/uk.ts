import type { Dictionary } from '../dictionary'

/**
 * `uk` — Ukrainian copy, WRITTEN in Ukrainian (task-landing-copy-refactor.md
 * §2 / skill `copywriting` §5). Written independently of BOTH `en.ts` and
 * `ru.ts` — uk and ru are close enough that mirroring the Russian would be
 * the same calque problem one language over, so the headings use their own
 * Ukrainian idiom:
 * - hero: «Складне — щотижня» keeps the delivery cadence that Ukrainian can
 *   state in two words, where the Russian hero goes for «Сложное — наше
 *   дело» instead. Same brief, different sentence per language.
 * - about: «без зайвих ланок» — a chain-link metaphor natural to Ukrainian
 *   (ru uses «прослойка», en "no layers").
 * - work: «Без імен, але з цифрами» — a "without X, with Y" pairing, not the
 *   Russian ellipsis «Имён нет — цифры есть».
 *
 * Address form: «ви» зі рядкової. Industry terms stay in English where the
 * Ukrainian equivalent reads like a textbook (senior, production, headless,
 * MLOps, LLM/RAG). Key set MUST mirror `en.ts` exactly (enforced by
 * `__tests__/i18n.spec.ts`).
 */
export const uk: Dictionary = {
  hiringStrip: {
    // review round 1 MED-1 — CLDR one/few/many (same category structure as
    // ru — see lib/plural.ts).
    text: {
      one: 'Ми наймаємо — {count} відкрита позиція',
      few: 'Ми наймаємо — {count} відкриті позиції',
      many: 'Ми наймаємо — {count} відкритих позицій',
      other: 'Ми наймаємо — {count} відкритих позицій',
    },
    close: 'Закрити',
  },
  nav: {
    services: 'Послуги',
    work: 'Кейси',
    careers: 'Вакансії',
    contact: 'Контакти',
    startProject: 'Почати проєкт',
    toggleMenu: 'Відкрити меню',
    primaryNav: 'Основна навігація',
    primaryMobileNav: 'Основна навігація (мобільна)',
    brandHome: 'CheekyCheeseIT — на головну',
  },
  footer: {
    tagline: 'Senior-інженери для AI, EdTech і E-Commerce',
    studioHeading: 'Студія',
    selectedWork: 'Кейси',
    howWeWork: 'Як ми працюємо',
    companyHeading: 'Компанія',
    careers: 'Вакансії',
    aboutUs: 'Про нас',
    contact: 'Контакти',
    getInTouch: "Зв'язатися з нами",
    writeToUs: 'Написати нам',
    rights: '© 2026 CheekyCheeseIT. Усі права захищено.',
  },
  languageSwitcher: {
    label: 'Мова',
    names: { en: 'English', uk: 'Українська', ru: 'Русский', es: 'Español', pt: 'Português' },
  },
  home: {
    seoTitle: 'CheekyCheeseIT — senior-команди для AI, EdTech, E-Commerce',
    seoDescription:
      'Senior-only студія розробки для міжнародних продуктових команд. Аутсорс і аутстафінг в AI, EdTech і E-Commerce — робочий результат щотижня.',
    heroChip: 'Аутсорс і аутстафінг · AI · EdTech · E-Commerce',
    heroH1Line1: 'Складне —',
    heroH1Highlight: 'щотижня',
    heroParagraph:
      'Senior-only студія для міжнародних продуктових команд. Три домени, які знаємо досконало, і 4+ години перетину з вашим робочим днем.',
    ctaStartProject: 'Почати проєкт',
    ctaSeeRoles: 'Відкриті вакансії',
    aboutEyebrow: 'Про нас',
    aboutH2Line1: 'Малі команди,',
    aboutH2Line2: 'без джуніорів',
    aboutP1:
      'Вбудовуємось у вашу продуктову команду як її частина — або беремо задачу цілком. У будь-якому разі ви спілкуєтесь із тими, хто пише код, а не з акаунт-менеджером перед ними.',
    aboutP2:
      'Підхід свідомо вузький: три домени, senior-інженери, що відповідають за результат, і робочий інкремент щотижня. Більшість того, що ми побудували, носить чуже ім’я — нас це влаштовує.',
    aboutBullets: [
      'Тільки senior-інженери',
      'Робочий інкремент щотижня',
      'Відповідаємо за результат, а не за тікет',
      '4+ години перетину в часі',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Реалізованих проєктів' },
      { value: '15', suffix: '+', label: 'Продуктових клієнтів' },
      { value: '3', suffix: '+', label: 'Роки на ринку' },
      { value: '20', suffix: '+', label: 'Senior-інженерів' },
    ],
    workEyebrow: 'Кейси',
    workH2: 'Без імен, але з цифрами',
    workP: 'NDA не дає назвати клієнтів. Задачі, рішення й цифри — рівно ті, що були насправді.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Real-time інференс для vision SaaS',
        challenge:
          'Під навантаженням затримка моделі виходила за 400 мс, а витрати на інференс росли швидше за виручку.',
        solution:
          'Перебудували шар обслуговування: батчевий інференс на GPU, теплий кеш моделі та автоскейлінг за запитом.',
        metrics: [
          { value: '80', suffix: 'мс', label: 'p95 затримка' },
          { value: '-64', suffix: '%', label: 'Витрати на інференс' },
          { value: '5', suffix: '×', label: 'Пропускна здатність' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Адаптивне навчання для мережі K-12',
        challenge:
          'Одна програма на всіх: сильним нудно, ті, хто відстає, не наздоганяють — завершуваність падала.',
        solution:
          'Зібрали рушій персональних траєкторій: наступний урок добирається за поточними сигналами засвоєння.',
        metrics: [
          { value: '+38', suffix: '%', label: 'Завершуваність' },
          { value: '120', suffix: 'к', label: 'Активних учнів' },
          { value: '+22', suffix: '%', label: 'Утримання' },
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'Headless-вітрина для глобального DTC-бренду',
        challenge:
          'Старий моноліт лягав у дні запусків, а покинутих кошиків ставало більше з кожним екраном, що гальмував.',
        solution:
          'Перевели на headless-вітрину з рендерингом на edge та ідемпотентним оформленням замовлення без простою.',
        metrics: [
          { value: '1.2', suffix: 'с', label: 'LCP по світу' },
          { value: '+27', suffix: '%', label: 'Конверсія' },
          { value: '99.99', suffix: '%', label: 'Аптайм' },
        ],
      },
    ],
    challengeLabel: 'Задача',
    solutionLabel: 'Рішення',
    servicesEyebrow: 'Послуги',
    servicesH2Line1: 'Три домени,',
    servicesH2Line2: 'і жодного більше',
    servicesP:
      'Ідемо вглиб, а не вшир. Кожен інженер студії вже вів production-системи у своєму домені.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Прикладний AI & ML',
        description:
          'Платформи інференсу, RAG-пайплайни, рекомендаційні та vision-системи — швидкі, спостережувані й посильні за грошима в production.',
        bullets: [
          'Обслуговування моделей і MLOps',
          'LLM- і RAG-застосунки',
          'Пайплайни даних і ознак',
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'EdTech-платформи',
        description:
          'Адаптивне навчання, рушії оцінювання та інструменти для контенту — цікаві учневі й вимірювані для тих, хто за це платить.',
        bullets: [
          'Адаптивні траєкторії навчання',
          'Оцінювання та аналітика',
          'Авторинг і LMS-інструменти',
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'E-Commerce системи',
        description:
          'Headless-вітрини, оформлення замовлення та склад під навантаженням — тримають дні запусків і лишаються швидкими будь-де.',
        bullets: ['Headless-вітрини', 'Edge-оформлення замовлення й платежі', 'Склад і фулфілмент'],
      },
    ],
    processEyebrow: 'Як ми працюємо',
    processH2Line1: 'Чотири кроки,',
    processH2Line2: 'усе на видноті',
    processSteps: [
      {
        stepNum: '01 / Discovery',
        title: 'Discovery',
        description:
          'Окреслюємо задачу, знімаємо невідомі ризики та узгоджуємо план, за який відповідаємо.',
      },
      {
        stepNum: '02 / Розробка',
        title: 'Розробка',
        description:
          'Senior-команди постачають інкременти щотижня — у вашому репозиторії, у вашому стеку, відкрито.',
      },
      {
        stepNum: '03 / Запуск',
        title: 'Запуск',
        description:
          'Викочуємо в production з моніторингом, навантажувальними тестами й відкатом, який вам не знадобиться.',
      },
      {
        stepNum: '04 / Підтримка',
        title: 'Підтримка',
        description: 'Лишаємось надовго — продуктивність, надійність і наступна ітерація.',
      },
    ],
    techStackEyebrow: 'Технології',
    techStackH2: 'Наш типовий стек',
    careersEyebrow: 'Вакансії',
    careersH2: 'Наймаємо інженерів рівня senior',
    careersP:
      'Беремо тих, за ким уже є складні проєкти в AI, EdTech або e-commerce. Віддалено, з реальною відповідальністю з першого тижня — якщо це про вас, поговорімо.',
    viewAllRoles: 'Усі вакансії',
    contactH2: 'Є задача, яку нема кому взяти?',
    contactP:
      'Розкажіть, що ви будуєте. Відповімо протягом одного робочого дня — інженери, а не відділ продажів.',
    terminalAriaLabel:
      'Анімований редактор коду з прикладами проєктів CheekyCheeseIT в AI, EdTech і E-Commerce',
    contactForm: {
      nameLabel: "Ім'я",
      namePlaceholder: 'Ada Lovelace',
      companyLabel: 'Компанія',
      companyPlaceholder: 'Acme Inc. (необов’язково)',
      emailLabel: 'Email',
      emailPlaceholder: 'you@company.com',
      messageLabel: 'Що ви будуєте?',
      messagePlaceholder: 'Розкажіть про задачу, терміни та команду, яка у вас є зараз.',
      submit: 'Надіслати повідомлення',
      submitting: 'Надсилаємо…',
      protectedBy: 'Захищено невидимою капчею — без головоломок.',
      orEmailUs: 'або напишіть нам напряму на',
      errorName: "Будь ласка, введіть ім'я.",
      errorEmail: 'Введіть коректний email.',
      errorMessage: 'Розкажіть трохи детальніше (мінімум 10 символів).',
      successHeading: 'Повідомлення отримано',
      successBody: 'Дякуємо — ми отримали його і відповімо протягом одного робочого дня.',
      apiErrorValidation:
        'Не вдалося надіслати повідомлення. Перевірте введені дані та спробуйте ще раз.',
      apiErrorTurnstile: 'Перевірка «я не робот» не пройшла — спробуйте ще раз.',
      apiErrorTurnstileRepeat:
        'Перевірка «я не робот» знову не пройшла. Спробуйте ще раз або напишіть нам напряму на',
      apiErrorRateLimited:
        'Ви нещодавно вже надсилали повідомлення — спробуйте трохи пізніше або напишіть нам напряму.',
      apiErrorUnavailable: 'Форма тимчасово недоступна — напишіть нам напряму.',
      apiErrorNetwork:
        'Не вдалося надіслати повідомлення. Перевірте введені дані та спробуйте ще раз.',
    },
  },
  careers: {
    seoTitle: 'Вакансії — CheekyCheeseIT',
    seoDescription:
      'Відкриті senior-вакансії в CheekyCheeseIT — віддалено, лише senior, реальна відповідальність за результат.',
    eyebrow: 'Вакансії',
    h1: 'Складні задачі та сильна команда',
    p1: 'Наймаємо повільно й тримаємо команди невеликими, тому кожна вакансія тут закриває справжню потребу. Віддалено, з реальною відповідальністю: ви відповідаєте за результат, а не за чергу тікетів.',
    p2: 'Нижче — відкриті віддалені вакансії. Кожна senior-роль тут — це живе місце в робочій продуктовій команді, а не заявка «колись-небудь».',
    emptyTitle: 'Зараз відкритих вакансій немає',
    emptyBody:
      "Ми наймаємо хвилями і зараз між ними. Все одно надішліть резюме — ми зберігаємо кожен сильний профіль і напишемо, щойно з'явиться підхожа роль.",
  },
  vacancyCard: {
    viewRole: 'Дивитись вакансію',
  },
  vacancy: {
    notFoundSeoTitle: 'Вакансію не знайдено — CheekyCheeseIT Careers',
    notFoundSeoDescription: 'Ця вакансія більше недоступна.',
    notFoundH1: 'Вакансію не знайдено',
    notFoundBody: 'Ця вакансія вже закрита — але, можливо, є інші.',
    backToCareers: 'До всіх вакансій',
    allRoles: 'Усі вакансії',
    domainLabels: { AI: 'AI / ML', EDTECH: 'EdTech', ECOMMERCE: 'E-Commerce', OTHER: 'Інше' },
    employmentTypeLabels: {
      FULL_TIME: 'Повна зайнятість',
      PART_TIME: 'Часткова зайнятість',
      CONTRACT: 'Контракт',
    },
    salaryPeriodLabels: {
      HOUR: 'на годину',
      DAY: 'на день',
      WEEK: 'на тиждень',
      MONTH: 'на місяць',
      YEAR: 'на рік',
    },
    breadcrumbHome: 'Головна',
    breadcrumbCareers: 'Вакансії',
    titleSuffix: 'CheekyCheeseIT Careers',
    relatedHeading: 'Схожі вакансії',
    apply: {
      heading: 'Відгукнутися на вакансію',
      subheading: "Займе близько 3 хвилин. Поля з * обов'язкові.",
      requiredNote: "обов'язково",
      fullNameLabel: "Ім'я та прізвище",
      emailLabel: 'Email',
      telegramLabel: 'Telegram',
      linkedinLabel: 'Посилання на LinkedIn',
      githubLabel: 'Посилання на GitHub',
      coverLetterLabel: 'Супровідний лист',
      namePlaceholder: 'Ada Lovelace',
      emailPlaceholder: 'you@domain.com',
      telegramPlaceholder: '@handle',
      linkedinPlaceholder: 'linkedin.com/in/…',
      githubPlaceholder: 'github.com/…',
      coverPlaceholder:
        'Розкажіть про складну задачу, яку ви вирішували, і що хотіли б будувати у нас.',
      cvLabel: 'Резюме (CV)',
      cvDropPrefix: 'Перетягніть резюме сюди або',
      cvBrowse: 'оберіть файл',
      cvHint: 'Лише PDF · до 5 МБ',
      cvRemoveAriaLabel: 'Видалити файл',
      errorName: "Будь ласка, вкажіть ім'я.",
      errorEmail: 'Введіть коректний email.',
      errorLinkedin: 'Введіть коректне посилання на LinkedIn (https://…).',
      errorGithub: 'Введіть коректне посилання на GitHub (https://…).',
      errorFile: 'Будь ласка, прикріпіть резюме (PDF).',
      cvInvalidType: 'Резюме має бути у форматі PDF.',
      cvTooLarge: 'Файл більший за 5 МБ.',
      submit: 'Надіслати відгук',
      submitting: 'Надсилаємо…',
      protectedBy: 'Захищено невидимою капчею — без головоломок.',
      successHeading: 'Відгук отримано',
      successThanks: 'Дякуємо',
      successBodyBefore: '— ми отримали ваш відгук на позицію',
      successBodyAfter: '. Розглядаємо кожен відгук і відповімо протягом кількох робочих днів.',
      successBrowseMore: 'Переглянути інші вакансії',
      apiErrorValidation:
        'Не вдалося надіслати відгук. Перевірте введені дані та спробуйте ще раз.',
      apiErrorTooLarge: 'Файл резюме більший за 5 МБ. Стисніть його і спробуйте ще раз.',
      apiErrorUnsupportedMedia: 'Резюме має бути у форматі PDF.',
      apiErrorDuplicate: 'Ви вже відгукувались на цю вакансію нещодавно.',
      apiErrorNetwork: 'Не вдалося надіслати відгук. Перевірте введені дані та спробуйте ще раз.',
    },
  },
  notFoundPage: {
    seoTitle: 'Сторінку не знайдено — CheekyCheeseIT',
    seoDescription: 'Сторінка, яку ви шукаєте, не існує або була переміщена.',
    h1: 'Сторінку не знайдено',
    body: 'Сторінка, яку ви шукаєте, не існує або була переміщена.',
    backHome: 'На головну',
  },
}
