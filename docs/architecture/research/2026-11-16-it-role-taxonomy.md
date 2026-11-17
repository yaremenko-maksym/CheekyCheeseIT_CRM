# Which fixed enum of technical IT roles should tag seniors and vacancies?

**Date:** 2026-11-16 · **Why:** a fixed role enum (pgEnum + `@crm/shared` Zod enum) for tagging every senior developer with 1..N roles, classifying every ingested vacancy into roles, and filtering the vacancy queue by role.
**Shelf life:** recheck once a year, and earlier on any of these signals: a new Stack Overflow Developer Survey (each July; the 2025 edition added "Architect" and "Developer, AI apps or physical AI"); a new ESCO release (v1.2.1 is current at the access date); an O*NET database release that adds 15-1299.xx detail occupations; DOU or Djinni adding or renaming a top-level category (re-scrape the Djinni `tms-data` category tree and the DOU `<option>` list; the repo constants `ALLOWED_CATEGORIES` and `DJINNI_PRIMARY_KEYWORDS` must be re-diffed against the mapping table in section 1).

> Location note: the caller fixed the path `.review/`. Per `external-research` the durable home is
> `docs/architecture/`; move it there if the enum is adopted.

## Short answer

34 roles in 11 groups (section 1). Roles are **functions**, never technologies or seniority: "React", "Python", "Salesforce" are the skills axis; "Senior / Lead / Principal / Head" are the seniority axis. The core split (back-end / front-end / full-stack / mobile / embedded / game / data / ML / DevOps / SRE / sysadmin / QA / security / architect / engineering manager) is taken from the SO 2025 `DevType` list and the board categories. O*NET and ESCO confirm part of it, but they lack occupations for several of these roles: O*NET has no DevOps, SRE, ML, mobile, embedded or game developer, and ESCO has no SRE. The enum adds what this business needs on top: a separate `AI_ENGINEER` (LLM-application engineering, distinct from classical ML in SO 2025 and ESCO v1.2), one `BUSINESS_APPLICATIONS_ENGINEER` for the ERP/CRM/low-code platforms DOU and Djinni both list at the top level, and a fallback `SOFTWARE_ENGINEER` for titles that name no function. A deterministic title classifier built from the synonym lists below was dry-run on 109 real We Work Remotely titles plus 83 synthetic edge cases, title-only (section 3.4).

## 1. Proposed enum

### How to read the tables

- **id**: a stable `SCREAMING_SNAKE` value. Never rename it; deprecate it instead. Postgres can add a
  pgEnum value cheaply but cannot drop one.
- **Labels**: the English label is the canonical one. **Every Ukrainian label is this file's own
  proposal**: DOU and Djinni show their category names in English (see the scrape in section 4), so
  no source exists for a Ukrainian role name. They go to `copy-reviewer` before they reach the uk
  catalog.
- **Title keywords** are case-insensitive. Short tokens (`QA`, `ML`, `AI`, `BA`, `SRE`, `DBA`, `SOC`,
  `iOS`, `ERP`, `SAP`, `RAG`, `LLM`, `IoT`) match **only on word boundaries**. The uk/ru keywords are
  this file's proposals, not board data (DOU/Djinni titles are mostly English). They are stems, so
  `тестувальник` also matches `тестувальниця`.
- **Tech hints** are technology words. They assign a role **only when the title names no function**
  (section 3.2).
- **Mapping types**: `eq` means the source concept is the same as the role. `broader` means the
  source concept also covers other roles. `narrower` means the source concept is a sub-case of the
  role. `hint` means a technology category: it suggests the role and never decides it.
- **Code sources**: O*NET 30.0 codes (SOC 2018 detail codes plus O*NET `.0x` extensions); ESCO
  **v1.2.1** occupation codes (ISCO-08 unit group + ESCO suffix); SO = Stack Overflow Developer
  Survey 2025 `DevType` answer; DOU = jobs.dou.ua category; Djinni = the `primary_keyword` **key**
  (the label differs; for example key `Unity` is labelled "Gamedev"); SFIA 9 = skill codes (skills,
  not roles); WWR = We Work Remotely category slug; Remotive = Remotive API category slug.
- **† on a DOU value**: the value is in the repo constant `ALLOWED_CATEGORIES` but was **not** in the
  live DOU option list fetched on 2026-11-16 (JavaScript, Fullstack, Kotlin, Swift, iOS, QA Automation,
  SRE, Machine Learning, Business Analyst; the live list has "iOS/macOS"). Whether DOU still honours
  these as `?category=` values is unverified (section "What could not be established").

### 1.1 Software Engineering (`SOFTWARE_ENGINEERING`), 6 roles

| id                               | EN / UK (proposed)                                                            | Definition                                                                                                                                    | Title keywords (en; uk/ru) · tech hints                                                                                                                                                                                                                                       | Source mapping                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SOFTWARE_ENGINEER`              | Software Engineer (general) / Інженер-програміст (загальний)                  | **Fallback only.** A coding role whose title names no function, e.g. "Software Engineer" or "Staff Software Engineer, Revenue Systems".       | software engineer, software developer, SWE, programmer, developer (bare), product engineer; uk розробник ПЗ, програміст; ru разработчик, программист · hints `C++`, `Kotlin` land here (ambiguous, section 3.2)                                                               | O*NET 15-1252.00 Software Developers (eq), 15-1251.00 Computer Programmers (eq) · ESCO 2512.4 software developer (eq) · SO: no answer (the survey forces a function) · Remotive `software-development` (eq) · SFIA PROG                                                                                                                                                                                                                                |
| `BACKEND_ENGINEER`               | Back-end Engineer / Бекенд-розробник                                          | Server-side applications, APIs, services and system integrations.                                                                             | backend, back-end, back end, server-side, API developer/engineer, integration developer/engineer; uk бекенд-розробник; ru бэкенд-разработчик · hints Java, Go/Golang, Python, PHP, Ruby/Rails, Scala, Elixir, Erlang, Rust, C#/.NET, Node.js, NestJS, Django, Laravel, Spring | O*NET 15-1252.00 (broader) · ESCO 2512.4 (broader), 2511.17 integration engineer (narrower) · SO "Developer, back-end" (eq) · DOU Java, Python, PHP, .NET, Golang, Ruby, Scala, Node.js, Erlang, Rust (hint) · Djinni `Java`, `Python`, `PHP` (+`Laravel`, `Symfony`, `Yii`), `Node.js`, `Golang`, `Ruby`, `Scala`, `Elixir`, `Rust`, `.NET` (+`Dotnet Web`, `Dotnet Cloud`, `ASP.NET`, `Blazor`) (hint) · WWR `remote-back-end-programming-jobs` (eq) |
| `FRONTEND_ENGINEER`              | Front-end Engineer / Фронтенд-розробник                                       | Browser UI, web clients, markup and layout.                                                                                                   | frontend, front-end, front end, UI developer/engineer, web UI, HTML/CSS, markup, layout designer; uk фронтенд-розробник, верстальник; ru фронтенд-разработчик, верстальщик · hints React, Angular, Vue, Svelte, Next.js, JavaScript, TypeScript                               | O*NET 15-1254.00 Web Developers (broader) · ESCO 2512.5 user interface developer (eq) · SO "Developer, front-end" (eq) · DOU Front End (eq), JavaScript† (hint) · Djinni `JavaScript` ("JavaScript / Front-End", eq), children `Angular`, `Markup`, `React.js`, `Svelte`, `Vue.js` (hint) · WWR `remote-front-end-programming-jobs` (eq)                                                                                                               |
| `FULLSTACK_ENGINEER`             | Full-stack Engineer / Фулстек-розробник                                       | Owns both client and server code in one role.                                                                                                 | full-stack, fullstack, full stack; uk/ru фулстек, фуллстек · hints Magento, Shopify, WordPress, Drupal, Bitrix (CMS and e-commerce platforms)                                                                                                                                 | O*NET 15-1254.00 (broader) · ESCO 2513.5 web developer (broader) · SO "Developer, full-stack" (eq, 27% of respondents, the largest answer) · DOU Fullstack† (eq) · Djinni `Fullstack` (eq), `Drupal`, `Magento`, `WordPress` (hint) · WWR `remote-full-stack-programming-jobs` (eq)                                                                                                                                                                    |
| `DESKTOP_ENGINEER`               | Desktop Applications Engineer / Розробник десктопних застосунків              | Native desktop clients (Windows, macOS, Linux) and thick enterprise clients.                                                                  | desktop developer/engineer, WPF, WinForms, Qt developer, Electron (hint)                                                                                                                                                                                                      | O*NET 15-1252.00 (broader) · ESCO 2514.2 ICT application developer (broader) · SO "Developer, desktop or enterprise applications" (eq) · Djinni `Dotnet Desktop`, `WPF`, `WinForms` (eq) · DOU: no category                                                                                                                                                                                                                                            |
| `BUSINESS_APPLICATIONS_ENGINEER` | ERP/CRM & Low-code Platform Engineer / Розробник ERP/CRM та low-code платформ | Develops and customises packaged business platforms: Salesforce, SAP/ABAP, MS Dynamics, Odoo, 1C, ServiceNow, NetSuite, low-code and no-code. | Salesforce developer, SAP, ABAP, ERP developer, CRM developer, Dynamics 365, Odoo, 1C/1С, ServiceNow, NetSuite, Power Platform, low-code, no-code; uk програміст 1С; ru программист 1С                                                                                        | ESCO 2514.1 ICT application configurator (eq) · O*NET: no detail occupation (15-1299.00 all other) · SO: no answer · DOU ERP/CRM, Salesforce, SAP, No-code (eq) · Djinni `ERP` (+`MS Dynamics`, `Odoo`, `SAP`), `Salesforce`, `No Code` (eq) · SFIA PORT                                                                                                                                                                                               |

### 1.2 Mobile (`MOBILE`), 3 roles

| id                               | EN / UK (proposed)                                                                | Definition                                                                  | Title keywords · tech hints                                                                                                                          | Source mapping                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IOS_ENGINEER`                   | iOS Engineer / iOS-розробник                                                      | Native Apple-platform apps (iOS, iPadOS, watchOS; macOS per DOU).           | iOS, Swift, SwiftUI, Objective-C, macOS                                                                                                              | ESCO 2514.2.2 mobile application developer (broader) · SO "Developer, mobile" (broader) · DOU iOS/macOS (eq), Swift† (hint) · Djinni `iOS` (eq)                         |
| `ANDROID_ENGINEER`               | Android Engineer / Android-розробник                                              | Native Android apps.                                                        | Android, Jetpack Compose · `Kotlin` alone is **not** enough (it is also a back-end language)                                                         | ESCO 2514.2.2 (broader) · SO "Developer, mobile" (broader) · DOU Android (eq), Kotlin† (hint, ambiguous) · Djinni `Android` (eq), `Kotlin` (hint, ambiguous)            |
| `CROSS_PLATFORM_MOBILE_ENGINEER` | Cross-platform Mobile Engineer / Розробник крос-платформних мобільних застосунків | One codebase for iOS and Android, or a mobile title that names no platform. | Flutter, React Native, Xamarin, .NET MAUI, Kotlin Multiplatform / KMP, "mobile developer/engineer"; uk мобільний розробник; ru мобильный разработчик | ESCO 2514.2.2 (broader) · SO "Developer, mobile" (broader) · DOU Flutter, React Native (eq) · Djinni `Flutter`, `React Native`, `Dotnet Mobile`, `MAUI`, `Xamarin` (eq) |

