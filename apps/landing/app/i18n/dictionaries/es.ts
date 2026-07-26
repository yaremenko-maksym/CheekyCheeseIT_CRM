import type { Dictionary } from '../dictionary'

/**
 * `es` — Spanish (base, no region — LatAm + Spain, plan §1) marketing copy.
 * Own translation (task-landing-i18n.md: "копирайт: пиши сам, но
 * качественно... требует вычитки владельцем"), NOT a machine translation —
 * terminology kept in English where a literal translation reads worse
 * (senior, remote, outstaffing, MLOps, LLM/RAG, Kubernetes/Docker/AWS-style
 * proper nouns). Key set MUST mirror `en.ts` exactly (enforced by
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
    tagline:
      'Un estudio de outsourcing y outstaffing que construye productos de AI, EdTech y E-Commerce listos para escalar.',
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
    seoTitle: 'CheekyCheeseIT — Estudio de ingeniería senior para AI, EdTech y E-Commerce',
    seoDescription:
      'Un estudio de ingeniería solo-senior para empresas de producto internacionales. Del modelo al escaparate — resolvemos las partes difíciles, en tu franja horaria.',
    heroChip: 'Outsourcing y outstaffing · AI · EdTech · E-Commerce',
    heroH1Line1: 'Construimos productos',
    heroH1Highlight: 'que escalan.',
    heroParagraph:
      'Un estudio de ingeniería solo-senior para empresas de producto internacionales. Del modelo al escaparate — resolvemos las partes difíciles, en tu franja horaria.',
    ctaStartProject: 'Iniciar un proyecto',
    ctaSeeRoles: 'Ver vacantes abiertas',
    aboutEyebrow: 'Sobre nosotros',
    aboutH2Line1: 'Equipos pequeños,',
    aboutH2Line2: 'manos senior.',
    aboutP1:
      'Somos un estudio de IT que se integra en la empresa de producto como una extensión de su equipo — o asume un mandato de principio a fin. Sin capas de más, sin juniors aprendiendo a costa de tu presupuesto.',
    aboutP2:
      'Nuestro enfoque es deliberadamente estrecho: tres dominios que conocemos a fondo, ingenieros senior que se responsabilizan del resultado, y entregas semanales para que el progreso siempre sea visible. Trabajamos en segundo plano de grandes productos.',
    aboutBullets: [
      'Equipos solo-senior',
      'Incrementos semanales, listos para producción',
      'Responsables del resultado, no del ticket',
      '4+ horas de solape horario',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Proyectos entregados' },
      { value: '15', suffix: '+', label: 'Clientes de producto' },
      { value: '3', suffix: '+', label: 'Años operando' },
      { value: '20', suffix: '+', label: 'Ingenieros senior' },
    ],
    workEyebrow: 'Proyectos',
    workH2: 'Anónimos, pero reales.',
    workP:
      'Bajo NDA no podemos dar nombres — pero los problemas, las soluciones y las cifras son exactamente como ocurrieron.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Plataforma de inferencia en tiempo real para un SaaS de visión',
        challenge:
          'La latencia del modelo superaba los 400ms bajo carga y los costos de inferencia crecían más rápido que los ingresos.',
        solution:
          'Reconstruimos la capa de servicio con inferencia GPU por lotes, una caché de modelo activa y autoescalado bajo demanda.',
        metrics: [
          { value: '80', suffix: 'ms', label: 'Latencia p95' },
          { value: '-64', suffix: '%', label: 'Costo de inferencia' },
          { value: '5', suffix: '×', label: 'Rendimiento' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Plataforma de aprendizaje adaptativo para una red K-12',
        challenge:
          'Un plan de estudios único aburría a los alumnos avanzados y dejaba atrás a los que iban rezagados; la finalización caía.',
        solution:
          'Construimos un motor de rutas por alumno que recomienda la siguiente lección según señales de dominio en vivo.',
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
          'Un monolito heredado colapsaba en días de lanzamiento; el abandono del checkout crecía con cada ralentización.',
        solution:
          'Migramos a una tienda headless renderizada en el edge, con un checkout idempotente y sin tiempo de inactividad.',
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
    servicesH2Line1: 'Tres dominios,',
    servicesH2Line2: 'aprendidos a pulso.',
    servicesP:
      'Vamos a fondo, no a lo ancho. Cada ingeniero aquí ha entregado sistemas en producción en su dominio.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'AI y ML aplicados',
        description:
          'Plataformas de inferencia, pipelines RAG, sistemas de recomendación y visión — rápidos, observables y rentables en producción.',
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
          'Aprendizaje adaptativo, motores de evaluación y herramientas de contenido — atractivos para los alumnos, medibles para las instituciones.',
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
          'Tiendas headless, checkout e inventario a escala — resilientes en días de lanzamiento y rápidos para compradores en todas partes.',
        bullets: ['Tiendas headless', 'Checkout y pagos en el edge', 'Inventario y fulfillment'],
      },
    ],
    processEyebrow: 'Cómo trabajamos',
    processH2Line1: 'Cuatro pasos,',
    processH2Line2: 'sin sorpresas.',
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
          'Equipos senior entregan incrementos semanales en tu repositorio, tu stack, en abierto.',
      },
      {
        stepNum: '03 / Lanzamiento',
        title: 'Lanzamiento',
        description:
          'Publicamos a producción con monitoreo, pruebas de carga y un rollback que nunca necesitarás.',
      },
      {
        stepNum: '04 / Soporte',
        title: 'Soporte',
        description: 'Seguimos a largo plazo — rendimiento, fiabilidad y la siguiente iteración.',
      },
    ],
    techStackEyebrow: 'Stack tecnológico',
    techStackH2: 'Las herramientas que usamos.',
    careersEyebrow: 'Empleo',
    careersH2: 'Buscamos ingenieros senior.',
    careersP:
      'Remoto, solo senior, con responsabilidad real. Si has entregado cosas difíciles en AI, EdTech o comercio, deberíamos hablar.',
    viewAllRoles: 'Ver todas las vacantes',
    contactH2: '¿Tienes un problema difícil que valga la pena resolver?',
    contactP:
      'Cuéntanos qué estás construyendo. Responderemos en un día hábil con personas senior, no con una presentación de ventas.',
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
      errorName: 'Por favor, introduce tu nombre.',
      errorEmail: 'Introduce un email válido.',
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
    h1: 'Resuelve problemas difíciles junto a un equipo senior.',
    p1: 'Remoto, solo senior, con responsabilidad real. Contratamos despacio y mantenemos equipos pequeños — cada vacante aquí cubre una necesidad genuina.',
    p2: 'Explora nuestras vacantes remotas abiertas a continuación — cada rol senior aquí es un puesto real en un equipo de producto activo, no una solicitud algún-día.',
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
    domainLabels: { AI: 'AI / ML', EDTECH: 'EdTech', ECOMMERCE: 'E-Commerce', OTHER: 'Otro' },
    employmentTypeLabels: {
      FULL_TIME: 'Tiempo completo',
      PART_TIME: 'Tiempo parcial',
      CONTRACT: 'Contrato',
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
