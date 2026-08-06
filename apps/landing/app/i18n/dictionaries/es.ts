import type { Dictionary } from '../dictionary'

/**
 * `es` — Spanish (base, no region — LatAm + Spain), WRITTEN in Spanish
 * (task-landing-copy-refactor.md §2 / skill `copywriting` §5), not translated
 * from `en.ts`:
 * Every heading carries the SAME claim as the English (registry:
 * `__tests__/heading-claims.ts`, with a test proving no heading escapes it);
 * only the wording is written per language.
 * Techniques, not quotes — a comment that restates the string below it is a
 * second source of truth and drifts on the first edit (it already did once
 * here):
 * - hero: the neuter «lo difícil» nominalises "the hard part", which English
 *   has no single word for. The cadence is a one-word adverb on purpose: a
 *   two-word phrase (456px) does not fit the 432px hero column, so
 *   `text-wrap: balance` splits the pair, whereas an unbreakable word widens
 *   the grid track instead.
 * - work: a sin/con pairing, where the English says "Anonymised, but real".
 * - services: the claim is hard-won experience, not just the count of
 *   domains — the paragraph below already states the count.
 *
 * Address form: **tú** throughout (tech/startup Spanish; decided once and
 * held everywhere, per skill `copywriting` §5). Industry terms stay in
 * English where the Spanish equivalent reads worse (senior, stack, headless,
 * checkout, MLOps, LLM/RAG). Key set MUST mirror `en.ts` exactly (enforced by
 * `__tests__/i18n.spec.ts`).
 */
