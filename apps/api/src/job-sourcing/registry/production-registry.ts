import type { JobSourceType } from '@crm/shared'
import type { ConfigService } from '@nestjs/config'
import type { Env } from '../../config/env'
import type { DouRssProvider } from '../dou.provider'
import type { ReportingJobSourceProvider } from '../providers/reporting-provider'
import { arbeitnowProvider } from '../providers/sources/arbeitnow.provider'
import { ashbyProvider } from '../providers/sources/ashby.provider'
import { djinniProvider } from '../providers/sources/djinni.provider'
import { euRemoteJobsProvider } from '../providers/sources/euremotejobs.provider'
import { createGreenhouseProvider } from '../providers/sources/greenhouse.provider'
import { himalayasProvider } from '../providers/sources/himalayas.provider'
import { hnHiringProvider } from '../providers/sources/hn-hiring.provider'
import { jobgetherProvider } from '../providers/sources/jobgether.provider'
import { jobicyProvider } from '../providers/sources/jobicy.provider'
import { createJoobleProvider } from '../providers/sources/jooble.provider'
import { createJSearchProvider } from '../providers/sources/jsearch.provider'
import { createReedProvider } from '../providers/sources/reed.provider'
import { leverProvider } from '../providers/sources/lever.provider'
import { nextLevelJobsProvider } from '../providers/sources/nextleveljobs.provider'
import { landingJobsProvider } from '../providers/sources/landingjobs.provider'
import { justJoinProvider } from '../providers/sources/justjoin.provider'
import { theHubProvider } from '../providers/sources/thehub.provider'
import { diceProvider } from '../providers/sources/dice.provider'
import { nofluffProvider } from '../providers/sources/nofluff.provider'
import { personioProvider } from '../providers/sources/personio.provider'
import { recruiteeProvider } from '../providers/sources/recruitee.provider'
import { remoteokProvider } from '../providers/sources/remoteok.provider'
import { remotiveProvider } from '../providers/sources/remotive.provider'
import { smartrecruitersProvider } from '../providers/sources/smartrecruiters.provider'
import { createTheirStackProvider } from '../providers/sources/theirstack.provider'
import { workableProvider } from '../providers/sources/workable.provider'
import { workingNomadsProvider } from '../providers/sources/workingnomads.provider'
import { germanTechJobsProvider } from '../providers/sources/germantechjobs.provider'
import { fourDayWeekProvider } from '../providers/sources/fourdayweek.provider'
import { jobTechProvider } from '../providers/sources/jobtech.provider'
import { wwrProvider } from '../providers/sources/wwr.provider'
import { type QuotaEnvKey, type QuotaProvider, readQuotaCredential } from '../quota-credentials'
import { productionLedgerCatalog } from '../runtime/production-catalog'
import { JobSourceRegistry } from './job-source-registry'
import { LegacyDouAdapter, type RegisteredAdapter, ReportingAdapter } from './registered-adapter'
import { REPORTING_WIRING } from './reporting-wiring'

/** Reads one credential env key; `undefined` = not configured. */
type ReadKey = (key: QuotaEnvKey) => string | undefined

/**
 * Every REPORTING provider the application can run, one per type, built for production. Each is
 * registered with its `REPORTING_WIRING` entry (see `createProductionRegistry`); a provider here
 * without wiring would never be claimed (`TRANSPORT_NOT_WIRED`), so the spec keeps this list and
 * the wiring equal. Only legacy DOU is absent, and it is not a reporting adapter at all.
 *
 * Keyed adapters get their credential from the validated env. An absent key builds an
 * UNCONFIGURED credential: the adapter refuses before any reservation or request.
 */
function reportingProviders(
  read: ReadKey,
  onDemand: readonly JobSourceType[],
): readonly ReportingJobSourceProvider[] {
  const credential = (provider: QuotaProvider) => ({
    credential: readQuotaCredential(provider, read),
  })
  // U10: Greenhouse carries `collectDetail` only once its manifest entry is flipped to ON_DEMAND.
  const greenhouseMode = onDemand.includes('GREENHOUSE_ATS')
    ? // Stryker disable next-line StringLiteral: equivalent — `createGreenhouseProvider` branches on `mode === 'IN_LIST'` only, so '' builds the same ON_DEMAND provider; `DetailMode` refuses '' at compile time.
      'ON_DEMAND'
    : 'IN_LIST'
  return [
    arbeitnowProvider,
    ashbyProvider,
    djinniProvider,
    euRemoteJobsProvider,
    createGreenhouseProvider(greenhouseMode),
    himalayasProvider,
    hnHiringProvider,
    jobgetherProvider,
    jobicyProvider,
    createJoobleProvider(credential('jooble')),
    createJSearchProvider(credential('jsearch')),
    createReedProvider(credential('reed')),
    leverProvider,
    nextLevelJobsProvider,
    theHubProvider,
    justJoinProvider,
    landingJobsProvider,
    diceProvider,
    nofluffProvider,
    personioProvider,
    recruiteeProvider,
    remoteokProvider,
    remotiveProvider,
    smartrecruitersProvider,
    createTheirStackProvider(credential('theirstack')),
    workableProvider,
    workingNomadsProvider,
    germanTechJobsProvider,
    fourDayWeekProvider,
    jobTechProvider,
    wwrProvider,
  ]
}

/**
 * The registry the application runs with: DOU on the legacy contract, plus every REPORTING
 * adapter that has a `REPORTING_WIRING` entry, built with that entry (version + pinned hosts).
 *
 * !! REGISTERING IS NOT ENABLING. The run ledger still claims a source only when its manifest
 * entry is CANDIDATE, its payload verified, no blocker stands and its row is enabled
 * (`claimGate`); a BLOCKED type stays refused whatever is registered here.
 *
 * The ONE place a registry is made from a bare DOU provider: the module's factory and
 * `resolveRegistry` (the service's constructor) both go through it, so they cannot disagree.
 * `config` absent (hand-built specs) = every keyed adapter unconfigured. `onDemand` defaults to the
 * production catalog's ON_DEMAND types (a spec passes its own to reach both Greenhouse modes).
 */
export function createProductionRegistry(
  dou: DouRssProvider,
  config?: ConfigService<Env, true>,
  onDemand: readonly JobSourceType[] = productionLedgerCatalog().onDemandTypes(),
): JobSourceRegistry {
  const read: ReadKey = (key) => config?.get(key, { infer: true })
  const adapters: RegisteredAdapter[] = [new LegacyDouAdapter(dou)]
  for (const provider of reportingProviders(read, onDemand)) {
    // No wiring = an unwired adapter the ledger refuses (`TRANSPORT_NOT_WIRED`); the spec keeps
    // this list equal to `REPORTING_WIRING`, so none is registered that way.
    adapters.push(new ReportingAdapter(provider, REPORTING_WIRING[provider.type]))
  }
  return new JobSourceRegistry(adapters)
}

/**
 * What `JobSourcingService` was handed: the registry, or (for callers that build the service by
 * hand, e.g. the DOU golden specs) a bare DOU provider. Anything else is refused loudly -- a
 * registry-shaped mock must not be silently wrapped as a provider with no type.
 */
export function resolveRegistry(source: JobSourceRegistry | DouRssProvider): JobSourceRegistry {
  if (source instanceof JobSourceRegistry) return source
  if (typeof (source as { type?: unknown } | null | undefined)?.type !== 'string') {
    throw new TypeError(
      'JobSourcingService needs a JobSourceRegistry or a DouRssProvider; got something with no source type',
    )
  }
  return createProductionRegistry(source)
}