### 1.3 Data & AI (`DATA_AI`), 6 roles

| id                  | EN / UK (proposed)                                          | Definition                                                                                                                                       | Title keywords · tech hints                                                                                                                                | Source mapping                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_ENGINEER`     | Data Engineer / Інженер даних                               | Data pipelines, ETL/ELT, warehouses and lakes, streaming.                                                                                        | data engineer, big data, ETL, DWH, data warehouse, analytics engineer, data platform engineer, Spark developer; uk інженер даних; ru инженер данных        | O*NET 15-1243.01 Data Warehousing Specialists (narrower) · ESCO 2511.20 data engineer (eq; present in v1.2.0 and v1.2.1, absent from the API's default version), 2521.5 data warehouse designer (narrower) · SO "Data engineer" (eq) · DOU Data Engineer, Big Data (eq) · Djinni `Data Engineer` (eq) · Remotive `data` (broader) · SFIA DENG                           |
| `DATABASE_ENGINEER` | Database Engineer / DBA / Інженер баз даних (DBA)           | Database administration, design and in-database development.                                                                                     | DBA, database administrator/engineer/developer, SQL developer, PL/SQL; uk адміністратор баз даних; ru администратор баз данных                             | O*NET 15-1242.00 Database Administrators (eq), 15-1243.00 Database Architects (eq) · ESCO 2521.1 database administrator, 2521.3 database developer (eq) · SO "Database administrator or engineer" (eq) · DOU DBA (eq) · Djinni `SQL` ("SQL / DBA", eq) · SFIA DBAD, DBDS                                                                                                |
| `DATA_ANALYST`      | Data / BI Analyst / Аналітик даних                          | SQL analysis, BI dashboards, product and web analytics.                                                                                          | data analyst, BI developer/analyst/engineer, business intelligence, Power BI, Tableau, product analyst, web analyst; uk аналітик даних; ru аналитик данных | O*NET 15-2051.01 Business Intelligence Analysts (eq) · ESCO 2511.3 data analyst (eq) · SO "Data or business analyst" (broader) · DOU Analyst (broader) · Djinni `Data Analyst`, `Web Analyst` (eq) · Remotive `data` (broader) · SFIA DAAN, BINT, VISL                                                                                                                  |
| `DATA_SCIENTIST`    | Data Scientist / Data Scientist (науковець з даних)         | Statistical modelling, experimentation, predictive models; modelling, not productionising, is the core.                                          | data scientist, data science, statistician, quantitative analyst/researcher, research scientist                                                            | O*NET 15-2051.00 Data Scientists (eq), 15-1221.00 Computer and Information Research Scientists (narrower) · ESCO 2511.4 data scientist (eq) · SO "Data scientist" (eq) · DOU Data Science (eq) · Djinni `Data Science` (eq) · SFIA DATS                                                                                                                                 |
| `ML_ENGINEER`       | Machine Learning Engineer / Інженер машинного навчання      | Trains, evaluates, deploys and operates ML models, including computer vision, NLP and MLOps.                                                     | machine learning engineer, ML engineer, MLOps, deep learning, computer vision, CV engineer, NLP, applied scientist, AI/ML, ML/AI                           | ESCO 2511.2 computer vision engineer (narrower), 2511.11 artificial intelligence engineer (broader, overlaps `AI_ENGINEER`) · O*NET: no detail occupation · SO "AI/ML engineer" (eq), "Applied scientist" (narrower) · DOU AI/ML (eq), Machine Learning† (eq) · Djinni `ML AI` (child of `Data Science`, eq) · Remotive `artificial-intelligence` (broader) · SFIA MLNG |
| `AI_ENGINEER`       | AI Application Engineer (LLM) / AI-інженер (LLM-застосунки) | Builds products on foundation models: LLM integration, RAG, agents, evaluation, prompt engineering. Not model research or classical ML training. | AI engineer, AI developer, applied AI engineer, LLM engineer, GenAI, generative AI, prompt engineer, RAG, AI agents, agentic                               | ESCO 2511.11 artificial intelligence engineer (broader; it was "ICT intelligent systems designer" before v1.2) · SO "Developer, AI apps or physical AI" (eq; new answer in 2025) · DOU AI/ML (broader) · Djinni `ML AI` (broader) · Remotive `artificial-intelligence` (broader)                                                                                        |

### 1.4 Infrastructure & Operations (`INFRASTRUCTURE_OPERATIONS`), 5 roles

| id                          | EN / UK (proposed)                                               | Definition                                                                                    | Title keywords · tech hints                                                                                                                                                                                               | Source mapping                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVOPS_ENGINEER`           | DevOps / Platform Engineer / DevOps-інженер                      | CI/CD, infrastructure as code, cloud infrastructure, containers, internal developer platform. | DevOps, platform engineer, cloud engineer, CloudOps, infrastructure engineer, Kubernetes, release engineer, build engineer, DevSecOps (also `SECURITY_ENGINEER`); uk/ru девопс                                            | ESCO 2512.7 cloud DevOps engineer (eq), 2512.1 cloud engineer (eq) · O*NET 15-1299.08 Computer Systems Engineers/Architects (broader), 15-1244.00 (broader) · SO "DevOps engineer or professional" (eq), "Cloud infrastructure engineer" (eq) · DOU DevOps (eq) · Djinni `DevOps` (eq) · WWR `remote-devops-sysadmin-jobs` (broader) · Remotive `devops` (eq) · SFIA CFMG, RELM, DEPL, ITOP |
| `SITE_RELIABILITY_ENGINEER` | Site Reliability Engineer / Інженер з надійності (SRE)           | Production reliability: SLOs, incident response, observability, capacity.                     | SRE, site reliability, reliability engineer, production engineer, observability engineer                                                                                                                                  | ESCO: no occupation (a v1.2.1 search for "site reliability engineer" returns cloud DevOps engineer first) · SO "Site reliability engineer" (eq, 0.1%) · DOU SRE† (eq) · Djinni: no category (falls under `DevOps`) · SFIA AVMT, CPMG, PBMG                                                                                                                                                  |
| `SYSTEM_ADMINISTRATOR`      | System Administrator / Системний адміністратор                   | Servers, operating systems, directory services, endpoints, on-prem and hybrid IT.             | sysadmin, system(s) administrator, Linux/Windows administrator or engineer, IT administrator, IT systems engineer, IT infrastructure engineer; uk системний адміністратор, сисадмін; ru системный администратор, сисадмин | O*NET 15-1244.00 Network and Computer Systems Administrators (eq) · ESCO 2522.1 ICT system administrator (eq) · SO "System administrator" (eq) · DOU SysAdmin (eq) · Djinni `Sysadmin` (eq) · WWR `remote-devops-sysadmin-jobs` (broader) · Remotive `information-technology` (broader) · SFIA SYSP                                                                                         |
| `NETWORK_ENGINEER`          | Network Engineer / Мережевий інженер                             | LAN/WAN/SD-WAN, routing, firewalls, telecom networks.                                         | network engineer/administrator/architect, NOC, telecom(munications) engineer; uk мережевий інженер; ru сетевой инженер                                                                                                    | O*NET 15-1241.00 Computer Network Architects (eq), 15-1241.01 Telecommunications Engineering Specialists (narrower), 15-1231.00 Computer Network Support Specialists (narrower) · ESCO 2523.3 ICT network engineer (eq), 2523.2 ICT network architect · SO: no answer · DOU/Djinni: no category (SysAdmin/`Sysadmin` broader) · SFIA NTDS, NTAS                                             |
| `SUPPORT_ENGINEER`          | Technical Support Engineer (L2/L3) / Інженер технічної підтримки | Product or application support that needs technical diagnosis. Not customer service.          | support engineer, application support, technical support engineer, L2/L3 support, IT support, help desk, service desk                                                                                                     | O*NET 15-1232.00 Computer User Support Specialists (eq) · ESCO 3512.1 ICT help desk agent (eq), 3512.4 ICT technician · SO "Support engineer or analyst" (eq) · DOU Support (broader, includes customer support) · Djinni `Support` ("Customer/Technical Support", broader) · SFIA ASUP, USUP                                                                                               |

### 1.5 Quality Assurance (`QUALITY_ASSURANCE`), 2 roles

