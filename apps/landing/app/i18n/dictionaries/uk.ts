import type { Dictionary } from '../dictionary'

/**
 * `uk` — Ukrainian marketing copy. Own translation (task-landing-i18n.md:
 * "RU/UK копирайт: пиши сам, но качественно... требует вычитки владельцем"),
 * NOT a machine translation — terminology kept in English where a literal
 * translation reads worse (senior, remote, outstaffing, MLOps, LLM/RAG,
 * Kubernetes/Docker/AWS-style proper nouns). Key set MUST mirror `en.ts`
 * exactly (enforced by `__tests__/i18n.spec.ts`).
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
    tagline:
      'Аутсорс- та аутстафінг-студія — створюємо продукти в AI, EdTech і E-Commerce, готові до зростання.',
    studioHeading: 'Студія',
    selectedWork: 'Кейси',
    howWeWork: 'Як ми працюємо',
    companyHeading: 'Компанія',
    careers: 'Вакансії',
    aboutUs: 'Про нас',
    contact: 'Контакти',
    getInTouch: "Зв'язатися з нами",
    rights: '© 2026 CheekyCheeseIT. Усі права захищено.',
  },
  languageSwitcher: {
    label: 'Мова',
    names: { en: 'English', uk: 'Українська', ru: 'Русский', es: 'Español', pt: 'Português' },
  },
  home: {
    seoTitle: 'CheekyCheeseIT — senior-студія розробки для AI, EdTech і E-Commerce',
    seoDescription:
      'Senior-only інженерна студія для міжнародних продуктових компаній. Від моделі до вітрини — беремо на себе найскладніші частини, працюючи у вашому часовому поясі.',
    heroChip: 'Аутсорс і аутстафінг · AI · EdTech · E-Commerce',
    heroH1Line1: 'Ми створюємо продукти,',
    heroH1Highlight: 'що зростають.',
    heroParagraph:
      'Senior-only інженерна студія для міжнародних продуктових компаній. Від моделі до вітрини — беремо на себе найскладніші частини, працюючи у вашому часовому поясі.',
    ctaStartProject: 'Почати проєкт',
    ctaSeeRoles: 'Відкриті вакансії',
    aboutEyebrow: 'Про нас',
    aboutH2Line1: 'Невеликі команди,',
    aboutH2Line2: 'senior-руки.',
    aboutP1:
      'Ми — IT-студія, яка вбудовується в продуктову команду як її продовження — або бере мандат повністю, від початку до кінця. Жодних зайвих шарів і джуніорів, що навчаються за ваш кошт.',
    aboutP2:
      'Наш підхід свідомо вузький: три домени, які ми знаємо досконало, senior-інженери, що відповідають за результат, і щотижневі поставки — щоб прогрес було видно завжди. Ми залишаємось тихо в тіні чудових продуктів.',
    aboutBullets: [
      'Лише senior-фахівці',
      'Щотижневі, готові до постачання інкременти',
      'Відповідаємо за результат, а не за тікет',
      'Перетин часових поясів 4+ години',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Реалізованих проєктів' },
      { value: '15', suffix: '+', label: 'Продуктових клієнтів' },
      { value: '3', suffix: '+', label: 'Роки на ринку' },
      { value: '20', suffix: '+', label: 'Senior-інженерів' },
    ],
    workEyebrow: 'Кейси',
    workH2: 'Без імен, але по-справжньому.',
    workP:
      'За NDA ми не можемо називати клієнтів — але задачі, рішення й цифри саме такі, якими вони були насправді.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Платформа real-time інференсу для vision SaaS',
        challenge:
          'Затримка моделі під навантаженням перевищувала 400 мс, а витрати на інференс зростали швидше за виручку.',
        solution:
          'Перебудували шар обслуговування моделей: батчевий інференс на GPU, теплий кеш моделі та автоскейлінг за запитом.',
        metrics: [
          { value: '80', suffix: 'мс', label: 'p95 затримка' },
          { value: '-64', suffix: '%', label: 'Витрати на інференс' },
          { value: '5', suffix: '×', label: 'Пропускна здатність' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Платформа адаптивного навчання для мережі K-12 шкіл',
        challenge:
          'Єдина програма нудьгувала просунутим учням і не встигала за тими, хто відставав — завершуваність курсів падала.',
        solution:
          'Побудували рушій персональних траєкторій, що рекомендує наступний урок за актуальними сигналами засвоєння.',
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
          'Застарілий моноліт не витримував дні запусків; відмови від оформлення замовлення зростали з кожним уповільненням сторінки.',
        solution:
          'Перейшли на edge-рендеринг і headless-вітрину з ідемпотентним оформленням замовлення без простою.',
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
    servicesH2Line2: 'вивчені на практиці.',
    servicesP:
      'Ми йдемо вглиб, а не вшир. Кожен інженер студії постачав production-системи саме у своєму домені.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Прикладний AI & ML',
        description:
          'Платформи інференсу, RAG-пайплайни, рекомендаційні та vision-системи — швидкі, спостережувані й економічні в production.',
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
          'Адаптивне навчання, рушії оцінювання та інструменти для контенту — цікаві для учнів, вимірювані для організацій.',
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
          'Headless-вітрини, оформлення замовлення та склад у масштабі — стійкі в дні запусків і швидкі для покупців усюди.',
        bullets: ['Headless-вітрини', 'Edge-оформлення замовлення й платежі', 'Склад і фулфілмент'],
      },
    ],
    processEyebrow: 'Як ми працюємо',
    processH2Line1: 'Чотири кроки,',
    processH2Line2: 'без сюрпризів.',
    processSteps: [
      {
        stepNum: '01 / Discovery',
        title: 'Discovery',
        description:
          'Визначаємо межі задачі, знімаємо невідомі ризики та узгоджуємо план, за який тримаємо відповідь.',
      },
      {
        stepNum: '02 / Розробка',
        title: 'Розробка',
        description:
          'Senior-команди постачають щотижневі інкременти у вашому репозиторії та стеку, відкрито.',
      },
      {
        stepNum: '03 / Запуск',
        title: 'Запуск',
        description:
          'Випускаємо в production з моніторингом, навантажувальними тестами й відкатом, який вам не знадобиться.',
      },
      {
        stepNum: '04 / Підтримка',
        title: 'Підтримка',
        description:
          "Залишаємось на зв'язку надовго — продуктивність, надійність і наступна ітерація.",
      },
    ],
    techStackEyebrow: 'Технології',
    techStackH2: 'Інструменти, якими користуємось.',
    careersEyebrow: 'Вакансії',
    careersH2: 'Шукаємо senior-інженерів.',
    careersP:
      'Віддалено, лише senior, реальна відповідальність за результат. Якщо ви вже постачали складні речі в AI, EdTech чи комерції — нам є про що поговорити.',
    viewAllRoles: 'Усі вакансії',
    contactH2: 'Є складна задача, яку варто вирішити?',
    contactP:
      'Розкажіть, що ви будуєте. Ми відповімо протягом одного робочого дня — senior-фахівці, а не презентація продажів.',
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
    h1: 'Вирішуйте складні задачі разом із senior-командою.',
    p1: 'Віддалено, лише senior, реальна відповідальність за результат. Ми наймаємо повільно й тримаємо команди невеликими — кожна вакансія тут закриває справжню потребу.',
    p2: 'Перегляньте відкриті віддалені IT-вакансії нижче — кожна senior-роль тут це реальне місце в живій продуктовій команді, а не заявка "колись-небудь".',
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
