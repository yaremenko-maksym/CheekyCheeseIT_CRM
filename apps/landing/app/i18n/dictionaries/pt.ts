import type { Dictionary } from '../dictionary'

/**
 * `pt` — Portuguese (base, no region), WRITTEN in Portuguese
 * (task-landing-copy-refactor.md §2 / skill `copywriting` §5), not translated
 * from `en.ts`:
 * Every heading carries the SAME claim as the English (registry:
 * `__tests__/heading-claims.ts`, with a test proving no heading escapes it);
 * only the wording is written per language.
 * Techniques, not quotes — a comment that restates the string below it is a
 * second source of truth and drifts on the first edit:
 * - hero: the nominalised «o difícil» rather than an English-shaped noun
 *   phrase. One-word adverb for the cadence, same reason as `es`: a two-word
 *   phrase (441px) does not fit the 432px hero column.
 * - work: a sem/com pairing, where the English says "Anonymised, but real".
 * - services: hard-won experience, the claim the English carries; the
 *   paragraph below states the count of domains.
 *
 * Variant: this file leans **pt-BR** (sênior, times, você) — inherited from
 * the original translation, kept deliberately rather than silently switched.
 * If the target market is pt-PT, the lexical choices (times/equipas,
 * sênior/sénior, tela/ecrã) change and this file needs a pass — flagged to
 * the owner in the PR. Key set MUST mirror `en.ts` exactly (enforced by
 * `__tests__/i18n.spec.ts`).
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
    tagline: 'Engenheiros sênior para AI, EdTech e E-Commerce',
    studioHeading: 'Estúdio',
    selectedWork: 'Projetos',
    howWeWork: 'Como trabalhamos',
    companyHeading: 'Empresa',
    careers: 'Vagas',
    aboutUs: 'Sobre nós',
    contact: 'Contato',
    getInTouch: 'Entre em contato',
    writeToUs: 'Escreva-nos',
    rights: '© 2026 CheekyCheeseIT. Todos os direitos reservados.',
  },
  languageSwitcher: {
    label: 'Idioma',
    names: { en: 'English', uk: 'Українська', ru: 'Русский', es: 'Español', pt: 'Português' },
  },
  home: {
    seoTitle: 'CheekyCheeseIT — Engenharia sênior em AI, EdTech, E-Commerce',
    seoDescription:
      'Estúdio de engenharia apenas-sênior para empresas de produto internacionais. Outsourcing e outstaffing em AI, EdTech e E-Commerce, com entregas semanais.',
    heroChip: 'Outsourcing e outstaffing · AI · EdTech · E-Commerce',
    heroH1Line1: 'O difícil,',
    heroH1Highlight: 'semanalmente',
    // Revisão rodada 2 (HIGH-1): dizia «Três domínios que conhecemos de
    // perto» — um limite declarado acima da dobra e antes da seção de
    // serviços, que agora diz o contrário. Não repete o título («Qualquer
    // domínio») de propósito: mesma afirmação, outras palavras.
    heroParagraph:
      'Estúdio de engenharia apenas-sênior para empresas de produto internacionais. Seja qual for o seu domínio, 4+ horas de sobreposição com o seu expediente.',
    ctaStartProject: 'Iniciar um projeto',
    ctaSeeRoles: 'Ver vagas abertas',
    aboutEyebrow: 'Sobre nós',
    aboutH2Line1: 'Times pequenos,',
    aboutH2Line2: 'sem juniores',
    aboutP1:
      'Entramos no seu time de produto como uma extensão dele — ou assumimos o trabalho de ponta a ponta. Nos dois casos você fala com quem escreve o código, não com um gerente de contas no meio do caminho.',
    aboutP2:
      'A abordagem é estreita de propósito, e a troca é explícita: menos gente na conta, toda sênior, cada uma respondendo por um resultado e não por uma fila de tickets. Quase tudo o que construímos leva o nome de outra pessoa — e está ótimo assim.',
    aboutBullets: [
      'Times apenas-sênior',
      'Um incremento entregável por semana',
      'Resultado, não ticket',
      '4+ horas de sobreposição de fuso',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Projetos entregues' },
      { value: '15', suffix: '+', label: 'Clientes de produto' },
      { value: '3', suffix: '+', label: 'Anos de operação' },
      { value: '20', suffix: '+', label: 'Engenheiros sênior' },
    ],
    workEyebrow: 'Projetos',
    workH2: 'Sem nomes, com números',
    workP:
      'Os NDAs deixam os logos fora desta página. Os problemas, as soluções e os números são exatamente como aconteceram.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Inferência em tempo real para um SaaS de visão',
        challenge:
          'Sob carga, a latência do modelo passava de 400ms e o custo de inferência crescia mais rápido que a receita.',
        solution:
          'Refizemos a camada de serving: inferência em lote na GPU, cache de modelo aquecido e autoescalonamento sob demanda.',
        metrics: [
          { value: '80', suffix: 'ms', label: 'Latência p95' },
          { value: '-64', suffix: '%', label: 'Custo de inferência' },
          { value: '5', suffix: '×', label: 'Throughput' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Aprendizagem adaptativa para uma rede K-12',
        challenge:
          'Um currículo só para todo mundo: os avançados entediados, os atrasados sem alcançar — a conclusão caía.',
        solution:
          'Montamos um motor de trilhas por aluno: a próxima lição sai dos sinais de domínio do momento.',
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
          'O monólito legado caía em dias de lançamento e o abandono de checkout subia a cada tela lenta.',
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
    // task-domains-expansion — as duas metades da afirmação precisam chegar
    // ao português: qualquer domínio E três já em produção. O título
    // anterior («Três domínios, aprendidos no tranco») prometia três e nada
    // fora deles.
    servicesH2Line1: 'Qualquer domínio,',
    servicesH2Line2: 'três já em produção',
    servicesP:
      'O que é difícil se repete de setor para setor: latência, modelo de dados, pagamentos, carga. O que muda é o vocabulário, e isso a gente aprende no discovery. Em AI, EdTech e E-Commerce já chegamos à produção; o resto a gente pega do mesmo jeito.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'AI e ML aplicados',
        description:
          'Model serving para um SaaS de visão, pipelines RAG e sistemas de recomendação — rápidos, observáveis e sustentáveis em custo depois que entram em produção.',
        bullets: ['Model serving e MLOps', 'Aplicações LLM e RAG', 'Pipelines de dados e features'],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Plataformas EdTech',
        description:
          'Trilhas de aprendizagem adaptativa para uma rede de escolas K-12, motores de avaliação e ferramentas de conteúdo — envolventes para o aluno e mensuráveis para quem paga a conta.',
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
          'Uma vitrine headless para uma marca DTC global, checkout e estoque em escala — aguentam os dias de lançamento e seguem rápidos em qualquer lugar.',
        bullets: ['Vitrines headless', 'Checkout e pagamentos na edge', 'Estoque e fulfillment'],
      },
      // O quarto card diz em voz alta o «não estamos presos a um domínio».
      // Inventar um quarto case tornaria mentira a promessa da seção
      // «Trabalhos»: ali os números são exatamente os que foram.
      {
        domain: 'neutral',
        domainLabel: 'Qualquer domínio',
        // Rodada 2 (LOW): «O domínio em que você está» jogava «está» para uma
        // segunda linha a 320 px. «Seu domínio» cabe em uma, e alinha com
        // ru/uk («Ваш домен»), que já resolviam assim.
        title: 'Seu domínio',
        description:
          'Aqui ainda não há case, e preferimos dizer isso a inventar um. O que se transfere é a prática: discovery primeiro, um time só de sêniores e algo entregável já na primeira semana. Os três cards ao lado começaram igual.',
        bullets: ['Discovery antes do código', 'Time apenas-sênior', 'Seu repositório, seu stack'],
      },
    ],
    processEyebrow: 'Como trabalhamos',
    processH2Line1: 'Quatro etapas,',
    processH2Line2: 'sem caixa-preta',
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
          'Times sênior entregam incrementos semanais no seu repositório, no seu stack, à vista.',
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
          'Ficamos por perto no longo prazo — performance, confiabilidade e a próxima iteração.',
      },
    ],
    techStackEyebrow: 'Stack técnico',
    techStackH2: 'O stack padrão',
    careersEyebrow: 'Vagas',
    careersH2: 'Responsabilidade desde a primeira semana',
    careersP:
      'Chamamos quem já entregou coisa difícil em AI, EdTech ou comércio. Remoto, e com times pequenos o bastante para que nada do que você faz se perca num backlog — se for o seu caso, vamos conversar.',
    viewAllRoles: 'Ver todas as vagas',
    contactH2: 'Um problema difícil sem dono?',
    contactP:
      'Conte o que você está construindo. Respondemos em um dia útil — engenheiros, não um time de vendas.',
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
      messagePlaceholder: 'Conte-nos sobre o problema, o prazo e o time que você tem hoje.',
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
    h1: 'Problemas difíceis, colegas sênior',
    p1: 'Contratamos devagar e mantemos os times pequenos, então cada vaga aqui atende uma necessidade real. Remoto, e a responsabilidade é de verdade: você responde pelo resultado, não por uma fila de tickets.',
    p2: 'Abaixo estão as vagas remotas abertas. Cada posição sênior é um lugar real em um time de produto ativo, não uma requisição para algum dia.',
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
    // O jargão do setor não se traduz (skill `copywriting` §5: FinTech, SaaS,
    // iGaming são usados como estão); as palavras comuns com equivalente
    // natural em português, sim.
    domainLabels: {
      AI: 'AI / ML',
      EDTECH: 'EdTech',
      ECOMMERCE: 'E-Commerce',
      FINTECH: 'FinTech',
      IGAMING: 'iGaming',
      // Rodada 2 (MED-3): «Adult» é uma palavra comum com equivalente
      // natural, como Travel/Media/Logistics — traduz-se.
      ADULT: 'Conteúdo adulto',
      SAAS: 'SaaS',
      HEALTHTECH: 'HealthTech',
      ADTECH: 'AdTech',
      LOGISTICS: 'Logística',
      PROPTECH: 'PropTech',
      TRAVEL: 'Viagens',
      MEDIA: 'Mídia',
      WEB3: 'Web3',
      HRTECH: 'HR Tech',
      CYBERSEC: 'Cibersegurança',
      OTHER: 'Outro',
    },
    employmentTypeLabels: {
      FULL_TIME: 'Tempo integral',
      PART_TIME: 'Meio período',
      CONTRACT: 'Contrato',
    },
    salaryPeriodLabels: {
      HOUR: 'por hora',
      DAY: 'por dia',
      WEEK: 'por semana',
      MONTH: 'por mês',
      YEAR: 'por ano',
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
      processing: 'Processando…',
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
