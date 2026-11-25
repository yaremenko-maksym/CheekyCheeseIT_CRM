import type { JobSourceType } from '@crm/shared'
import { readQuotaCredential } from '../quota-credentials'
import type { ReportingJobSourceProvider } from './reporting-provider'
import { arbeitnowProvider } from './sources/arbeitnow.provider'
import { ashbyProvider } from './sources/ashby.provider'
import { djinniProvider } from './sources/djinni.provider'
import { euRemoteJobsProvider } from './sources/euremotejobs.provider'
import { greenhouseProvider } from './sources/greenhouse.provider'
import { himalayasProvider } from './sources/himalayas.provider'
import { hnHiringProvider } from './sources/hn-hiring.provider'
import { jobgetherProvider } from './sources/jobgether.provider'
import { jobicyProvider } from './sources/jobicy.provider'
import { createJoobleProvider } from './sources/jooble.provider'
import { createJSearchProvider } from './sources/jsearch.provider'
import { leverProvider } from './sources/lever.provider'
import { personioProvider } from './sources/personio.provider'
import { recruiteeProvider } from './sources/recruitee.provider'
import { createReedProvider } from './sources/reed.provider'
import { nextLevelJobsProvider } from './sources/nextleveljobs.provider'
import { landingJobsProvider } from './sources/landingjobs.provider'
import { justJoinProvider } from './sources/justjoin.provider'
import { theHubProvider } from './sources/thehub.provider'
import { relocateMeProvider } from './sources/relocateme.provider'
import { reactJobsProvider } from './sources/reactjobs.provider'
import { remoteIoProvider } from './sources/remoteio.provider'
import { remoteFirstJobsProvider } from './sources/remotefirstjobs.provider'
import { jobspressoProvider } from './sources/jobspresso.provider'
import { diceProvider } from './sources/dice.provider'
import { nofluffProvider } from './sources/nofluff.provider'
import { remoteokProvider } from './sources/remoteok.provider'
import { remotiveProvider } from './sources/remotive.provider'
import { smartrecruitersProvider } from './sources/smartrecruiters.provider'
import { createTheirStackProvider } from './sources/theirstack.provider'
import { workableProvider } from './sources/workable.provider'
import { workingNomadsProvider } from './sources/workingnomads.provider'
import { germanTechJobsProvider } from './sources/germantechjobs.provider'
import { fourDayWeekProvider } from './sources/fourdayweek.provider'
import { jobTechProvider } from './sources/jobtech.provider'
import { wwrProvider } from './sources/wwr.provider'
import { pythonOrgProvider } from './sources/pythonorg.provider'
import { solidJobsProvider } from './sources/solidjobs.provider'
import { berlinStartupJobsProvider } from './sources/berlinstartupjobs.provider'
import { helloworldProvider } from './sources/helloworld.provider'
import { larajobsProvider } from './sources/larajobs.provider'

/**
 * The adapters whose INSTANCE `parseConfig` validates a manifest entry's config.
 *
 * !! THIS IS NOT A REGISTRY. It exists so the manifest can ask an adapter "do you accept this
 * config?" and for nothing else; `collectReport` is never called through it, no context is built,
 * and nothing in the pipeline (`job-sourcing.module.ts`, `job-sourcing.service.ts`) imports it
 * (`manifest.drift.spec.ts` asserts that). Registering adapters is plan Task 2.5, which must replace
 * the need for this map rather than extend it. The plan forbids a second registry bridging the gap
 * in the meantime, because a bridge is an optional constructor argument that changes the
 * production pipeline.
 *
 * The four keyed adapters are built with a credential that is NOT configured: `parseConfig` never
 * reads it, and an unconfigured one makes a `collectReport` call through here refuse before any
 * request, which is the safe failure for a map that must not be used to collect.
 */
// Stryker disable next-line StringLiteral: the provider name only selects which env key the reader asks for, and the reader answers the same unconfigured credential whatever it is given
const NO_KEY = readQuotaCredential('jooble', () => undefined)

type Validator = Pick<ReportingJobSourceProvider, 'type' | 'parseConfig'>

const VALIDATORS = [
  remoteokProvider,
  remotiveProvider,
  himalayasProvider,
  jobicyProvider,
  arbeitnowProvider,
  workingNomadsProvider,
  jobgetherProvider,
  hnHiringProvider,
  greenhouseProvider,
  leverProvider,
  ashbyProvider,
  workableProvider,
  smartrecruitersProvider,
  recruiteeProvider,
  personioProvider,
  createJoobleProvider({ credential: NO_KEY }),
  createJSearchProvider({ credential: NO_KEY }),
  createTheirStackProvider({ credential: NO_KEY }),
  createReedProvider({ credential: NO_KEY }),
  djinniProvider,
  wwrProvider,
  pythonOrgProvider,
  solidJobsProvider,
  berlinStartupJobsProvider,
  helloworldProvider,
  euRemoteJobsProvider,
  nextLevelJobsProvider,
  theHubProvider,
  relocateMeProvider,
  reactJobsProvider,
  remoteIoProvider,
  remoteFirstJobsProvider,
  jobspressoProvider,
  justJoinProvider,
  landingJobsProvider,
  diceProvider,
  nofluffProvider,
  larajobsProvider,
  germanTechJobsProvider,
  fourDayWeekProvider,
  jobTechProvider,
] as Validator[]

export const MANIFEST_VALIDATION_ADAPTERS: ReadonlyMap<JobSourceType, Validator> = (() => {
  const byType = new Map<JobSourceType, Validator>()
  for (const p of VALIDATORS) byType.set(p.type, p)
  return byType
})()