| id                       | EN / UK (proposed)                                                 | Definition                                                                                                  | Title keywords · tech hints                                                                                                                                   | Source mapping                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QA_ENGINEER`            | QA Engineer (Manual) / QA-інженер (мануальне тестування)           | Functional and exploratory testing, test design, release acceptance.                                        | QA, quality assurance, tester, test engineer, manual testing; uk тестувальник, тестування; ru тестировщик, тестирование                                       | O*NET 15-1253.00 Software Quality Assurance Analysts and Testers (broader) · ESCO 2519.7 software tester (eq), 2519.6 ICT test analyst · SO "Developer, QA or test" (broader) · DOU QA (broader) · Djinni `QA` ("QA Manual", eq), `QA Hardware / Embedded` (narrower) · Remotive `qa` (broader) · SFIA TEST, QUAS |
| `QA_AUTOMATION_ENGINEER` | QA Automation Engineer / SDET / Інженер з автоматизації тестування | Writes and maintains automated test suites and test infrastructure, including performance and load testing. | QA automation, automation QA, AQA, test automation, automation engineer (with test/QA), SDET, software development engineer in test, performance/load testing | O*NET 15-1253.00 (broader) · ESCO 2519.7 (broader) · SO "Developer, QA or test" (broader) · DOU QA Automation† (eq) · Djinni `QA Automation` (eq) · SFIA TEST, NFTS                                                                                                                                               |

### 1.6 Security (`SECURITY`), 3 roles

| id                   | EN / UK (proposed)                                          | Definition                                                                                       | Title keywords · tech hints                                                                                                                                                                                  | Source mapping                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECURITY_ENGINEER`  | Security Engineer / Інженер з кібербезпеки                  | Builds and hardens systems: AppSec, cloud security, DevSecOps, IAM, security architecture.       | security engineer, AppSec, application/product/cloud security, DevSecOps, cybersecurity engineer, security architect, information security (bare)                                                            | O*NET 15-1299.05 Information Security Engineers (eq) · ESCO 2529.6 ICT security administrator, 2529.3 embedded systems security engineer (narrower) · SO "Cybersecurity or InfoSec professional" (broader: all 3 security roles) · DOU Security (broader) · Djinni `Security`, `Information Security` (eq) · SFIA SCTY, IAMT |
| `SECURITY_ANALYST`   | Security Analyst (SOC / IR / GRC) / Аналітик з кібербезпеки | Monitoring, detection, incident response, threat intelligence, forensics, compliance assessment. | security analyst, SOC, incident response, threat intelligence/hunting, GRC, security operations, digital forensics; uk кібербезпека, інформаційна безпека; ru кибербезопасность, информационная безопасность | O*NET 15-1212.00 Information Security Analysts (eq), 15-1299.06 Digital Forensics Analysts (narrower) · ESCO 2529.7 cyber incident responder, 2529.2 digital forensics expert, 2529.8 cybersecurity risk manager · SO (broader) · Djinni `Security Analyst` (eq) · SFIA SCAD, THIN, DGFS                                     |
| `PENETRATION_TESTER` | Penetration Tester / Пентестер                              | Offensive security: simulated attacks, red teaming, vulnerability research.                      | penetration tester, pentest(er), ethical hacker, red team, offensive security, bug bounty                                                                                                                    | O*NET 15-1299.04 Penetration Testers (eq) · ESCO 2529.4 ethical hacker (eq) · SO (broader) · Djinni `Penetration Tester` (eq) · SFIA PENT, VUAS, VURE                                                                                                                                                                        |

### 1.7 Embedded & Hardware (`EMBEDDED_HARDWARE`), 2 roles

| id                  | EN / UK (proposed)                                                | Definition                                                                                 | Title keywords · tech hints                                                                                                                                           | Source mapping                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDED_ENGINEER` | Embedded / Firmware Engineer / Розробник вбудованих систем        | Software on MCUs and SoCs: firmware, RTOS, embedded Linux, IoT devices, robotics software. | embedded, firmware, RTOS, IoT, robotics, microcontroller, MCU, embedded Linux; uk вбудовані системи; ru встроенные системы · `C/C++` alone is ambiguous (section 3.2) | ESCO 2514.2.1 embedded systems software developer (eq), 2511.5 embedded system designer, 2512.9 IoT developer (narrower) · O*NET: no detail occupation · SO "Developer, embedded applications or devices" (eq) · DOU Embedded (eq) · Djinni `Embedded` (child of `C++`), `Firmware Engineer`, `Robotics Engineer` (eq), `C++` ("C / C++ / Embedded", hint) · SFIA RESD |
| `HARDWARE_ENGINEER` | Hardware / Electronics Engineer / Інженер апаратного забезпечення | Circuit and PCB design, FPGA/ASIC/RTL, RF.                                                 | hardware engineer, electronics engineer, PCB, FPGA, ASIC, chip design, VLSI, RF engineer, Verilog, VHDL                                                               | O*NET 17-2061.00 Computer Hardware Engineers (eq) · ESCO 2152.1.1 computer hardware engineer (eq), 2152.1 electronics engineer · SO: no answer · DOU Hardware (eq) · Djinni `Hardware` (+`ASIC / Chip Design`, `FPGA Engineer`, `Hardware Engineer`, `RF Engineer`), `Electronics / PCB Design` (eq) · SFIA HWDE, RFEN                                                 |

### 1.8 Game & Graphics (`GAME`), 1 role

| id               | EN / UK (proposed)                         | Definition                                                                                            | Title keywords · tech hints                                                                                                                                   | Source mapping                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GAME_DEVELOPER` | Game & Graphics Developer / Розробник ігор | Game clients and servers, engines, gameplay, rendering, AR/VR. Game **design** is out (section 1.12). | game developer/programmer/engineer, gameplay, Unity developer, Unreal / UE4 / UE5, graphics programmer, rendering engineer, XR, AR/VR, gamedev; uk/ru геймдев | ESCO 2513.1 digital games developer (eq) · SO "Developer, game or graphics" (eq) · DOU Unity, Unreal Engine (eq) · Djinni `Unity` ("Gamedev"), `Game Developer`, `Unity Developer`, `Unreal Developer`, `.NET Gamedev` (eq) · O*NET 15-1255.01 Video Game Designers is design, **not** this role |

### 1.9 Blockchain (`BLOCKCHAIN`), 1 role

| id                    | EN / UK (proposed)                                | Definition                                         | Title keywords · tech hints                                                              | Source mapping                                                                                                                                                                   |
| --------------------- | ------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BLOCKCHAIN_ENGINEER` | Blockchain / Web3 Engineer / Blockchain-розробник | Smart contracts, protocols, on-chain integrations. | blockchain, Solidity, smart contract, Web3, DeFi, EVM, Solana, crypto developer/engineer | O*NET 15-1299.07 Blockchain Engineers (eq) · ESCO 2512.4.1 blockchain developer (eq), 2511.14.1 blockchain architect · SO: no answer · DOU Blockchain (eq) · Djinni: no category |

### 1.10 Architecture & Technical Leadership (`ARCHITECTURE_LEADERSHIP`), 3 roles

| id                    | EN / UK (proposed)                                            | Definition                                                                                                            | Title keywords · tech hints                                                                                                                                                                       | Source mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOFTWARE_ARCHITECT`  | Software / Solution Architect / Архітектор ПЗ                 | Designs the structure of systems across components. Covers software, solution, cloud, data and enterprise architects. | architect (software, solution(s), cloud, technical, enterprise, data, integration); uk архітектор; ru архитектор · also adds the domain role (section 3.1, rule 6)                                | O*NET 15-1299.08 Computer Systems Engineers/Architects (eq), 15-1243.00 Database Architects and 15-1241.00 Network Architects (narrower, add the domain role) · ESCO 2512.3 software architect (eq), 2511.14 ICT system architect, 2512.6 cloud architect, 2511.6 enterprise architect · SO "Architect, software or solutions" (eq; new in 2025, 6.1%) · DOU Architect (eq) · Djinni `Architect` (child of `Lead`, "Tech Leadership", eq) · SFIA ARCH, STPL, SWDN, DESN |
| `ENGINEERING_MANAGER` | Engineering Manager / Керівник розробки (Engineering Manager) | People and delivery management of engineering teams, including Head / Director / VP of Engineering.                   | engineering manager, "Manager, Engineering", head of engineering/development/software/R&D, director of engineering, VP engineering, development manager (not "business development"), R&D manager | O*NET 11-3021.00 Computer and Information Systems Managers (broader) · ESCO 1330 ICT service managers (broader) · SO "Engineering manager" (eq) · DOU Engineering Manager (eq) · Djinni `Engineering Manager` (child of `Lead`, eq) · SFIA DLMG                                                                                                                                                                                                                         |
| `CTO`                 | CTO / Технічний директор (CTO)                                | Top technical executive, including fractional CTO, Head of Technology and VP Technology.                              | CTO, chief technology officer, chief technical officer, head of technology, VP technology; uk технічний директор; ru технический директор                                                         | O*NET 11-3021.00 (broader) · ESCO 1330.3 chief technology officer (eq) · SO "Senior executive (C-suite, VP, etc.)" (broader) · DOU C-level (broader) · Djinni `CTO` (child of `Lead`, eq)                                                                                                                                                                                                                                                                               |

### 1.11 Analysis & Product Design, adjacent (`ADJACENT_ANALYSIS_DESIGN`), 2 roles

This group is a **single owner toggle** (open decision 3). Both roles sit inside the computer-occupation
groups of O*NET (15-1211, 15-1255) and ESCO (2511, 2513), and outstaffing clients order them next to
developers. They are not engineering, though, and no senior developer carries them.

