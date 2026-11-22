import { Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { INFERENCE_ERROR_CODES } from '@crm/inference'
import {
  mentionsSkill,
  type ResumeContent,
  type TailoredResumeErrorCode,
  type TailoredRunStage,
} from '@crm/shared'
import { DEFAULT_TAILORED_RESUME_MAX_CONCURRENT_RUNS, type Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { S3Service } from '../documents/s3.service'
import { productionLedgerCatalog } from '../job-sourcing/runtime/production-catalog'
import { ResumeTextExtractionService } from '../resumes/resume-text-extraction.service'
import { ResumeTypstService } from '../resumes/resume-typst.service'
import { RunFailure } from '../resumes/verification/content-gates'
import {
  ResumeEntailmentClient,
  VISUAL_PROVIDER,
  VisualCheckClient,
} from '../resumes/verification/inference-clients'
import { RunLost } from '../resumes/verification/run-end'
import type { RunOrigin } from '../resumes/verification/run-columns'
import { RunSlots } from '../resumes/verification/run-slots'
import { TAILOR_PROVIDER, TailorWriterClient } from './tailor-writer.client'
import { analysePosting } from './tailored-analysis'
import { TailoredDecisionClient } from './tailored-decision.client'
import { coverLetterText } from './tailored-draft'
import { renderEdit } from './tailored-edit'
import { generateVerified } from './tailored-generate'
import { prepareTailoring } from './tailored-prepare'
import { publishRun } from './tailored-publish'
import { renderVerified } from './tailored-render'
import type { Bucket } from './tailored-requirements'
import {
  claimRun,
  failRun,
  ownsRun,
  setStage,
  TailoredRunFailure,
  toTailoredCode,
  type TailoredRunOrigin,
} from './tailored-run'

/** Every provider a successful run calls: the writer, Jev (analysis, review, gates), the vision check. */
const ROUTES = [TAILOR_PROVIDER, 'jev', VISUAL_PROVIDER]
const REASONS: ReadonlySet<string> = new Set([...INFERENCE_ERROR_CODES, 'INVALID_INPUT'])

/**
 * A verified-base origin in the tailored log's closed reason set: its reason may carry a transport
 * suffix (`CODE:detail`), free text that never reaches the log; a code outside the set is
 * PROVIDER_ERROR.
 */
export function narrowOrigin(origin: RunOrigin | null): TailoredRunOrigin | null {
  if (origin === null) return null
  const code = origin.reason.split(':')[0] as string
  const reason = REASONS.has(code) ? (code as TailoredRunOrigin['reason']) : 'PROVIDER_ERROR'
  return { provider: origin.provider, reason, status: origin.status }
}

/** How a run's error ends it: its own code, a reused gate's mapped code, or INTERNAL_ERROR. */
export function runFailureOf(err: unknown): {
  code: TailoredResumeErrorCode
  origin: TailoredRunOrigin | null
} {
  if (err instanceof TailoredRunFailure) return { code: err.code, origin: err.origin }
  if (err instanceof RunFailure) {
    return { code: toTailoredCode(err.code), origin: narrowOrigin(err.origin) }
  }
  return { code: 'INTERNAL_ERROR', origin: null }
}

/**
 * Spec §6.4 item 15, on the final text: of the `existing` / `supported` requirements, the ones the
 * summary, the skills or a bullet mention. Information for HR only; nothing re-generates on it.
 */
export function coverageOf(
  content: ResumeContent,
  requirements: readonly { name: string; bucket: Bucket }[],
): { matched: string[]; total: number } {
  const texts = [
    content.summary,
    ...content.skills,
    ...content.experience.flatMap((e) => e.bullets),
  ]
  const counted = requirements.filter((r) => r.bucket !== 'gap')
  return {
    matched: counted.filter((r) => texts.some((t) => mentionsSkill(t, r.name))).map((r) => r.name),
    total: counted.length,
  }
}

/**
 * The tailored generation run (spec §6, §8), off the request path: claim, then the six stages —
 * prepare, analysis, the first draft, the gates and repair, the render, the visual check — and the
 * publish. Every stage write is the run's ownership check: a run the sweep or a newer run took
 * stops without a write. Logs carry ids, codes and error classes only, never text.
 */
@Injectable()
export class TailoredRunner {
  private readonly logger = new Logger(TailoredRunner.name)
  /** The per-process cap on runs past their claim; the rest wait in arrival order. */
  private readonly slots: RunSlots

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
    private readonly typst: ResumeTypstService,
    private readonly extraction: ResumeTextExtractionService,
    private readonly vision: VisualCheckClient,
    private readonly entailment: ResumeEntailmentClient,
    private readonly writer: TailorWriterClient,
    private readonly decision: TailoredDecisionClient,
    @Optional() config?: ConfigService<Env, true>,
  ) {
    this.slots = new RunSlots(
      config?.get('TAILORED_RESUME_MAX_CONCURRENT_RUNS', { infer: true }) ??
        DEFAULT_TAILORED_RESUME_MAX_CONCURRENT_RUNS,
    )
  }

  /** Fire and forget: the request path never waits for a run. */
  enqueue(rowId: string, runId: string): void {
    void this.run(rowId, runId)
  }

  /** Fire and forget: an HR edit's re-render after its commit (plan Task 12); never rejects. */
  renderEdit(rowId: string, renderId: string): void {
    const deps = {
      db: this.db.db,
      s3: this.s3,
      logger: this.logger,
      typst: this.typst,
      extraction: this.extraction,
      now: () => new Date(),
    }
    void renderEdit(deps, rowId, renderId)
  }

  /** Run ids waiting for a slot here: QUEUED and alive, so the sweep skips them. */
  waitingRunIds(): ReadonlySet<string> {
    return new Set(this.slots.waiting())
  }

  /** Never rejects. Waits for a slot first, so the wait is not charged to the run deadline. */
  run(rowId: string, runId: string): Promise<void> {
    return this.slots.hold(runId, async () => {
      try {
        await this.execute(rowId, runId)
      } catch (err) {
        await this.end(rowId, runId, err)
      }
    })
  }

  private async end(rowId: string, runId: string, err: unknown): Promise<void> {
    if (err instanceof RunLost) return
    const { code, origin } = runFailureOf(err)
    if (!(err instanceof TailoredRunFailure || err instanceof RunFailure)) {
      // The error class only: a message can carry posting or resume text.
      const name = err instanceof Error ? err.name : 'unknown'
      this.logger.error(`Tailored run ${runId} of row ${rowId} crashed (${name})`)
    }
    const deps = { db: this.db.db, s3: this.s3, logger: this.logger }
    await failRun(deps, rowId, runId, code, origin).catch(() => {
      this.logger.error(`Tailored run ${runId} of row ${rowId}: FAILED not written`)
    })
  }

  private async execute(rowId: string, runId: string): Promise<void> {
    const db = this.db.db
    const row = await claimRun(db, rowId, runId)
    if (row === null) return
    const runBaseVersion = row.runBaseVersion
    if (runBaseVersion === null) throw new TailoredRunFailure('INTERNAL_ERROR')
    const stage = async (s: TailoredRunStage) => {
      if (!(await setStage(db, rowId, runId, s))) throw new RunLost()
    }
    const beforeModelCall = async () => {
      if (!(await ownsRun(db, rowId, runId))) throw new RunLost()
    }

    await stage('FETCHING_POSTING')
    const prepared = await prepareTailoring(
      {
        db: this.db,
        s3: this.s3,
        extraction: this.extraction,
        onDemandTypes: productionLedgerCatalog().onDemandTypes(),
      },
      {
        rowId,
        runId,
        opportunityId: row.jobOpportunityId,
        seniorId: row.seniorUserId,
        runBaseVersion,
      },
    )
    await stage('ANALYSING')
    const analysis = await analysePosting(this.decision, prepared, {
      logger: this.logger,
      rowId,
      runId,
    })
    await stage('TAILORING')
    const generated = await generateVerified(prepared, analysis, {
      writer: this.writer,
      decision: this.decision,
      entailment: this.entailment,
      beforeModelCall,
      onChecking: () => stage('CHECKING'),
    })
    await stage('RENDERING')
    const { accepted, visual } = await renderVerified(
      generated.content,
      prepared,
      generated.relevance,
      { typst: this.typst, extraction: this.extraction, vision: this.vision, beforeModelCall },
      () => stage('VISUAL_CHECK'),
    )
    await publishRun(
      { db, s3: this.s3, logger: this.logger, now: () => new Date() },
      {
        rowId,
        runId,
        runBaseVersion,
        result: {
          accepted,
          coverLetter: coverLetterText(generated.coverBody, prepared.displayName),
          verification: {
            ...generated.verification,
            gates: [...generated.verification.gates, ...accepted.gates, visual],
            coverage: coverageOf(accepted.content, analysis.requirements),
            routes: [...ROUTES],
          },
          baseResumeId: prepared.base.id,
          baseVersion: prepared.base.version,
          opportunityRevision: prepared.opportunityRevision,
          templateName: prepared.base.templateName,
        },
      },
    )
  }
}