export const es: Dictionary = {
  hiringStrip: {
    // review round 1 MED-1 — CLDR es only ever selects one/other (1 / rest);
    // `few`/`many` unused but filled for key-set parity (lib/plural.ts).
    text: {
      one: 'Estamos contratando — 1 posición abierta',
      few: 'Estamos contratando — {count} posiciones abiertas',
      many: 'Estamos contratando — {count} posiciones abiertas',
      other: 'Estamos contratando — {count} posiciones abiertas',
    },
    close: 'Cerrar',
  },
  nav: {
    services: 'Servicios',
    work: 'Proyectos',
    careers: 'Empleo',
    contact: 'Contacto',
    startProject: 'Iniciar un proyecto',
    toggleMenu: 'Abrir menú',
    primaryNav: 'Navegación principal',
    primaryMobileNav: 'Navegación principal (móvil)',
    brandHome: 'CheekyCheeseIT — inicio',
  },
  footer: {
    tagline: 'Ingenieros senior para AI, EdTech y E-Commerce',
    studioHeading: 'Estudio',
    selectedWork: 'Proyectos',
    howWeWork: 'Cómo trabajamos',
    companyHeading: 'Empresa',
    careers: 'Empleo',
    aboutUs: 'Sobre nosotros',
    contact: 'Contacto',
    getInTouch: 'Ponte en contacto',
    writeToUs: 'Escríbenos',
    rights: '© 2026 CheekyCheeseIT. Todos los derechos reservados.',
  },
  languageSwitcher: {
    label: 'Idioma',
    names: { en: 'English', uk: 'Українська', ru: 'Русский', es: 'Español', pt: 'Português' },
  },
  home: {
    seoTitle: 'CheekyCheeseIT — Ingenieros senior en AI, EdTech, E-Commerce',
    seoDescription:
      'Estudio de ingeniería solo-senior para empresas de producto internacionales. Outsourcing y outstaffing en AI, EdTech y E-Commerce, con entregas semanales.',
    heroChip: 'Outsourcing y outstaffing · AI · EdTech · E-Commerce',
    heroH1Line1: 'Lo difícil,',
    heroH1Highlight: 'semanalmente',
    // Revisión ronda 2 (HIGH-1): decía «Tres dominios que conocemos al
    // detalle» — un límite declarado por encima del pliegue y antes de la
    // sección de servicios, que ahora dice lo contrario. No repite el titular
    // («Cualquier dominio») a propósito: misma afirmación, otras palabras.
    heroParagraph:
      'Estudio de ingeniería solo-senior para empresas de producto internacionales. Sea cual sea tu dominio, 4+ horas de solape con tu jornada.',
    ctaStartProject: 'Iniciar un proyecto',
    ctaSeeRoles: 'Ver vacantes abiertas',
    aboutEyebrow: 'Sobre nosotros',
    aboutH2Line1: 'Equipo pequeño,',
    aboutH2Line2: 'sin juniors',
    aboutP1:
      'Nos integramos en tu equipo de producto como una extensión suya — o asumimos el encargo de principio a fin. En ambos casos hablas con quien escribe el código, no con un gestor de cuentas puesto delante.',
    aboutP2:
      'El enfoque es estrecho a propósito, y el trato es explícito: menos gente en la cuenta, toda senior, cada quien respondiendo por un resultado y no por una cola de tickets. Casi todo lo que construimos lleva el nombre de otro, y así nos gusta.',
    aboutBullets: [
      'Equipos solo-senior',
      'Un incremento entregable cada semana',
      'Resultados, no tickets',
      '4+ horas de solape horario',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Proyectos entregados' },
      { value: '15', suffix: '+', label: 'Clientes de producto' },
      { value: '3', suffix: '+', label: 'Años operando' },
      { value: '20', suffix: '+', label: 'Ingenieros senior' },
    ],
    workEyebrow: 'Proyectos',
    workH2: 'Sin nombres, con números',
    workP:
      'Los NDA dejan los logos fuera de esta página. Los problemas, las soluciones y las cifras son exactamente como ocurrieron.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Inferencia en tiempo real para un SaaS de visión',
        challenge:
          'Bajo carga, la latencia del modelo se iba por encima de 400ms y el costo de inferencia crecía más rápido que los ingresos.',
        solution:
          'Rehicimos la capa de serving: inferencia GPU por lotes, caché de modelo en caliente y autoescalado bajo demanda.',
        metrics: [
          { value: '80', suffix: 'ms', label: 'Latencia p95' },
          { value: '-64', suffix: '%', label: 'Costo de inferencia' },
          { value: '5', suffix: '×', label: 'Rendimiento' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Aprendizaje adaptativo para una red K-12',
        challenge:
          'Un solo plan de estudios para todos: los avanzados se aburrían y los rezagados no alcanzaban — la finalización caía.',
        solution:
          'Montamos un motor de rutas por alumno: la siguiente lección se elige según las señales de dominio del momento.',
        metrics: [
          { value: '+38', suffix: '%', label: 'Finalización' },
          { value: '120', suffix: 'k', label: 'Alumnos activos' },
          { value: '+22', suffix: '%', label: 'Retención' },
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'Tienda headless para una marca DTC global',
        challenge:
          'El monolito heredado se caía en días de lanzamiento y el abandono del checkout subía con cada pantalla lenta.',
        solution:
          'Migramos a una tienda headless renderizada en el edge, con checkout idempotente y sin ventanas de caída.',
        metrics: [
          { value: '1.2', suffix: 's', label: 'LCP global' },
          { value: '+27', suffix: '%', label: 'Conversión' },
          { value: '99.99', suffix: '%', label: 'Disponibilidad' },
        ],
      },
    ],
    challengeLabel: 'Desafío',
    solutionLabel: 'Solución',
    servicesEyebrow: 'Servicios',
    // task-domains-expansion — las dos mitades de la afirmación tienen que
    // llegar al español: cualquier dominio Y tres ya en producción. El
    // titular anterior («Tres dominios, aprendidos a golpes») prometía tres
    // y nada fuera de ellos.
    servicesH2Line1: 'Cualquier dominio,',
    // Ronda 2 (MED-2): «tres ya en producción» dejaba «producción» sola en una
    // tercera línea a 320 px (medido con `Range.getClientRects()`).
    //
    // Ronda 3: lo que sobraba era «ya», no «en producción». Medido de nuevo a
    // 320 / 375 / 768: «tres en producción» entra en dos líneas en las tres
    // anchuras, así que el español vuelve a la formulación que comparten las
    // otras cuatro locales — que era el sentido de tenerla. Igual que en
    // inglés, se cae el adverbio («ya» / «already»), no la afirmación:
    // ru/uk/pt sí lo conservan porque ahí sí cabe.
    servicesH2Line2: 'tres en producción',
    servicesP:
      'Lo difícil se repite de un sector a otro: latencia, modelo de datos, pagos, carga. Lo que cambia es el vocabulario, y eso lo aprendemos en discovery. En AI, EdTech y E-Commerce ya hemos llegado a producción; el resto lo tomamos igual.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'AI y ML aplicados',
        description:
          'Model serving para un SaaS de visión, pipelines RAG y sistemas de recomendación — rápidos, observables y sostenibles en costo una vez en producción.',
        bullets: [
          'Model serving y MLOps',
          'Aplicaciones LLM y RAG',
          'Pipelines de datos y features',
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Plataformas EdTech',
        description:
          'Rutas de aprendizaje adaptativo para una red de colegios K-12, motores de evaluación y herramientas de contenido — atractivos para el alumno y medibles para quien los paga.',
        bullets: [
          'Rutas de aprendizaje adaptativo',
          'Evaluación y analítica',
          'Autoría de contenido y LMS',
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'Sistemas de E-Commerce',
        description:
          'Una tienda headless para una marca DTC global, checkout e inventario a escala — aguantan los días de lanzamiento y siguen rápidos en cualquier parte.',
        bullets: ['Tiendas headless', 'Checkout y pagos en el edge', 'Inventario y fulfillment'],
      },
      // La cuarta tarjeta dice en voz alta lo de «no atados a un dominio».
      // Inventar un cuarto caso convertiría en mentira la promesa de la
      // sección «Trabajos»: ahí las cifras son exactamente las que fueron.
      {
        domain: 'neutral',
        domainLabel: 'Cualquier dominio',
        // Ronda 2 (LOW): «El dominio en el que estás» partía «estás» a una
        // segunda línea a 320 px. «Tu dominio» entra en una, y coincide con
        // ru/uk («Ваш домен»), que ya lo resolvían así.
        title: 'Tu dominio',
        description:
          'Aquí todavía no hay caso de estudio, y preferimos decirlo antes que inventarlo. Lo que sí se traslada es la práctica: discovery primero, un equipo solo-senior y algo entregable en la primera semana. Las tres tarjetas de al lado empezaron igual.',
        bullets: ['Discovery antes que código', 'Equipo solo-senior', 'Tu repositorio, tu stack'],
      },
    ],
    processEyebrow: 'Cómo trabajamos',
    processH2Line1: 'Cuatro pasos,',
    processH2Line2: 'sin caja negra',
    processSteps: [
      {
        stepNum: '01 / Discovery',
        title: 'Discovery',
        description:
          'Delimitamos el problema, reducimos los riesgos desconocidos y acordamos un plan del que respondemos.',
      },
      {
        stepNum: '02 / Desarrollo',
        title: 'Desarrollo',
        description:
          'Equipos senior entregan incrementos semanales en tu repositorio, en tu stack, a la vista.',
      },
      {
        stepNum: '03 / Lanzamiento',
        title: 'Lanzamiento',
        description:
          'Publicamos a producción con monitoreo, pruebas de carga y un rollback que nunca vas a necesitar.',
      },
      {
        stepNum: '04 / Soporte',
        title: 'Soporte',
        description:
          'Nos quedamos a largo plazo — rendimiento, fiabilidad y la siguiente iteración.',
      },
    ],
    techStackEyebrow: 'Stack tecnológico',
    techStackH2: 'El stack por defecto',
    careersEyebrow: 'Empleo',
    careersH2: 'Responsabilidad desde la primera semana',
    careersP:
      'Contratamos a gente que ya ha entregado cosas difíciles en AI, EdTech o comercio. En remoto, y con equipos lo bastante pequeños como para que nada de lo que hagas se pierda en un backlog — si te suena, hablemos.',
    viewAllRoles: 'Ver todas las vacantes',
    contactH2: '¿Un problema difícil sin dueño?',
    contactP:
      'Cuéntanos qué estás construyendo. Te respondemos en un día hábil — ingenieros, no un equipo comercial.',
    terminalAriaLabel:
      'Editor de código animado mostrando el código de proyectos de CheekyCheeseIT en AI, EdTech y E-Commerce',
    contactForm: {
      nameLabel: 'Nombre',
      namePlaceholder: 'Ada Lovelace',
      companyLabel: 'Empresa',
      companyPlaceholder: 'Acme Inc. (opcional)',
      emailLabel: 'Email',
      emailPlaceholder: 'you@company.com',
      messageLabel: '¿Qué estás construyendo?',
      messagePlaceholder: 'Cuéntanos sobre el problema, el plazo y el equipo que tienes hoy.',
      submit: 'Enviar mensaje',
      submitting: 'Enviando…',
      protectedBy: 'Protegido por captcha invisible — sin acertijos.',
      orEmailUs: 'o escríbenos directamente a',
      errorName: 'Por favor, ingresa tu nombre.',
      errorEmail: 'Ingresa un email válido.',
      errorMessage: 'Cuéntanos un poco más (al menos 10 caracteres).',
      successHeading: 'Mensaje recibido',
      successBody: 'Gracias — lo hemos recibido y responderemos en un día hábil.',
      apiErrorValidation:
        'Algo salió mal al enviar tu mensaje. Revisa tus datos e inténtalo de nuevo.',
      apiErrorTurnstile: 'La verificación "no soy un robot" no se completó — inténtalo de nuevo.',
      apiErrorTurnstileRepeat:
        'La verificación "no soy un robot" volvió a fallar. Inténtalo una vez más, o escríbenos directamente a',
      apiErrorRateLimited:
        'Has enviado varios mensajes recientemente — inténtalo de nuevo en un rato, o escríbenos directamente.',
      apiErrorUnavailable:
        'El formulario no está disponible temporalmente — escríbenos directamente.',
      apiErrorNetwork:
        'Algo salió mal al enviar tu mensaje. Revisa tus datos e inténtalo de nuevo.',
    },
  },
  careers: {
    seoTitle: 'Empleo — CheekyCheeseIT',
    seoDescription:
      'Vacantes senior abiertas en CheekyCheeseIT — remoto, solo senior, con responsabilidad real.',
    eyebrow: 'Empleo',
    h1: 'Problemas difíciles, colegas senior',
    p1: 'Contratamos despacio y mantenemos los equipos pequeños, así que cada vacante aquí cubre una necesidad real. En remoto, y la responsabilidad es de verdad: respondes por el resultado, no por una cola de tickets.',
    p2: 'Abajo están las vacantes remotas abiertas. Cada puesto senior es un asiento real en un equipo de producto activo, no una requisición para algún día.',
    emptyTitle: 'No hay vacantes abiertas por ahora',
    emptyBody:
      'Contratamos por oleadas y ahora estamos entre ellas. Envía tu CV de todos modos — guardamos cada perfil sólido y te contactamos en cuanto encaje algo.',
  },
  vacancyCard: {
    viewRole: 'Ver vacante',
  },
  vacancy: {
    notFoundSeoTitle: 'Vacante no encontrada — CheekyCheeseIT Careers',
    notFoundSeoDescription: 'Esta vacante ya no está disponible.',
    notFoundH1: 'Vacante no encontrada',
    notFoundBody: 'Esta vacante ya no está abierta — pero puede haber otras.',
    backToCareers: 'Volver a empleo',
    allRoles: 'Todas las vacantes',
    // La jerga del sector no se traduce (skill `copywriting` §5: FinTech,
    // SaaS, iGaming se usan tal cual); las palabras corrientes con
    // equivalente natural en español, sí.
    domainLabels: {
      AI: 'AI / ML',
      EDTECH: 'EdTech',
      ECOMMERCE: 'E-Commerce',
      FINTECH: 'FinTech',
      IGAMING: 'iGaming',
      // Ronda 2 (MED-3): «Adult» es una palabra corriente con equivalente
      // natural, como Travel/Media/Logistics — se traduce.
      ADULT: 'Contenido adulto',
      SAAS: 'SaaS',
      HEALTHTECH: 'HealthTech',
      ADTECH: 'AdTech',
      LOGISTICS: 'Logística',
      PROPTECH: 'PropTech',
      TRAVEL: 'Viajes',
      MEDIA: 'Medios',
      WEB3: 'Web3',
      HRTECH: 'HR Tech',
      CYBERSEC: 'Ciberseguridad',
      OTHER: 'Otro',
    },
    employmentTypeLabels: {
      FULL_TIME: 'Tiempo completo',
      PART_TIME: 'Tiempo parcial',
      CONTRACT: 'Contrato',
    },
    salaryPeriodLabels: {
      HOUR: 'por hora',
      DAY: 'por día',
      WEEK: 'por semana',
      MONTH: 'por mes',
      YEAR: 'por año',
    },
    breadcrumbHome: 'Inicio',
    breadcrumbCareers: 'Empleo',
    titleSuffix: 'CheekyCheeseIT Careers',
    relatedHeading: 'Puestos similares',
    apply: {
      heading: 'Postularte a esta vacante',
      subheading: 'Toma unos 3 minutos. Los campos con * son obligatorios.',
      requiredNote: 'obligatorio',
      fullNameLabel: 'Nombre completo',
      emailLabel: 'Email',
      telegramLabel: 'Telegram',
      linkedinLabel: 'URL de LinkedIn',
      githubLabel: 'URL de GitHub',
      coverLetterLabel: 'Carta de presentación',
      namePlaceholder: 'Ada Lovelace',
      emailPlaceholder: 'you@domain.com',
      telegramPlaceholder: '@handle',
      linkedinPlaceholder: 'linkedin.com/in/…',
      githubPlaceholder: 'github.com/…',
      coverPlaceholder:
        'Cuéntanos sobre algo difícil que hayas entregado y qué te gustaría construir aquí.',
      cvLabel: 'CV / Currículum',
      cvDropPrefix: 'Suelta tu CV aquí, o',
      cvBrowse: 'explora',
      cvHint: 'Solo PDF · hasta 5 MB',
      cvRemoveAriaLabel: 'Eliminar archivo',
      errorName: 'Por favor ingresa tu nombre.',
      errorEmail: 'Ingresa un email válido.',
      errorLinkedin: 'Ingresa una URL de LinkedIn válida (https://…).',
      errorGithub: 'Ingresa una URL de GitHub válida (https://…).',
      errorFile: 'Por favor adjunta tu CV (PDF).',
      cvInvalidType: 'El CV debe ser un archivo PDF.',
      cvTooLarge: 'El archivo supera los 5 MB.',
      submit: 'Enviar postulación',
      submitting: 'Enviando…',
      processing: 'Procesando…',
      protectedBy: 'Protegido por captcha invisible — sin acertijos, nunca.',
      successHeading: 'Postulación recibida',
      successThanks: 'Gracias',
      successBodyBefore: '— recibimos tu postulación para',
      successBodyAfter: '. Revisamos cada una y respondemos en unos días hábiles.',
      successBrowseMore: 'Ver más vacantes',
      apiErrorValidation:
        'Algo salió mal al enviar tu postulación. Revisa tus datos e inténtalo de nuevo.',
      apiErrorTooLarge: 'Tu archivo de CV supera los 5 MB. Comprímelo e inténtalo de nuevo.',
      apiErrorUnsupportedMedia: 'Tu CV debe ser un archivo PDF válido.',
      apiErrorDuplicate: 'Ya te postulaste a esta vacante recientemente.',
      apiErrorNetwork:
        'Algo salió mal al enviar tu postulación. Revisa tus datos e inténtalo de nuevo.',
    },
  },
  notFoundPage: {
    seoTitle: 'Página no encontrada — CheekyCheeseIT',
    seoDescription: 'La página que buscas no existe o fue movida.',
    h1: 'Página no encontrada',
    body: 'La página que buscas no existe o fue movida.',
    backHome: 'Volver al inicio',
  },
}