| id                 | EN / UK (proposed)                                   | Definition                                                       | Title keywords · tech hints                                                                                                                                      | Source mapping                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUSINESS_ANALYST` | IT Business / Systems Analyst / Бізнес-аналітик (IT) | Requirements, process and system analysis for software projects. | business analyst, systems/system analyst, BA (word-bounded), IT business analyst; uk бізнес-аналітик, системний аналітик; ru бизнес-аналитик, системный аналитик | O*NET 15-1211.00 Computer Systems Analysts (eq) · ESCO 2511.9 ICT business analyst (eq) · SO "Data or business analyst" (broader) · DOU Analyst (broader) · Djinni `Business Analyst` (eq) · SFIA REQM, BUSA                                                                                                                                                                          |
| `UI_UX_DESIGNER`   | Product (UI/UX) Designer / UI/UX-дизайнер            | Digital interface and interaction design, UX research.           | UI/UX, UX/UI, product designer, UX designer, UI designer, interaction designer, UX researcher; uk дизайнер інтерфейсів; ru дизайнер интерфейсов                  | O*NET 15-1255.00 Web and Digital Interface Designers (eq) · ESCO 2513.3 user interface designer (eq), 2511.19 user experience analyst · SO "UX, Research Ops or UI design professional" (eq) · DOU Design (broader) · Djinni `Product Design`, `UI UX`, `UX Research` (eq), parent `Design` (broader) · Remotive `design`, WWR `remote-design-jobs` (broader) · SFIA HCEV, UNAN, URCH |

### 1.12 Deliberately excluded (not in the enum)

| Excluded                                                                                                  | Why                                                                                                        | What a title gets                         |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Project / Delivery / Product Manager, Product Owner, Scrum Master / Agile Coach                           | Owner's scope rule (no generic PM). DOU and Djinni list them under Management.                             | `EXCLUDED`                                |
| Sales, presales, Sales Engineer, Solutions Engineer (sales-facing), Account Manager, Business Development | Owner's scope rule (no sales)                                                                              | `EXCLUDED`                                |
| HR, Recruiter, IT Sourcer, Interviewer                                                                    | Owner's scope rule (no HR)                                                                                 | `EXCLUDED`                                |
| Marketing, SEO, ASO, PPC, media buying, content                                                           | Owner's scope rule (no marketing). ESCO puts the SEO expert (2513.2) in ICT, but it is marketing work.     | `EXCLUDED`                                |
| Technical Writer                                                                                          | Outside every computer-occupation group (ESCO 2641.4.4 technical communicator). DOU and Djinni do list it. | unclassified; revisit if clients order it |
| Graphic, motion, 2D/3D, VFX, illustrator, game designer, level designer                                   | Creative work, not engineering (ESCO 2166; Djinni group "Креатив і геймдев")                               | unclassified                              |
| Customer support, FinOps, finance                                                                         | Not technical, or a finance function (Djinni puts FinOps under `Finances`)                                 | `EXCLUDED` / unclassified                 |
| DefTech (Avionics, EW, C4ISR, UAV)                                                                        | A **domain** axis, not a role: a "UAV firmware engineer" is `EMBEDDED_ENGINEER`                            | the role named by the title               |
| CAD, mechanical, electrical engineering, UAV pilot                                                        | Not IT                                                                                                     | unclassified                              |
| CIO, CPO, other C-level                                                                                   | CIO is IT operations leadership, not engineering. If it is wanted, map it to `CTO` as a hint.              | unclassified                              |
| Accountant, finance manager, lawyer, copywriter, talent acquisition                                       | Not technical                                                                                              | `EXCLUDED`                                |
| Landscape / interior / building architect                                                                 | Not IT, but `architect` would match `SOFTWARE_ARCHITECT`                                                   | `EXCLUDED`                                |

`EXCLUDED` here follows the 2-strength rule in section 3.1 step 1. A full role phrase ("Marketing
Manager", "HR Generalist") always excludes. A bare domain word ("Marketing", "HR", "Sales")
excludes only when the title has no engineering noun. So "Backend Engineer - HR Tech" stays
`BACKEND_ENGINEER`.

**Count check:** 6 + 3 + 6 + 5 + 2 + 3 + 2 + 1 + 1 + 3 + 2 = **34 roles** in **11 groups**.

## 2. Granularity decision

**Decision: 34 roles. A role is a function that a vacancy hires for and a senior can be swapped
into.** Technology is a separate skills axis, and seniority is a separate axis.

1. **The cut line is "do two of these titles hire the same person?"** A senior Java back-end
   engineer and a senior Go back-end engineer are one role with different skills. A back-end
   engineer and an SRE are two roles: the vacancies differ in duties, and recruiters filter them
   apart. The sources that are role lists draw the same line. The SO 2025 `DevType` list has 34
   answers, and none of them names a technology. O*NET and ESCO never name a language.
2. **Why not per-technology (the DOU/Djinni shape).** Most of Djinni's development keys are
   languages or frameworks: about 15 of the 21 keys in its group "Розробка". About 15 of the 59
   live DOU categories are too, for example Java, Python, PHP, .NET, Golang, Ruby, Scala, Rust,
   Elixir, Unity and Flutter. A language does not fix the function. Djinni `Python` covers
   back-end, data, ML and QA-automation vacancies, and Djinni `C++` is labelled "C / C++ / Embedded".
   So a board category is stored as a **hint** (section 3.2) and a skill, never as the role.
3. **Where the sources split finer than the enum, and why the enum merges them:**
   - SO lists "DevOps engineer or professional" and "Cloud infrastructure engineer" separately.
     ESCO lists cloud engineer and cloud DevOps engineer separately. Job titles use these
     interchangeably, so the enum has one role, `DEVOPS_ENGINEER`. SRE stays separate, which is a
     weaker call. SO keeps it separate (0.1% of answers), and so does the repo's DOU constant (†,
     not seen in the live list). Its vacancies carry on-call and SLO duties. ESCO and Djinni fold
     it into DevOps. If the queue shows the split is noise, merging SRE into DevOps is a one-PR
     deprecation.
   - O*NET 15-1242 (database administrators) and 15-1243 (database architects) become one role,
     `DATABASE_ENGINEER`. Architecture is already covered by `SOFTWARE_ARCHITECT` + domain (rule 6).
   - The enum merges ESCO's software, solution, cloud, enterprise and system architects into
     `SOFTWARE_ARCHITECT`. The kind of architect is recovered from the domain role and the skills.
4. **Where the enum splits finer than most sources, and why:**
   - **Mobile has 3 roles** (iOS / Android / cross-platform). SO and ESCO have one mobile role.
     DOU and Djinni both list iOS and Android as separate top-level categories. Native iOS and
     native Android seniors are not interchangeable. These are platforms, not frameworks, so they
     stay on the role axis.
   - **`AI_ENGINEER` is separate from `ML_ENGINEER`.** SO 2025 added "Developer, AI apps or
     physical AI" next to "AI/ML engineer". AI is one of the company's 3 domains, and LLM-application
     vacancies hire product engineers, not model trainers (open decision 2).
   - **Security has 3 roles**, following O*NET (15-1212 analyst, 15-1299.04 penetration tester,
     15-1299.05 engineer) and Djinni (`Information Security`, `Security Analyst`, `Penetration Tester`).
     SO folds all 3 into one answer, but they are hired separately.
5. **What stays out of the enum:** seniority, employment form, domain (AI, EdTech, E-Commerce,
   DefTech, FinTech) and technology. Each one is its own axis.
6. **Growth rule.** Add a role only when it passes both tests: (a) at least one primary taxonomy or
   2 boards list it, and (b) the classifier's unclassified bucket shows real titles that need it.
   Postgres adds an enum value with `ALTER TYPE ... ADD VALUE`, but it cannot drop one. So err
   toward fewer values, and deprecate a value instead of renaming it.

## 3. Ambiguity and classification rules

### 3.1 Deterministic title classifier (vacancies)

Steps run in order, on the title lower-cased.

1. **Exclusion first, in 2 strengths.**
   - (a) A **full excluded role phrase** gives `EXCLUDED` at once. The phrases are: sales
     engineer, solutions engineer, presales / pre-sales, ASO, business development, sales
     manager/representative/executive/lead/specialist, account executive/manager, recruiter,
     recruiting, talent acquisition, HR manager/business partner/generalist, marketing
     manager/specialist/lead, SEO specialist/manager, copywriter, customer
     success/support/service, accountant, finance manager, product/project/delivery manager,
     product owner, scrum master, lawyer, and landscape/interior/building architect.
   - (b) A **bare domain word** (sales, marketing, recruit*, HR, legal, SEO, finance) gives
     `EXCLUDED` only when the title has **no engineering noun** (developer, engineer, programmer,
     architect, DevOps, QA, tester, scientist, analyst, administrator, SRE, DBA,
     розробник/разработчик, програміст/программист, інженер/инженер). So "Software Engineer,
     Marketing Platform", "Engineering Manager, Sales Tools" and "Backend Engineer - HR Tech" stay
     engineering.
   - `\bsales\b` does not match `Salesforce`.
2. **Job-noun gate.** The title must contain a job noun: developer, engineer, programmer,
   architect, designer, analyst, administrator, tester, QA, SDET, scientist, DBA, SRE, DevOps,
   pentester, CTO, head of, director, VP, development/R&D manager, lead, specialist, consultant,
   researcher; uk/ru розробник/разработчик, програміст/программист, тестувальник/тестировщик,
   адміністратор/администратор, аналітик/аналитик, архітектор/архитектор, дизайнер, інженер/инженер.
   A title without one is unclassified. This gate stops "Lending Manager (Front End)" and
   "Joinery Estimator (Innergy ERP)" from becoming roles.
3. **Collect every role** whose keyword matches. Patterns match on word boundaries, and
   multi-word phrases count as one keyword.
4. **Precedence (remove the less specific role):**
   - `QA_AUTOMATION_ENGINEER` drops `QA_ENGINEER`.
   - `FULLSTACK_ENGINEER` drops `FRONTEND_ENGINEER` and `BACKEND_ENGINEER`. "Full-stack (React/Node)"
     gets the full-stack role only, and the technologies go to skills.
   - `PENETRATION_TESTER` drops `QA_ENGINEER` ("pen tester" is not a software tester).
   - If the title has an LLM, GenAI, RAG, agent or prompt keyword, `AI_ENGINEER` drops `ML_ENGINEER`.
   - If `ENGINEERING_MANAGER` or `CTO` matched, every other role is dropped. "Engineering
     Manager, Security Platform" is a management vacancy, and its domain becomes a skill or a tag.
5. **Keep genuine multi-role titles.** "QA/DevOps Engineer", "SRE / DevOps", "Backend Cloud
   Engineer" and "iOS/Android developer" are tagged with both roles. Vacancies are 1..N by design.
6. **Architect + domain.** `SOFTWARE_ARCHITECT` also adds the domain role named in the title:
   data → `DATA_ENGINEER`; cloud, infrastructure, DevOps or platform → `DEVOPS_ENGINEER`; security →
   `SECURITY_ENGINEER`; network → `NETWORK_ENGINEER`; ML/AI → `ML_ENGINEER`; Salesforce, SAP, ERP or
   CRM → `BUSINESS_APPLICATIONS_ENGINEER`; front-end → `FRONTEND_ENGINEER`; mobile →
   `CROSS_PLATFORM_MOBILE_ENGINEER`. So "Data Architect" becomes
   `[SOFTWARE_ARCHITECT, DATA_ENGINEER]`.
7. **Tech hint, only if no role matched** (section 3.2).
8. **Generic fallback, only if nothing else matched.** If the title has "software", "developer",
   "programmer", SWE, розробник, разработчик, програміст or программист, the role is
   `SOFTWARE_ENGINEER`. A title with only "engineer" stays unclassified: "Principal Engineer" and
   "Distribution Engineer" are not necessarily software.
9. **Board category only as a tie-breaker.** If the title is unclassified or `SOFTWARE_ENGINEER`, an
   `eq` board category (DOU `category`, Djinni `primary_keyword`, WWR or Remotive category) may fill
   in the role. A `hint` category may not. A title keyword always overrides a board category.

### 3.2 Technology hints (used only when step 3 found no role)

| Tech token in the title                                                                                                  | Role it implies                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Java, Go/Golang, Python, PHP, Ruby/Rails, Scala, Elixir, Erlang, Rust, C#/.NET, Node.js, NestJS, Django, Laravel, Spring | `BACKEND_ENGINEER`                              |
| React, Angular, Vue, Svelte, Next.js, JavaScript, TypeScript, JS                                                         | `FRONTEND_ENGINEER`                             |
| Magento, Shopify, WordPress, Drupal, Bitrix                                                                              | `FULLSTACK_ENGINEER`                            |
| Swift                                                                                                                    | `IOS_ENGINEER` (already a keyword)              |
| C, C++, C/C++, Kotlin (Djinni `C++`, `C Lang`, `CPP`, `Kotlin`; DOU C++, Kotlin)                                         | **ambiguous**: `SOFTWARE_ENGINEER`, then step 9 |

A hint fires only together with a job noun ("Python Developer", "Java Tech Lead"). "Python" alone
in a skills line never assigns a role.

### 3.3 Seniority, leadership and other words that are NOT roles

- **Seniority:** Intern, Trainee, Junior/Jr, Middle/Mid, Senior/Sr, Staff, Principal,
  Distinguished, Fellow; uk/ru стажер, джуніор, мідл, сеньйор/сеньор, провідний, ведучий/ведущий.
  Strip them before step 3. They go on a separate seniority axis if one is wanted.
- **Tech Lead / Team Lead / Lead X:** this is seniority plus scope, **not a role**. "Lead Python
  Engineer (ML)" gets `ML_ENGINEER`, and "Java Tech Lead" gets `BACKEND_ENGINEER` through the hint.
  A bare "Team Lead" or "Tech Lead" stays unclassified (step 9 may fill it from the board
  category). Djinni files Architect, Engineering Manager and CTO under the parent key `Lead` ("Tech
  Leadership"). The enum maps those 3 children, and `Lead` itself is a parent with no role.
- **Head of X:** "Head of Engineering/Development/R&D" is `ENGINEERING_MANAGER`, and "Head of
  Technology" is `CTO`. Any other "Head of X" keeps the role of X: "Head of QA" gets `QA_ENGINEER`.
  Leadership level is a seniority fact, not a role.
- **Employment form and location:** contract, freelance, remote, (m/f/d), H/F. These are never
  roles.
- **"Full-stack" for seniors:** tag a senior `FULLSTACK_ENGINEER` only when they actually work
  across both sides. Tagging them also `FRONTEND_ENGINEER` and/or `BACKEND_ENGINEER` is the
  matching question in open decision 1.
- **Generic "Software Engineer":** a vacancy can get `SOFTWARE_ENGINEER` (step 8). A senior should
  **not** get it, because every senior has a real function. Whether the queue shows generic
  vacancies to every developer role is open decision 1.

### 3.4 Dry run of these rules (evidence, not a benchmark)

The rules above were coded in a 91-line Python scratch classifier. Its full source is in
Appendix A, so the run can be repeated without the scratch file. Where a keyword cell in section 1
and the appendix differ, the appendix is what was run. 2 deviations from 3.1:

- Step 9 (board category as tie-breaker) was **not implemented**. Every run below is title-only.
- Stems are open on the right and bounded only on the left (`(?<![a-z0-9])backend` matches
  "backends"). Short tokens (`qa`, `sre`, `dba`, `1c`, `defi`, `erp`, `crm`) use `\b` on both
  sides.

The classifier ran on 3 sets.

- **109 real titles from the We Work Remotely RSS feeds** (fetched 2026-11-16). Feed header lines
  and the company prefix were removed.

  | Outcome      | Count | Note                                                                                                                                                                                                                                                                                                                                                |
  | ------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | One role     | 31    |                                                                                                                                                                                                                                                                                                                                                     |
  | Multi-role   | 7     | `Principal Infrastructure Architect: Data Platform` (architect + data + DevOps), `QA/DevOps Engineer`, `Full-Stack Platform Engineer`, `Senior Backend Cloud Engineer`, `Salesforce Business Systems Administrator`, `CloudOps Engineer (Network Engineer)`, `Backend / Platform Developer Consultant (Temporal & Kubernetes)`. All are defensible. |
  | `EXCLUDED`   | 27    |                                                                                                                                                                                                                                                                                                                                                     |
  | Unclassified | 44    |                                                                                                                                                                                                                                                                                                                                                     |

  Of the 44 unclassified titles, 40 are non-IT (physician, estimator, tutor, motion designer,
  "Distribution Engineer", "Freelance Marketo Email Engineer"). 4 are arguably technical:
  "Director, Applied AI", "AI Infrastructure Specialist", "Senior Product Engineer", and
  "WordPress & HubSpot (Contractor)". The last one has no job noun, so the gate in step 2 drops
  it. Known false positives: "Blockchain Risk Control Lead" was tagged `BLOCKCHAIN_ENGINEER` (a
  risk role), and "Development Manager" at an unknown company was tagged `ENGINEERING_MANAGER`
  (correct only at a software company).

- **ATS fixture titles from the repo** (`apps/api/src/job-sourcing/**/__fixtures__/`:
  Greenhouse, Lever, Ashby, Workable, Jobgether, The Muse, Himalayas, HN, Remotive and others).
  This set was read for traps, not counted. It found 2 bugs, both fixed:
  - "Automated Test Engineer" did not reach `QA_AUTOMATION_ENGINEER`. `automated test` is now a
    keyword.
  - `erp` matched inside "enterprise". It now needs `\b` on both sides.

  After the fixes, "Enterprise Architect - Consumer Banking & Marketing" gives
  `SOFTWARE_ARCHITECT` only, and "BA/Technical Product Manager" gives `EXCLUDED` (an acceptable
  call for a hybrid).

- **83 synthetic edge-case titles** written for this file. These are not data; they check the
  rules. All 83 gave the intended result on the last run of the synthetic set. That run came before
  the final WWR recount; the synthetic list itself was not kept. Examples:
  - "Senior Java Tech Lead" gives `BACKEND_ENGINEER`
  - "Data Architect" gives `SOFTWARE_ARCHITECT, DATA_ENGINEER`
  - "Програміст 1С" gives `BUSINESS_APPLICATIONS_ENGINEER`
  - "SRE / DevOps" gives both
  - "Kotlin developer" and "C++ developer" give `SOFTWARE_ENGINEER` (ambiguous by design)
  - "Business Development Manager" and "Landscape Architect" give `EXCLUDED`
  - "Software Engineer, Marketing Platform", "Engineering Manager, Sales Tools" and
    "Backend Engineer - HR Tech" stay engineering (step 1b)
  - "DeFi Smart Contract Engineer" gives `BLOCKCHAIN_ENGINEER`, and "Definition Engineer" gives
    nothing
  - "Market Penetration Specialist" gives nothing, and "CloudOps Engineer" gives `DEVOPS_ENGINEER`
  - "Graphic designer" and "Technical Writer" give nothing

  The tuning passes found 8 traps, and each one is now a rule or a keyword:
  1. "Business Development Manager" matched "development manager".
  2. "Front End" appeared inside a non-tech title. The job-noun gate (step 2) fixes it.
  3. The Cyrillic `С` in "1С" is not the Latin `C`.
  4. Kotlin and C++ need to be ambiguous.
  5. A bare `marketing` / `sales` / `HR` excluded real engineering titles. The phrase-vs-bare
     split (step 1) fixes it.
  6. `defi` matched inside "definition".
  7. `penetration` matched outside security. The keyword is now `penetration test`.
  8. A non-IT architect (landscape, interior, building) matched `SOFTWARE_ARCHITECT`.

- **Not measured:** precision and recall on a labelled set. No labelled set exists. Build one
  from the queue before relying on the classifier (section "What could not be established").

### 3.5 Board category coverage

Every technical value of the repo's `DJINNI_PRIMARY_KEYWORDS` (157 entries) and DOU
`ALLOWED_CATEGORIES` (30 entries) appears in a mapping cell in section 1. The exceptions are listed
here.

- **Djinni, technical but with no role of their own:** `C Lang` and `CPP` (children of `C++`) are
  ambiguous hints (section 3.2). `Lead` and `Head Chief` are parents with no role (section 3.3).
  `Military Software / C4ISR`, `UAV / Drone Engineer`, `Avionics`, `Electronic Warfare`,
  `Weapons Systems` and parent `DefTech` are a domain, so the title decides
  (`EMBEDDED_ENGINEER` / `HARDWARE_ENGINEER` / `SOFTWARE_ENGINEER`). `Other` has no role.
- **Djinni, excluded (section 1.12):**
  - Art and design: `2D Animation`, `2D Artist`, `3D Animation`, `3D Artist`, `Artist`,
    `Illustrator`, `Motion Design`, `VFX Artist`, `Video Editor`, `Graphic Design`,
    `Content Design`, `Game Design`, `Level Design`.
  - Non-IT engineering: `CAD Designer`, `Engineering / CAD Design`, `Electrical Engineering`,
    `Industrial Design`, `Mechanical Engineering`, `UAV / Drone Pilot`.
  - Sales and marketing: `Account Manager`, `Advertising`, `Affiliate Manager`,
    `Business Development`, `Content Manager`, `Content Marketing`, `Content Writing`,
    `Digital Marketing`, `Digital Marketing Manager`, `Lead Generation`, `Marketing`,
    `Marketing Analyst`, `Media Buying`, `PPC`, `PR Manager`, `Performance Marketing`, `SEO`,
    `Sales`, `Sales Leadership`, `Sales Manager`, `Social Media`.
  - Finance: `Accountant`, `FinOps`, `Finance Manager`, `Financial Analyst`.
  - HR: `HR`, `Interviewer`, `Recruiter`.
  - Management: `Delivery Manager`, `Product Manager`, `Product Owner`, `Project Manager`,
    `Scrum Master`.
  - C-level: `CBDO`, `CCO`, `CEO`, `CFO`, `CIO`, `CMO`, `COO`, `CPO`, `CSO`.
  - Other: `Technical Writing`.
- **DOU:** `C++` and `Kotlin` are ambiguous hints. `Project Manager` and `Product Manager` are
  excluded. `Business Analyst`† maps to `BUSINESS_ANALYST`, and `Design` maps to `UI_UX_DESIGNER`
  (broader). The live option list fetched on 2026-11-16 also has non-IT categories (Account
  Manager, Animator, Artist, Assistant, Copywriter, Finance, HR, Legal, Marketing, Office Manager,
  Procurement, Sales, SEO, Військова справа), all excluded. It has C-level (broader, `CTO`) and
  Technical Writer (excluded).

## Facts (each with its source)

- O*NET 30.0 lists these 15-12xx detail occupations: 15-1211 Computer Systems Analysts,
  15-1212 Information Security Analysts, 15-1221 Computer and Information Research Scientists,
  15-1231/1232 network/user support, 15-1241 Computer Network Architects, 15-1242 Database
  Administrators, 15-1243 Database Architects (and .01 Data Warehousing Specialists), 15-1244 Network
  and Computer Systems Administrators, 15-1251 Computer Programmers, 15-1252 Software Developers,
  15-1253 Software QA Analysts and Testers, 15-1254 Web Developers, 15-1255 Web and Digital Interface
  Designers (and .01 Video Game Designers). It also lists 15-1299.04 Penetration Testers, .05
  Information Security Engineers, .06 Digital Forensics Analysts, .07 Blockchain Engineers, .08
  Computer Systems Engineers/Architects and .09 IT Project Managers. Data Scientists are 15-2051 and
  Computer Hardware Engineers are 17-2061. Source: [O*NET 30.0 `Occupation Data.txt`](https://www.onetcenter.org/dl_files/database/db_30_0_text/Occupation%20Data.txt), accessed 2026-11-16.
- O*NET has **no** detail occupation for DevOps, SRE, cloud, data engineer, ML/AI engineer, mobile,
  embedded or game developer. These fall into 15-1252 or 15-1299. Source: the same file (no row
  matches).
- In ESCO **v1.2.1**, the ICT occupations of interest are cloud engineer 2512.1, software architect
  2512.3, software developer 2512.4, blockchain developer 2512.4.1, user interface developer 2512.5,
  cloud architect 2512.6, cloud DevOps engineer 2512.7, IoT developer 2512.9, computer vision engineer
  2511.2, data analyst 2511.3, data scientist 2511.4, artificial intelligence engineer 2511.11, ICT
  system architect 2511.14, data engineer 2511.20, mobile application developer 2514.2.2, embedded
  systems software developer 2514.2.1, digital games developer 2513.1, software tester 2519.7,
  database administrator 2521.1, ICT system administrator 2522.1, ICT network engineer 2523.3,
  ethical hacker 2529.4 and chief technology officer 1330.3. Source: [ESCO REST API `search` and
  `resource/occupation`, `selectedVersion=v1.2.1`](https://ec.europa.eu/esco/api/search?text=cloud%20DevOps%20engineer&type=occupation&language=en&selectedVersion=v1.2.1), accessed 2026-11-16.
- The ESCO API **default** version (no `selectedVersion`; API software 1.1.3) returns no occupation
  for "devops" or "blockchain". It returns no "data engineer" either, and it has "ICT intelligent
  systems designer" where v1.2.x has "artificial intelligence engineer". **Contradiction resolved:**
  the newer occupations exist only when v1.2.x is requested explicitly. This file cites v1.2.1.
  Source: [ESCO API search, default version](https://ec.europa.eu/esco/api/search?text=devops&type=occupation&language=en), accessed 2026-11-16.
- ESCO ISCO 251 (software and applications developers and analysts) has unit groups 2511–2514 and 2519. ISCO 252 has 2521–2523 and 2529. Source: [ESCO API concept C25](https://ec.europa.eu/esco/api/resource/concept?uri=http://data.europa.eu/esco/isco/C25&language=en), accessed 2026-11-16.
- The SO 2025 `DevType` question ("Which of the following describes your current job…") has 34
  answers. Developer answers: full-stack 27%, back-end 14.2%, desktop or enterprise 4.3%, front-end
  4.3%, mobile 3%, embedded 2.8%, game or graphics 0.9%, QA or test 0.8%, AI apps or physical AI
  0.5%. Other technical answers: Architect, software or solutions 6.1% (new this year), Engineering
  manager 2.4%, DevOps 2.3%, Data engineer 1.7%, AI/ML engineer 1.4%, Data scientist 1.2%,
  Cybersecurity 1.1%, System administrator 1%, Cloud infrastructure engineer 1%, Data or business
  analyst 0.9%, Applied scientist 0.6%, Support engineer 0.5%, Database administrator or engineer
  0.4%, UX/UI 0.3%, Site reliability engineer 0.1%. Source: [Stack Overflow Developer Survey 2025 — Developers](https://survey.stackoverflow.co/2025/developers), accessed 2026-11-16.
- The live DOU vacancy filter offers categories mixing languages (.NET, Java, Python, PHP, Golang,
  Ruby, Rust, Scala, Erlang, C++, Node.js, Flutter, React Native, Unity, Unreal Engine) with functions
  (Front End, DevOps, QA, Data Engineer, Data Science, AI/ML, Big Data, DBA, Embedded, Hardware,
  Security, SysAdmin, Architect, Engineering Manager, Blockchain, ERP/CRM, Salesforce, SAP, No-code,
  Support, Technical Writer) and non-IT categories. Source: [jobs.dou.ua/vacancies](https://jobs.dou.ua/vacancies/) `<option>` list, accessed 2026-11-16.
  The repo's `ALLOWED_CATEGORIES` (in `apps/api/src/job-sourcing/dou.provider.ts`) also has
  Fullstack, Kotlin, Swift, SRE, Machine Learning and QA Automation, which the scraped option list
  did not show (they may be sub-categories rendered by JS).
- Djinni's category tree (the `tms-data` JSON on the jobs page) has 11 groups: Розробка, QA,
  Креатив і геймдев, Дані та аналітика, Менеджмент, Лідерство, Операції (Ops), Hardware та інженерія,
  Маркетинг і продажі, Рекрутинг, Інше. Each key has a label and children (for example key
  `Unity` is labelled "Gamedev", key `Lead` is "Tech Leadership" with children CTO, Engineering
  Manager and Architect). Source: [djinni.co/jobs](https://djinni.co/jobs/), accessed 2026-11-16.
- Remotive categories include `software-development`, `devops`, `qa`, `data`,
  `artificial-intelligence`, `design`, `information-technology` and `engineering`, plus non-IT
  categories. Source: [Remotive API categories](https://remotive.com/api/remote-jobs/categories), accessed 2026-11-16.
- We Work Remotely job categories are Full-Stack, Back-End and Front-End Programming, DevOps and
  Sysadmin, Design, Product, Management and Finance, Customer Support, Sales and Marketing, and All
  Other. Source: [WWR all-jobs RSS](https://weworkremotely.com/remote-jobs.rss) `<category>` values and per-category feeds such as [remote-back-end-programming-jobs.rss](https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss), accessed 2026-11-16.
- Arbeitnow has **no** category taxonomy. Its `tags` are free text set by each employer: in 300
  jobs, the top tags were "Remote", "Engineering", "Sales", "Software Development" and "Distribution".
  Source: [Arbeitnow job-board API](https://www.arbeitnow.com/api/job-board-api), accessed 2026-11-16.
- SFIA 9 lists 147 **skills** (for example PROG Programming/software development, DENG Data
  engineering, MLNG Machine learning, PENT Penetration testing, RESD Real-time/embedded systems
  development). It is a skills-and-levels framework, not a role list. Source: [SFIA 9 skills A–Z](https://sfia-online.org/en/sfia-9/all-skills-a-z), accessed 2026-11-16.

## Applicability to us

- **Storage.** The repo already models closed vocabularies as `pgEnum` in
  `apps/api/src/database/schema/enums.ts` and Zod enums in `@crm/shared`. No technical-role enum
  exists yet: a `git grep` for specialization, role-taxonomy and job-role terms in
  `packages/shared/src/schemas` and `apps/api/src/database/schema` found none. Seniors' roles go in
  a join table or an enum array, `1..N`, and so do vacancy roles. Store the classifier's output with
  its **reason** (which keyword or rule fired), so a misclassification can be traced.
- **The sources this CRM ingests** decide the hint tables. The DOU provider filters by
  `ALLOWED_CATEGORIES` and the Djinni provider by `DJINNI_PRIMARY_KEYWORDS`. Both are covered in
  section 3.5. Greenhouse, Lever, Ashby, Workable and Arbeitnow give free-text departments or tags,
  so for them the **title** classifier is the only signal.
- **Domains** (AI, EdTech, E-Commerce) are not roles. E-Commerce mostly shows up as
  `FULLSTACK_ENGINEER` / `BACKEND_ENGINEER` with Magento or Shopify skills. AI shows up as
  `AI_ENGINEER` / `ML_ENGINEER` / `DATA_*`.
- **Product i18n.** The uk labels are proposals and need `copy-reviewer` before they enter the
  Lingui `uk` catalog. The en labels are the canonical ones.

## What could not be established

- **BLS SOC 2018 pages returned HTTP 403** to a plain client. The SOC 15-12xx codes are cited
  through the O*NET 30.0 data file, which carries the same SOC detail codes, plus the O*NET `.0x`
  extensions. Confidence is high, because O*NET-SOC is built on SOC 2018.
- **The We Work Remotely category page returned a Cloudflare challenge.** The category list comes
  from the RSS `<category>` values and the per-category RSS feeds instead. `remote-programming-jobs.rss`
  answered with the generic site title, so it is **not** treated as a real category.
- **Remotive and Arbeitnow:** Remotive's categories come from its API, not a rendered page.
  Arbeitnow has no taxonomy at all.
- **SFIA 9 role families** (the published "roles" view) need a login. Only the public skills list
  was used, and only as SFIA skill codes per role.
- **No primary source exists for Ukrainian role labels or uk/ru title synonyms.** They are this
  file's proposals. Board titles on DOU and Djinni are mostly English.
- **Classifier quality is not measured.** The dry run (section 3.4) shows the rules behave on 109
  real and 83 synthetic titles (title-only, step 9 not exercised), but no labelled set exists to
  give precision and recall. Next step: label about 300 queue vacancies by hand and measure.
- **DOU drift (†):** 9 values of the repo's `ALLOWED_CATEGORIES` (JavaScript, Fullstack, Kotlin,
  Swift, iOS, QA Automation, SRE, Machine Learning, Business Analyst) are not in the live DOU
  category option list. It was not checked whether DOU still honours them as `?category=`. A
  dropped category would return an empty or unfiltered feed, so this is worth checking in the
  DOU provider.
- **Djinni category tree depth:** the scrape printed 2 levels. Coverage was then checked against the
  repo constant `DJINNI_PRIMARY_KEYWORDS` (157 keys, all accounted for in section 1 or 3.5). A
  deeper level, if one exists, was not seen.

## Open decisions (for the owner)

1. **Matching semantics between seniors and vacancies.** Does a senior tagged `BACKEND_ENGINEER`
   see `FULLSTACK_ENGINEER` and generic `SOFTWARE_ENGINEER` vacancies in the queue?
   _Recommendation:_ store exact roles, and let the queue filter expand through a small fixed
   adjacency map. `BACKEND` and `FRONTEND` include `FULLSTACK` and `SOFTWARE_ENGINEER`.
   `DEVOPS_ENGINEER` and `SITE_RELIABILITY_ENGINEER` include each other. `QA_ENGINEER` and
   `QA_AUTOMATION_ENGINEER` include each other. Tags stay clean, and the expansion can be tuned
   without re-tagging. This is A2: cheap to change later, but it affects what HR sees.
2. **Is `AI_ENGINEER` a separate role from `ML_ENGINEER`?** SO 2025 separates them, and AI is a
   company domain. Titles blur them, though: "AI Engineer" is used for both, and ESCO v1.2.1 has one
   "artificial intelligence engineer". _Recommendation:_ keep both, with the LLM/RAG/agent
   precedence rule (section 3.1, step 4). Merge them later if the queue shows the split is noise.
   Merging values is easier than splitting tagged data.
3. **Keep the adjacent group (`BUSINESS_ANALYST`, `UI_UX_DESIGNER`) and `SUPPORT_ENGINEER` in the
   enum, or drop them?** They are inside O*NET/ESCO computer occupations and the company can staff
   them, but they are not developer roles. _Recommendation:_ keep them. Without them, those
   vacancies land in "unclassified" and pollute it. HR can hide them with the filter. Dropping
   them later is the cheaper direction only if no senior or vacancy carries them yet.

Smaller decisions this file took on its own (A1, reversible in one PR):

- Tech Lead and Team Lead are not roles.
- SRE is separate from DevOps.
- Cloud is merged into DevOps.
- Mobile has 3 roles.
- ERP/CRM/low-code is one role.
- Technical Writer and game design are excluded.
- `SOFTWARE_ENGINEER` is a fallback that is never assigned to seniors.

## 4. Sources (all accessed 2026-11-16)

1. O*NET 30.0 database, `Occupation Data.txt` — https://www.onetcenter.org/dl_files/database/db_30_0_text/Occupation%20Data.txt
2. BLS SOC 2018 major groups (HTTP 403 to the fetch, cited via 1) — https://www.bls.gov/soc/2018/major_groups.htm
3. ESCO REST API, ISCO concept C25 (ICT professionals) — https://ec.europa.eu/esco/api/resource/concept?uri=http://data.europa.eu/esco/isco/C25&language=en
4. ESCO REST API, occupation search with `selectedVersion=v1.2.1` — https://ec.europa.eu/esco/api/search?text=software%20developer&type=occupation&language=en&selectedVersion=v1.2.1
5. ESCO REST API documentation — https://ec.europa.eu/esco/api/doc/esco_api_doc.html
6. Stack Overflow Developer Survey 2025, Developers — Role — https://survey.stackoverflow.co/2025/developers
7. SFIA 9, all skills A–Z — https://sfia-online.org/en/sfia-9/all-skills-a-z
8. DOU vacancies (category filter) — https://jobs.dou.ua/vacancies/
9. Djinni jobs (category tree, `primary_keyword`) — https://djinni.co/jobs/
10. Remotive API, categories — https://remotive.com/api/remote-jobs/categories
11. We Work Remotely, all-jobs RSS — https://weworkremotely.com/remote-jobs.rss ; category feeds `https://weworkremotely.com/categories/<slug>.rss`
12. Arbeitnow job-board API — https://www.arbeitnow.com/api/job-board-api
13. Repo constants (not external): `ALLOWED_CATEGORIES` in `apps/api/src/job-sourcing/dou.provider.ts`, `DJINNI_PRIMARY_KEYWORDS` in `apps/api/src/job-sourcing/providers/sources/djinni.provider.ts`

