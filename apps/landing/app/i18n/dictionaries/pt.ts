import type { Dictionary } from '../dictionary'

/**
 * `pt` — Portuguese (base, no region — covers Brazil AND Portugal, plan §1)
 * marketing copy. Own translation (task-landing-i18n.md: "копирайт: пиши
 * сам, но качественно... требует вычитки владельцем"), NOT a machine
 * translation — terminology kept in English where a literal translation
 * reads worse (senior, remote, outstaffing, MLOps, LLM/RAG,
 * Kubernetes/Docker/AWS-style proper nouns). Key set MUST mirror `en.ts`
 * exactly (enforced by `__tests__/i18n.spec.ts`).
 */
export const pt: Dictionary = {
  hiringStrip: {
    // review round 1 MED-1 — CLDR pt selects one/other (n=0..1 → one,
    // 2+ → other — irrelevant here since the strip never renders at
    // count=0); `few`/`many` unused but filled for key-set parity.
    text: {
      one: 'Estamos contratando — 1 posição aberta',
      few: 'Estamos contratando — {count} posições abertas',
      many: 'Estamos contratando — {count} posições abertas',
      other: 'Estamos contratando — {count} posições abertas',
    },
    close: 'Fechar',
  },
  nav: {
    services: 'Serviços',
    work: 'Projetos',
    careers: 'Vagas',
    contact: 'Contato',
    startProject: 'Iniciar um projeto',
    toggleMenu: 'Abrir menu',
    primaryNav: 'Navegação principal',
    primaryMobileNav: 'Navegação principal (móvel)',
    brandHome: 'CheekyCheeseIT — início',
  },
  footer: {
    tagline:
      'Um estúdio de outsourcing e outstaffing que constrói produtos de AI, EdTech e E-Commerce prontos para escalar.',
    studioHeading: 'Estúdio',
    selectedWork: 'Projetos',
    howWeWork: 'Como trabalhamos',
    companyHeading: 'Empresa',
    careers: 'Vagas',
    aboutUs: 'Sobre nós',
    contact: 'Contato',
    getInTouch: 'Entre em contato',
    rights: '© 2026 CheekyCheeseIT. Todos os direitos reservados.',
  },
  languageSwitcher: {
    label: 'Idioma',
    names: { en: 'English', uk: 'Українська', ru: 'Русский', es: 'Español', pt: 'Português' },
  },
  home: {
    seoTitle: 'CheekyCheeseIT — Estúdio de engenharia sênior para AI, EdTech e E-Commerce',
    seoDescription:
      'Um estúdio de engenharia apenas-sênior para empresas de produto internacionais. Do modelo à vitrine — resolvemos as partes difíceis, no seu fuso horário.',
    heroChip: 'Outsourcing e outstaffing · AI · EdTech · E-Commerce',
    heroH1Line1: 'Construímos produtos',
    heroH1Highlight: 'que escalam.',
    heroParagraph:
      'Um estúdio de engenharia apenas-sênior para empresas de produto internacionais. Do modelo à vitrine — resolvemos as partes difíceis, no seu fuso horário.',
    ctaStartProject: 'Iniciar um projeto',
    ctaSeeRoles: 'Ver vagas abertas',
    aboutEyebrow: 'Sobre nós',
    aboutH2Line1: 'Times pequenos,',
    aboutH2Line2: 'mãos sênior.',
    aboutP1:
      'Somos um estúdio de TI que se integra à empresa de produto como uma extensão do seu time — ou assume um mandato de ponta a ponta. Sem camadas extras, sem juniores aprendendo às custas do seu orçamento.',
    aboutP2:
      'Nossa abordagem é deliberadamente estreita: três domínios que conhecemos a fundo, engenheiros sênior responsáveis pelo resultado, e entregas semanais para que o progresso esteja sempre visível. Ficamos discretamente nos bastidores de ótimos produtos.',
    aboutBullets: [
      'Times apenas-sênior',
      'Incrementos semanais, prontos para produção',
      'Responsáveis pelo resultado, não pelo ticket',
      '4+ horas de sobreposição de fuso',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Projetos entregues' },
      { value: '15', suffix: '+', label: 'Clientes de produto' },
      { value: '3', suffix: '+', label: 'Anos de operação' },
      { value: '20', suffix: '+', label: 'Engenheiros sênior' },
    ],
    workEyebrow: 'Projetos',
    workH2: 'Anônimos, mas reais.',
    workP:
      'Sob NDA não podemos citar nomes — mas os problemas, as soluções e os números são exatamente como aconteceram.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Plataforma de inferência em tempo real para um SaaS de visão computacional',
        challenge:
          'A latência do modelo ultrapassava 400ms sob carga e os custos de inferência cresciam mais rápido que a receita.',
        solution:
          'Reconstruímos a camada de serving com inferência em lote na GPU, cache de modelo aquecido e autoescalonamento sob demanda.',
        metrics: [
          { value: '80', suffix: 'ms', label: 'Latência p95' },
          { value: '-64', suffix: '%', label: 'Custo de inferência' },
          { value: '5', suffix: '×', label: 'Throughput' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Plataforma de aprendizagem adaptativa para uma rede K-12',
        challenge:
          'Um currículo único deixava os alunos avançados entediados e os que ficavam para trás sem apoio; a conclusão caía.',
        solution:
          'Construímos um motor de trilhas por aluno que recomenda a próxima lição a partir de sinais de domínio em tempo real.',
        metrics: [
          { value: '+38', suffix: '%', label: 'Conclusão' },
          { value: '120', suffix: 'k', label: 'Alunos ativos' },
          { value: '+22', suffix: '%', label: 'Retenção' },
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'Vitrine headless para uma marca DTC global',
        challenge:
          'Um monólito legado travava em dias de lançamento; o abandono de checkout crescia a cada lentidão da página.',
        solution:
          'Migramos para uma vitrine headless renderizada na edge, com checkout idempotente e sem downtime.',
        metrics: [
          { value: '1.2', suffix: 's', label: 'LCP global' },
          { value: '+27', suffix: '%', label: 'Conversão' },
          { value: '99.99', suffix: '%', label: 'Uptime' },
        ],
      },
    ],
    challengeLabel: 'Desafio',
    solutionLabel: 'Solução',
    servicesEyebrow: 'Serviços',
    servicesH2Line1: 'Três domínios,',
    servicesH2Line2: 'aprendidos na prática.',
    servicesP:
      'Vamos fundo, não largo. Cada engenheiro aqui já entregou sistemas em produção no seu domínio.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'AI e ML aplicados',
        description:
          'Plataformas de inferência, pipelines RAG, sistemas de recomendação e visão — rápidos, observáveis e econômicos em produção.',
        bullets: ['Model serving e MLOps', 'Aplicações LLM e RAG', 'Pipelines de dados e features'],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Plataformas EdTech',
        description:
          'Aprendizagem adaptativa, motores de avaliação e ferramentas de conteúdo — envolventes para alunos, mensuráveis para as instituições.',
        bullets: [
          'Trilhas de aprendizagem adaptativa',
          'Avaliação e analytics',
          'Autoria de conteúdo e LMS',
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'Sistemas de E-Commerce',
        description:
          'Vitrines headless, checkout e estoque em escala — resilientes em dias de lançamento e rápidos para compradores em qualquer lugar.',
        bullets: ['Vitrines headless', 'Checkout e pagamentos na edge', 'Estoque e fulfillment'],
      },
    ],
    processEyebrow: 'Como trabalhamos',
    processH2Line1: 'Quatro etapas,',
    processH2Line2: 'sem surpresas.',
    processSteps: [
      {
        stepNum: '01 / Discovery',
        title: 'Discovery',
        description:
          'Delimitamos o problema, reduzimos os riscos desconhecidos e combinamos um plano do qual respondemos.',
      },
      {
        stepNum: '02 / Desenvolvimento',
        title: 'Desenvolvimento',
        description:
          'Times sênior entregam incrementos semanais no seu repositório, na sua stack, em aberto.',
      },
      {
        stepNum: '03 / Lançamento',
        title: 'Lançamento',
        description:
          'Publicamos em produção com monitoramento, testes de carga e um rollback que você nunca vai precisar.',
      },
      {
        stepNum: '04 / Suporte',
        title: 'Suporte',
        description:
          'Continuamos por perto no longo prazo — performance, confiabilidade e a próxima iteração.',
      },
    ],
    techStackEyebrow: 'Stack técnico',
    techStackH2: 'As ferramentas que usamos.',
    careersEyebrow: 'Vagas',
    careersH2: 'Estamos contratando engenheiros sênior.',
    careersP:
      'Remoto, apenas sênior, com responsabilidade real. Se você já entregou coisas difíceis em AI, EdTech ou comércio, devemos conversar.',
    viewAllRoles: 'Ver todas as vagas',
    contactH2: 'Tem um problema difícil que vale a pena resolver?',
    contactP:
      'Conte-nos o que você está construindo. Respondemos em um dia útil com pessoas sênior, não com uma apresentação de vendas.',
    terminalAriaLabel:
      'Editor de código animado exibindo código de projetos da CheekyCheeseIT em AI, EdTech e E-Commerce',
    contactForm: {
      nameLabel: 'Nome',
      namePlaceholder: 'Ada Lovelace',
      companyLabel: 'Empresa',
      companyPlaceholder: 'Acme Inc. (opcional)',
      emailLabel: 'Email',
      emailPlaceholder: 'you@company.com',
      messageLabel: 'O que você está construindo?',
      messagePlaceholder: 'Conte-nos sobre o problema, o prazo e a equipe que você tem hoje.',
      submit: 'Enviar mensagem',
      submitting: 'Enviando…',
      protectedBy: 'Protegido por captcha invisível — sem quebra-cabeças.',
      orEmailUs: 'ou escreva diretamente para',
      errorName: 'Por favor, insira seu nome.',
      errorEmail: 'Insira um email válido.',
      errorMessage: 'Conte-nos um pouco mais (pelo menos 10 caracteres).',
      successHeading: 'Mensagem recebida',
      successBody: 'Obrigado — recebemos e responderemos em um dia útil.',
      apiErrorValidation:
        'Algo deu errado ao enviar sua mensagem. Verifique seus dados e tente novamente.',
      apiErrorTurnstile: 'A verificação "não sou um robô" não foi concluída — tente novamente.',
      apiErrorTurnstileRepeat:
        'A verificação "não sou um robô" falhou novamente. Tente mais uma vez, ou escreva diretamente para',
      apiErrorRateLimited:
        'Você enviou algumas mensagens recentemente — tente novamente em breve, ou escreva diretamente para nós.',
      apiErrorUnavailable:
        'O formulário está temporariamente indisponível — escreva diretamente para nós.',
      apiErrorNetwork:
        'Algo deu errado ao enviar sua mensagem. Verifique seus dados e tente novamente.',
    },
  },
  careers: {
    seoTitle: 'Vagas — CheekyCheeseIT',
    seoDescription:
      'Vagas sênior abertas na CheekyCheeseIT — remoto, apenas sênior, com responsabilidade real.',
    eyebrow: 'Vagas',
    h1: 'Resolva problemas difíceis junto a um time sênior.',
    p1: 'Remoto, apenas sênior, com responsabilidade real. Contratamos devagar e mantemos times pequenos — cada vaga aqui atende uma necessidade genuína.',
    p2: 'Veja nossas vagas remotas abertas abaixo — cada função sênior aqui é uma posição real em um time de produto ativo, não uma requisição algum-dia.',
    emptyTitle: 'Nenhuma vaga aberta no momento',
    emptyBody:
      'Contratamos em ondas e agora estamos entre elas. Envie seu currículo mesmo assim — guardamos todo perfil forte e entramos em contato assim que algo combinar.',
  },
  vacancyCard: {
    viewRole: 'Ver vaga',
  },
  vacancy: {
    notFoundSeoTitle: 'Vaga não encontrada — CheekyCheeseIT Careers',
    notFoundSeoDescription: 'Esta vaga não está mais disponível.',
    notFoundH1: 'Vaga não encontrada',
    notFoundBody: 'Esta vaga não está mais aberta — mas pode haver outras.',
    backToCareers: 'Voltar para vagas',
    allRoles: 'Todas as vagas',
    domainLabels: { AI: 'AI / ML', EDTECH: 'EdTech', ECOMMERCE: 'E-Commerce', OTHER: 'Outro' },
    employmentTypeLabels: {
      FULL_TIME: 'Tempo integral',
      PART_TIME: 'Meio período',
      CONTRACT: 'Contrato',
    },
    breadcrumbHome: 'Início',
    breadcrumbCareers: 'Vagas',
    titleSuffix: 'CheekyCheeseIT Careers',
    relatedHeading: 'Vagas semelhantes',
    apply: {
      heading: 'Candidatar-se a esta vaga',
      subheading: 'Leva cerca de 3 minutos. Campos com * são obrigatórios.',
      requiredNote: 'obrigatório',
      fullNameLabel: 'Nome completo',
      emailLabel: 'Email',
      telegramLabel: 'Telegram',
      linkedinLabel: 'URL do LinkedIn',
      githubLabel: 'URL do GitHub',
      coverLetterLabel: 'Carta de apresentação',
      namePlaceholder: 'Ada Lovelace',
      emailPlaceholder: 'you@domain.com',
      telegramPlaceholder: '@handle',
      linkedinPlaceholder: 'linkedin.com/in/…',
      githubPlaceholder: 'github.com/…',
      coverPlaceholder:
        'Conte-nos sobre algo difícil que você entregou e o que gostaria de construir aqui.',
      cvLabel: 'CV / Currículo',
      cvDropPrefix: 'Solte seu CV aqui, ou',
      cvBrowse: 'procure',
      cvHint: 'Apenas PDF · até 5 MB',
      cvRemoveAriaLabel: 'Remover arquivo',
      errorName: 'Por favor, informe seu nome.',
      errorEmail: 'Informe um email válido.',
      errorLinkedin: 'Informe uma URL de LinkedIn válida (https://…).',
      errorGithub: 'Informe uma URL de GitHub válida (https://…).',
      errorFile: 'Por favor, anexe seu CV (PDF).',
      cvInvalidType: 'O CV deve ser um arquivo PDF.',
      cvTooLarge: 'O arquivo é maior que 5 MB.',
      submit: 'Enviar candidatura',
      submitting: 'Enviando…',
      protectedBy: 'Protegido por captcha invisível — sem quebra-cabeças, nunca.',
      successHeading: 'Candidatura recebida',
      successThanks: 'Obrigado',
      successBodyBefore: '— recebemos sua candidatura para',
      successBodyAfter: '. Analisamos cada uma e respondemos em alguns dias úteis.',
      successBrowseMore: 'Ver mais vagas',
      apiErrorValidation:
        'Algo deu errado ao enviar sua candidatura. Verifique seus dados e tente novamente.',
      apiErrorTooLarge: 'Seu arquivo de CV é maior que 5 MB. Compacte-o e tente novamente.',
      apiErrorUnsupportedMedia: 'Seu CV deve ser um arquivo PDF válido.',
      apiErrorDuplicate: 'Você já se candidatou a esta vaga recentemente.',
      apiErrorNetwork:
        'Algo deu errado ao enviar sua candidatura. Verifique seus dados e tente novamente.',
    },
  },
  notFoundPage: {
    seoTitle: 'Página não encontrada — CheekyCheeseIT',
    seoDescription: 'A página que você procura não existe ou foi movida.',
    h1: 'Página não encontrada',
    body: 'A página que você procura não existe ou foi movida.',
    backHome: 'Voltar ao início',
  },
}
