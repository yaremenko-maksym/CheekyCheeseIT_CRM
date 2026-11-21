import type { JobSourceType } from '@crm/shared'
import type { ValidatedSourceConfig } from '../providers/reporting-provider'
import { ARBEITNOW_ADAPTER_VERSION } from '../providers/sources/arbeitnow.provider'
import { ASHBY_ADAPTER_VERSION } from '../providers/sources/ashby.provider'
import { djinniSpec } from '../providers/sources/djinni.provider'
import { euRemoteJobsSpec } from '../providers/sources/euremotejobs.provider'
import { GREENHOUSE_ADAPTER_VERSION } from '../providers/sources/greenhouse.provider'
import { HIMALAYAS_ADAPTER_VERSION } from '../providers/sources/himalayas.provider'
import { HN_ADAPTER_VERSION } from '../providers/sources/hn-hiring.provider'
import { JOBGETHER_ADAPTER_VERSION } from '../providers/sources/jobgether.provider'
import { JOBICY_ADAPTER_VERSION } from '../providers/sources/jobicy.provider'
import { JOOBLE_ADAPTER_VERSION } from '../providers/sources/jooble.provider'
import { REED_ADAPTER_VERSION } from '../providers/sources/reed.provider'
import { JSEARCH_ADAPTER_VERSION } from '../providers/sources/jsearch.provider'
import { LEVER_ADAPTER_VERSION, LEVER_HOSTS } from '../providers/sources/lever.provider'
import { MUSE_ADAPTER_VERSION } from '../providers/sources/muse.provider'
import {
  NEXTLEVELJOBS_ADAPTER_VERSION,
  nextLevelJobsAllowedHosts,
} from '../providers/sources/nextleveljobs.provider'
import { WORKINGNOMADS_ADAPTER_VERSION } from '../providers/sources/workingnomads.provider'
import {
  PERSONIO_ADAPTER_VERSION,
  personioAllowedHosts,
} from '../providers/sources/personio.provider'
import {
  RECRUITEE_ADAPTER_VERSION,
  recruiteeAllowedHosts,
} from '../providers/sources/recruitee.provider'
import { REMOTEOK_ADAPTER_VERSION } from '../providers/sources/remoteok.provider'
import { REMOTIVE_ADAPTER_VERSION } from '../providers/sources/remotive.provider'
import {
  SMARTRECRUITERS_ADAPTER_VERSION,
  smartrecruitersAllowedHosts,
} from '../providers/sources/smartrecruiters.provider'
import { THEIRSTACK_ADAPTER_VERSION } from '../providers/sources/theirstack.provider'
import {
  WORKABLE_ADAPTER_VERSION,
  workableAllowedHosts,
} from '../providers/sources/workable.provider'
import { wwrSpec } from '../providers/sources/wwr.provider'
import type { ReportingWiring } from './registered-adapter'

/**
 * EACH REPORTING ADAPTER'S TRANSPORT DECLARATION (r5 Task 2.5 T6; PR #1138 SR-M-2): the version
 * stamped on its run rows and the EXACT hosts its requests may reach. The transport refuses any
 * other host, on the first request and on every redirect hop, before a byte is sent to it.
 *
 * Each host is the one the adapter's own code builds its request URLs on (its `ENDPOINT` / `HOST`
 * constant, or the exported `*AllowedHosts` of the adapters that already declared one), and
 * `reporting-wiring.spec.ts` asserts every request each adapter makes stays on its list.
 *
 * !! THIS IS DATA, NOT A REGISTRY, AND IT ACTIVATES NOTHING. `createProductionRegistry` registers
 * every type listed here with its entry; the claim also needs an activatable type and a ready
 * manifest entry. Wiring only lifts `TRANSPORT_NOT_WIRED` for a registered adapter.
 *
 * Deliberately NOT wired (no entry, so `TRANSPORT_NOT_WIRED` keeps them off):
 *  - `DOU_RSS`: the legacy contract, which does not go through this transport.
 *
 * `WORKINGNOMADS_API` was in that list while it was a blocked stub with no fetch path; task
 * sources-04 gave it a real adapter over `www.workingnomads.com/api/exposed_jobs/`, so it is wired
 * here like any other reporting type.
 */