## Appendix A: scratch classifier used for the dry run (section 3.4)

Python 3, standard library only. Call `classify(title)`. It returns a list of role ids, `['-EXCLUDED-']`, or `[]` for unclassified. A `(hint)` suffix marks a tech-hint result (section 3.2). It is evidence for this file, not production code.

```python
import re
# role -> patterns (case-insensitive, matched with word boundaries via \b in the pattern)
R = {
 # Software engineering
 'BACKEND_ENGINEER': [r'back[\s-]?end', r'server[\s-]side', r'api (developer|engineer)', r'integration (developer|engineer)', r'бек[\s-]?енд', r'бэк[\s-]?енд', r'бекенд', r'бэкенд'],
 'FRONTEND_ENGINEER': [r'front[\s-]?end', r'ui (developer|engineer)', r'web ui', r'html\W?css', r'markup', r'layout designer', r'верстальщик', r'верстальник', r'фронт[\s-]?енд', r'фронтенд'],
 'FULLSTACK_ENGINEER': [r'full[\s-]?stack', r'фулл?[\s-]?стек'],
 'DESKTOP_ENGINEER': [r'desktop', r'wpf', r'winforms', r'qt developer'],
 'BUSINESS_APPLICATIONS_ENGINEER': [r'salesforce', r'\bsap\b', r'abap', r'\berp\b', r'\bcrm developer', r'dynamics 365', r'ms dynamics', r'odoo', r'\b1c\b', r'1с\b', r'servicenow', r'netsuite', r'no[\s-]?code', r'low[\s-]?code', r'power platform', r'hubspot developer'],
 # Mobile
 'IOS_ENGINEER': [r'\bios\b', r'swift(ui)?\b', r'macos'],
 'ANDROID_ENGINEER': [r'android'],
 'CROSS_PLATFORM_MOBILE_ENGINEER': [r'flutter', r'react native', r'xamarin', r'\bmaui\b', r'kotlin multiplatform', r'\bkmp\b', r'cross[\s-]?platform mobile', r'mobile (developer|engineer)', r'мобільн', r'мобильн'],
 # Data & AI
 'DATA_ENGINEER': [r'data engineer', r'big data', r'\betl\b', r'data platform engineer', r'analytics engineer', r'data warehouse', r'dwh', r'spark developer', r'інженер даних', r'инженер данных'],
 'DATABASE_ENGINEER': [r'\bdba\b', r'database (administrator|engineer|developer|architect)', r'sql developer', r'pl/?sql', r'postgres(ql)? (dba|engineer)', r'адміністратор баз', r'администратор баз'],
 'DATA_ANALYST': [r'data analyst', r'\bbi (developer|analyst|engineer)', r'business intelligence', r'power bi', r'tableau', r'product analyst', r'web analyst', r'аналітик даних', r'аналитик данных'],
 'DATA_SCIENTIST': [r'data scien', r'statistician', r'quantitative (analyst|researcher)', r'research scientist'],
 'ML_ENGINEER': [r'machine learning', r'\bml\b', r'mlops', r'deep learning', r'computer vision', r'\bcv engineer', r'\bnlp\b', r'applied scientist', r'ml/ai', r'ai/ml'],
 'AI_ENGINEER': [r'\bai engineer', r'\bai developer', r'\bllm\b', r'genai', r'generative ai', r'prompt engineer', r'\brag\b', r'ai agent', r'agentic', r'ai (application|solutions) (engineer|developer)', r'artificial intelligence engineer'],
 # Infra & ops
 'DEVOPS_ENGINEER': [r'devops', r'dev ops', r'cloudops', r'platform engineer', r'cloud engineer', r'infrastructure engineer', r'kubernetes', r'release engineer', r'build engineer', r'devsecops', r'девопс'],
 'SITE_RELIABILITY_ENGINEER': [r'\bsre\b', r'site reliability', r'reliability engineer', r'production engineer', r'observability engineer'],
 'SYSTEM_ADMINISTRATOR': [r'it systems engineer', r'it infrastructure engineer', r'windows engineer', r'linux engineer', r'sys\s?admin', r'system(s)? administrator', r'linux administrator', r'windows administrator', r'it administrator', r'системн\w* адміністратор', r'системн\w* администратор', r'сисадмін', r'сисадмин'],
 'NETWORK_ENGINEER': [r'network (engineer|administrator|architect)', r'\bnoc\b', r'telecom(munications)? engineer', r'мережев', r'сетев'],
 'SUPPORT_ENGINEER': [r'support engineer', r'application support', r'technical support', r'\bl[23] support', r'tech support', r'it support', r'help\s?desk', r'service desk'],
 # QA
 'QA_ENGINEER': [r'\bqa\b', r'quality assurance', r'tester', r'test engineer', r'manual test', r'тестувальник', r'тестировщик', r'тестуван', r'тестирован'],
 'QA_AUTOMATION_ENGINEER': [r'qa automation', r'automation qa', r'aqa', r'test automation', r'automated test', r'automation (test|tester|engineer)', r'\bsdet\b', r'software development engineer in test', r'performance test', r'load test'],
 # Security
 'SECURITY_ENGINEER': [r'security engineer', r'appsec', r'application security', r'devsecops', r'cloud security', r'product security', r'cyber\s?security engineer', r'security architect', r'information security'],
 'SECURITY_ANALYST': [r'security analyst', r'\bsoc\b', r'incident respon', r'threat (intel|hunt)', r'\bgrc\b', r'security operations', r'digital forensic', r'кібербезпек', r'кибербезопасн', r'інформаційн\w* безпек', r'информационн\w* безопасн'],
 'PENETRATION_TESTER': [r'penetration test', r'pen[\s-]?test', r'ethical hack', r'red team', r'offensive security', r'bug bounty'],
 # Embedded & hardware
 'EMBEDDED_ENGINEER': [r'embedded', r'firmware', r'\brtos\b', r'\biot\b', r'robotics', r'microcontroller', r'\bmcu\b', r'вбудован', r'встроен'],
 'HARDWARE_ENGINEER': [r'hardware engineer', r'electronics engineer', r'\bpcb\b', r'fpga', r'\basic\b', r'chip design', r'\bvlsi\b', r'\brf engineer', r'verilog', r'vhdl', r'schematic'],
 # Game
 'GAME_DEVELOPER': [r'game (developer|programmer|engineer)', r'gameplay', r'unity (developer|engineer)', r'unreal', r'\bue[45]\b', r'graphics (programmer|engineer)', r'rendering engineer', r'\bxr\b', r'\bar/vr\b', r'\bvr developer', r'gamedev', r'геймдев'],
 # Blockchain
 'BLOCKCHAIN_ENGINEER': [r'blockchain', r'solidity', r'smart contract', r'web3', r'\bdefi\b', r'crypto (developer|engineer)', r'\bevm\b', r'rust (blockchain|solana)', r'solana'],
 # Architecture & leadership
 'SOFTWARE_ARCHITECT': [r'architect'],
 'ENGINEERING_MANAGER': [r'engineering manager', r'head of (engineering|development|software|r&d)', r'director of engineering', r'engineering director', r'(?<!business )development manager', r'manager,? engineering', r'r&d manager', r'\bvp,? (of )?engineering', r'delivery head'],
 'CTO': [r'\bcto\b', r'head of technology', r'vp,? (of )?technology', r'chief technology officer', r'chief technical officer', r'технічн\w* директор', r'технический директор'],
 # Adjacent
 'BUSINESS_ANALYST': [r'business analyst', r'systems analyst', r'system analyst', r'\bba\b', r'бізнес[\s-]?аналітик', r'бизнес[\s-]?аналитик', r'системн\w* аналітик', r'системн\w* аналитик'],
 'UI_UX_DESIGNER': [r'ui/?ux', r'ux/?ui', r'product designer', r'ux designer', r'ui designer', r'interaction designer', r'ux research', r'дизайнер інтерфейс', r'дизайнер интерфейс'],
 # Generic fallback (only when nothing else matched)
 'SOFTWARE_ENGINEER': [r'software (engineer|developer)', r'\bswe\b', r'product engineer', r'programmer', r'developer', r'\bdev\b', r'engineer', r'розробник', r'разработчик', r'програміст', r'программист'],
}
# words that NEVER make a role (seniority / employment form)
SENIORITY = r'\b(junior|middle|mid|senior|sr|jr|staff|principal|lead|team lead|tech lead|chief|head|intern|trainee|стажер|джуніор|сеньйор|сеньор|мідл|ведучий|ведущий|провідний)\b'
# technology tokens -> default role when no role noun matched (hints, never override a role noun)
TECH_HINT = {
 r'\b(java|golang|go|python|php|ruby|rails|scala|elixir|rust|c#|\.net|node\.?js|nestjs|django|laravel|spring)\b': 'BACKEND_ENGINEER',
 r'\b(magento|shopify|wordpress|drupal|bitrix)\b': 'FULLSTACK_ENGINEER',
 r'\b(react|angular|vue|svelte|next\.?js|javascript|typescript|js)\b': 'FRONTEND_ENGINEER',
 r'(c\+\+|\bkotlin\b)': None,  # ambiguous: backend / embedded / game / desktop
}
EXCLUDE_PHRASE = r'\b(aso|sales engineer|solutions engineer|presales|pre-sales|business development|sales (manager|representative|executive|lead|specialist)|account (executive|manager)|recruiter|recruiting|talent acquisition|hr (manager|business partner|generalist)|marketing (manager|specialist|lead)|seo (specialist|manager)|copywriter|customer (success|support|service)|accountant|finance manager|product manager|project manager|delivery manager|product owner|scrum master|lawyer|landscape architect|interior architect|building architect)\b'
EXCLUDE_BARE = r'\b(sales|marketing|recruit\w*|hr|legal|seo|finance)\b'
ENG_NOUN = r'(developer|engineer|programmer|architect|devops|\bqa\b|tester|scientist|analyst|administrator|\bsre\b|\bdba\b|розробник|разработчик|програміст|программист|інженер|инженер)'
GENERIC_SKIP_IF = ['SOFTWARE_ENGINEER']
JOB_NOUN = r'(developer|engineer|programmer|architect|designer|analyst|administrator|admin\b|tester|\bqa\b|aqa|sdet|scientist|\bdba\b|\bsre\b|devops|pentester|hacker|\bcto\b|head of|director|vp\b|development manager|r&d manager|lead\b|specialist|expert|consultant|researcher|\bdev\b|розробник|разработчик|програміст|программист|тестувальник|тестировщик|адміністратор|администратор|аналітик|аналитик|архітектор|архитектор|дизайнер|інженер|инженер|сисадм|верстальщик|верстальник)'
ARCH_DOMAIN = {r'\bdata\b':'DATA_ENGINEER', r'(cloud|infrastructure|devops|platform)':'DEVOPS_ENGINEER', r'security':'SECURITY_ENGINEER', r'network':'NETWORK_ENGINEER', r'\b(ml|ai|machine learning)\b':'ML_ENGINEER', r'\b(salesforce|sap|erp|crm)\b':'BUSINESS_APPLICATIONS_ENGINEER', r'(front[\s-]?end)':'FRONTEND_ENGINEER', r'mobile':'CROSS_PLATFORM_MOBILE_ENGINEER'}
def classify(title):
    t=title.lower()
    hits=[]
    if re.search(EXCLUDE_PHRASE,t): return ['-EXCLUDED-']
    if re.search(EXCLUDE_BARE,t) and not re.search(ENG_NOUN,t): return ['-EXCLUDED-']
    if not re.search(JOB_NOUN,t): return []
    for role,pats in R.items():
        if role in GENERIC_SKIP_IF: continue
        if any(re.search(p if p.startswith(r'\b') else r'(?<![a-z0-9])'+p, t) for p in pats): hits.append(role)
    # precedence: automation beats manual QA; full-stack beats front+back; SRE+DevOps both kept
    if 'QA_AUTOMATION_ENGINEER' in hits and 'QA_ENGINEER' in hits: hits.remove('QA_ENGINEER')
    if 'FULLSTACK_ENGINEER' in hits:
        hits=[h for h in hits if h not in ('FRONTEND_ENGINEER','BACKEND_ENGINEER')]
    if 'PENETRATION_TESTER' in hits and 'QA_ENGINEER' in hits: hits.remove('QA_ENGINEER')
    if 'AI_ENGINEER' in hits and 'ML_ENGINEER' in hits and re.search(r'\b(llm|genai|generative|agent|rag|prompt)',t): hits.remove('ML_ENGINEER')
    if 'SOFTWARE_ARCHITECT' in hits:
        for p,role in ARCH_DOMAIN.items():
            if re.search(p,t) and role not in hits: hits.append(role)
    if 'ENGINEERING_MANAGER' in hits or 'CTO' in hits:
        hits=[h for h in hits if h in ('ENGINEERING_MANAGER','CTO')] or hits
    if not hits:
        for p,role in TECH_HINT.items():
            if re.search(p,t) and role and re.search(r'(developer|engineer|programmer|розробник|разработчик|програміст|программист|dev\b|lead\b)',t): return [role+'(hint)']
        if any(re.search(r'(?<![a-z0-9])'+p,t) for p in R['SOFTWARE_ENGINEER']) and re.search(r'(software|developer|programmer|розробник|разработчик|програміст|программист|\bswe\b)',t):
            return ['SOFTWARE_ENGINEER']
    return hits
```