/** The parsed config of a tenant or regional adapter, as its own `parseConfig` produced it. */
const board = (config: ValidatedSourceConfig) => config as unknown as { board: string }

export const REPORTING_WIRING: Readonly<Partial<Record<JobSourceType, ReportingWiring>>> =
  Object.freeze({
    ARBEITNOW_API: {
      adapterVersion: ARBEITNOW_ADAPTER_VERSION,
      allowedHosts: ['www.arbeitnow.com'],
    },
    ASHBY_ATS: { adapterVersion: ASHBY_ADAPTER_VERSION, allowedHosts: ['api.ashbyhq.com'] },
    DJINNI_RSS: { adapterVersion: djinniSpec.adapterVersion, allowedHosts: ['djinni.co'] },
    EUREMOTEJOBS_RSS: {
      adapterVersion: euRemoteJobsSpec.adapterVersion,
      allowedHosts: ['euremotejobs.com'],
    },
    GREENHOUSE_ATS: {
      adapterVersion: GREENHOUSE_ADAPTER_VERSION,
      allowedHosts: ['boards-api.greenhouse.io'],
    },
    HIMALAYAS_API: { adapterVersion: HIMALAYAS_ADAPTER_VERSION, allowedHosts: ['himalayas.app'] },
    HN_HIRING: { adapterVersion: HN_ADAPTER_VERSION, allowedHosts: ['hn.algolia.com'] },
    JOBGETHER_API: { adapterVersion: JOBGETHER_ADAPTER_VERSION, allowedHosts: ['jobgether.com'] },
    JOBICY_API: { adapterVersion: JOBICY_ADAPTER_VERSION, allowedHosts: ['jobicy.com'] },
    JOOBLE_API: { adapterVersion: JOOBLE_ADAPTER_VERSION, allowedHosts: ['jooble.org'] },
    JSEARCH_API: {
      adapterVersion: JSEARCH_ADAPTER_VERSION,
      allowedHosts: ['jsearch.p.rapidapi.com'],
    },
    LEVER_ATS: {
      adapterVersion: LEVER_ADAPTER_VERSION,
      allowedHosts: (config) => [
        LEVER_HOSTS[(config as unknown as { region: keyof typeof LEVER_HOSTS }).region],
      ],
    },
    MUSE_API: { adapterVersion: MUSE_ADAPTER_VERSION, allowedHosts: ['www.themuse.com'] },
    NEXTLEVELJOBS_HTML: {
      adapterVersion: NEXTLEVELJOBS_ADAPTER_VERSION,
      allowedHosts: nextLevelJobsAllowedHosts(),
    },
    PERSONIO_ATS: {
      adapterVersion: PERSONIO_ADAPTER_VERSION,
      allowedHosts: (config) =>
        personioAllowedHosts(config as unknown as { board: string; tld: string }),
    },
    RECRUITEE_ATS: {
      adapterVersion: RECRUITEE_ADAPTER_VERSION,
      allowedHosts: (config) => recruiteeAllowedHosts(board(config)),
    },
    REED_API: { adapterVersion: REED_ADAPTER_VERSION, allowedHosts: ['www.reed.co.uk'] },
    REMOTEOK_API: { adapterVersion: REMOTEOK_ADAPTER_VERSION, allowedHosts: ['remoteok.com'] },
    REMOTIVE_API: { adapterVersion: REMOTIVE_ADAPTER_VERSION, allowedHosts: ['remotive.com'] },
    SMARTRECRUITERS_ATS: {
      adapterVersion: SMARTRECRUITERS_ADAPTER_VERSION,
      allowedHosts: smartrecruitersAllowedHosts(),
    },
    THEIRSTACK_API: {
      adapterVersion: THEIRSTACK_ADAPTER_VERSION,
      allowedHosts: ['api.theirstack.com'],
    },
    WORKABLE_ATS: {
      adapterVersion: WORKABLE_ADAPTER_VERSION,
      allowedHosts: workableAllowedHosts(),
    },
    WORKINGNOMADS_API: {
      adapterVersion: WORKINGNOMADS_ADAPTER_VERSION,
      allowedHosts: ['www.workingnomads.com'],
    },
    WWR_RSS: { adapterVersion: wwrSpec.adapterVersion, allowedHosts: ['weworkremotely.com'] },
  })
