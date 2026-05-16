import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, asc, count, eq } from 'drizzle-orm'
import type {
  CreateInterviewDto,
  InterviewDto,
  ItDomain,
  MoveInterviewDto,
  SessionUser,
  UpdateInterviewDto,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { ProjectsService } from '../projects/projects.service'
import {
  interviews,
  teamMembers,
  type Interview,
  type User,
} from '../database/schema'

type InterviewWithRelations = Interview & {
  senior: User | null
  hr: User | null
}

@Injectable()
export class InterviewsService {
  constructor(
    private db: DatabaseService,
    private projects: ProjectsService,
  ) {}

  private mapInterview(i: InterviewWithRelations): InterviewDto {
    return {
      id: i.id,
      seniorId: i.seniorId,
      seniorName: i.senior?.displayName ?? '',
      hrId: i.hrId ?? null,
      hrName: i.hr?.displayName ?? null,
      companyName: i.companyName,
      vacancyUrl: i.vacancyUrl ?? null,
      callUrl: i.callUrl ?? null,
      stage: i.stage,
      notesDomain: (i.notesDomain ?? null) as ItDomain | null,
      notesTechStack: i.notesTechStack ?? null,
      notesTeamSize: i.notesTeamSize ?? null,
      notesBenefits: i.notesBenefits ?? null,
      notesPaymentType: i.notesPaymentType ?? null,
      notesSalaryReview: i.notesSalaryReview ?? null,
      notesCorpTech: i.notesCorpTech ?? null,
      notesGeneral: i.notesGeneral ?? null,
      position: i.position,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    }
  }

  private async getAccessibleSeniorIds(currentUser: SessionUser): Promise<Set<string>> {
    const hrTeamMemberships = await this.db.db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, currentUser.id),
      with: { team: { with: { members: { with: { user: true } } } } },
    })

    const accessibleSeniorIds = new Set<string>()
    for (const tm of hrTeamMemberships) {
      for (const m of tm.team.members) {
        if (m.user?.role === 'SENIOR') accessibleSeniorIds.add(m.userId)
      }
    }
    return accessibleSeniorIds
  }

  async findBySenior(seniorId: string | undefined, currentUser: SessionUser): Promise<InterviewDto[]> {
    // SENIOR can only see their own board
    if (currentUser.role === 'SENIOR') {
      seniorId = currentUser.id
    } else if (currentUser.role === 'HR') {
      if (!seniorId) throw new ForbiddenException('seniorId is required')
      const accessibleSeniorIds = await this.getAccessibleSeniorIds(currentUser)
      if (!accessibleSeniorIds.has(seniorId)) {
        throw new ForbiddenException('This senior is not in your teams')
      }
    } else if (currentUser.role === 'JUNIOR') {
      throw new ForbiddenException('JUNIORs cannot access interviews')
    } else if (!seniorId) {
      throw new ForbiddenException('seniorId is required')
    }
    // ADMIN: can query any senior — no check needed

    const rows = await this.db.db.query.interviews.findMany({
      where: eq(interviews.seniorId, seniorId!),
      with: { senior: true, hr: true },
      orderBy: [asc(interviews.stage), asc(interviews.position)],
    })

    return (rows as InterviewWithRelations[]).map((i) => this.mapInterview(i))
  }

  async create(dto: CreateInterviewDto, currentUser: SessionUser): Promise<InterviewDto> {
    if (currentUser.role !== 'HR' && currentUser.role !== 'SENIOR' && currentUser.role !== 'ADMIN') {
      throw new ForbiddenException()
    }

    let seniorId = dto.seniorId

    if (currentUser.role === 'SENIOR') {
      // SENIOR always creates on their own board
      seniorId = currentUser.id
    } else if (currentUser.role === 'HR') {
      // HR: check that target senior is in one of their teams
      const accessibleSeniorIds = await this.getAccessibleSeniorIds(currentUser)
      if (!accessibleSeniorIds.has(seniorId)) {
        throw new ForbiddenException('This senior is not in your teams')
      }
    }
    // ADMIN: no check needed

    // Position = count of existing cards in HR_SCREEN for this senior
    const countResult = await this.db.db
      .select({ value: count() })
      .from(interviews)
      .where(and(eq(interviews.seniorId, seniorId), eq(interviews.stage, 'HR_SCREEN')))
    const positionCount = countResult[0]?.value ?? 0

    const hrId = currentUser.role === 'HR' ? currentUser.id : null

    const [created] = await this.db.db
      .insert(interviews)
      .values({
        seniorId,
        hrId,
        companyName: dto.companyName,
        vacancyUrl: dto.vacancyUrl ?? null,
        callUrl: dto.callUrl ?? null,
        stage: 'HR_SCREEN',
        position: positionCount,
      })
      .returning()

    const row = await this.db.db.query.interviews.findFirst({
      where: eq(interviews.id, created!.id),
      with: { senior: true, hr: true },
    }) as InterviewWithRelations

    return this.mapInterview(row)
  }

  async update(id: string, dto: UpdateInterviewDto, currentUser: SessionUser): Promise<InterviewDto> {
    const interview = await this.db.db.query.interviews.findFirst({
      where: eq(interviews.id, id),
      with: { senior: true, hr: true },
    }) as InterviewWithRelations | undefined

    if (!interview) throw new NotFoundException('Interview not found')

    await this.assertUpdateAccess(interview, currentUser)

    const updateData: Partial<typeof interviews.$inferInsert> = {
      updatedAt: new Date(),
    }

    if (dto.companyName !== undefined) updateData.companyName = dto.companyName
    if (dto.vacancyUrl !== undefined) updateData.vacancyUrl = dto.vacancyUrl ?? null
    if (dto.callUrl !== undefined) updateData.callUrl = dto.callUrl ?? null
    if (dto.stage !== undefined) updateData.stage = dto.stage
    if (dto.notesDomain !== undefined) updateData.notesDomain = dto.notesDomain ?? null
    if (dto.notesTechStack !== undefined) updateData.notesTechStack = dto.notesTechStack ?? null
    if (dto.notesTeamSize !== undefined) updateData.notesTeamSize = dto.notesTeamSize ?? null
    if (dto.notesBenefits !== undefined) updateData.notesBenefits = dto.notesBenefits ?? null
    if (dto.notesPaymentType !== undefined) updateData.notesPaymentType = dto.notesPaymentType ?? null
    if (dto.notesSalaryReview !== undefined) updateData.notesSalaryReview = dto.notesSalaryReview ?? null
    if (dto.notesCorpTech !== undefined) updateData.notesCorpTech = dto.notesCorpTech ?? null
    if (dto.notesGeneral !== undefined) updateData.notesGeneral = dto.notesGeneral ?? null

    await this.db.db.update(interviews).set(updateData).where(eq(interviews.id, id))

    const updated = await this.db.db.query.interviews.findFirst({
      where: eq(interviews.id, id),
      with: { senior: true, hr: true },
    }) as InterviewWithRelations

    return this.mapInterview(updated)
  }

  async move(id: string, dto: MoveInterviewDto, currentUser: SessionUser): Promise<InterviewDto> {
    const interview = await this.db.db.query.interviews.findFirst({
      where: eq(interviews.id, id),
      with: { senior: true, hr: true },
    }) as InterviewWithRelations | undefined

    if (!interview) throw new NotFoundException('Interview not found')

    await this.assertUpdateAccess(interview, currentUser)

    const oldStage = interview.stage
    const newStage = dto.stage
    const newPosition = dto.position

    // Update this card
    await this.db.db
      .update(interviews)
      .set({ stage: newStage, position: newPosition, updatedAt: new Date() })
      .where(eq(interviews.id, id))

    // Renormalize positions in old column (if stage changed)
    if (oldStage !== newStage) {
      const cardsInOldColumn = await this.db.db.query.interviews.findMany({
        where: and(eq(interviews.seniorId, interview.seniorId), eq(interviews.stage, oldStage)),
        orderBy: [asc(interviews.position)],
      })
      for (let i = 0; i < cardsInOldColumn.length; i++) {
        await this.db.db
          .update(interviews)
          .set({ position: i })
          .where(eq(interviews.id, cardsInOldColumn[i]!.id))
      }
    }

    // Renormalize positions in new column
    const cardsInNewColumn = await this.db.db.query.interviews.findMany({
      where: and(eq(interviews.seniorId, interview.seniorId), eq(interviews.stage, newStage)),
      orderBy: [asc(interviews.position)],
    })
    for (let i = 0; i < cardsInNewColumn.length; i++) {
      await this.db.db
        .update(interviews)
        .set({ position: i })
        .where(eq(interviews.id, cardsInNewColumn[i]!.id))
    }

    const updated = await this.db.db.query.interviews.findFirst({
      where: eq(interviews.id, id),
      with: { senior: true, hr: true },
    }) as InterviewWithRelations

    // Auto-create project when moved to HIRED
    let createdProjectId: string | null = null
    if (newStage === 'HIRED' && oldStage !== 'HIRED') {
      const project = await this.projects.createFromInterview(updated, currentUser)
      createdProjectId = project?.id ?? null
    }

    return { ...this.mapInterview(updated), createdProjectId }
  }

  async remove(id: string, currentUser: SessionUser): Promise<void> {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') throw new ForbiddenException()

    const interview = await this.db.db.query.interviews.findFirst({
      where: eq(interviews.id, id),
    })
    if (!interview) throw new NotFoundException('Interview not found')

    if (currentUser.role === 'HR') {
      const accessibleSeniorIds = await this.getAccessibleSeniorIds(currentUser)
      if (!accessibleSeniorIds.has(interview.seniorId)) throw new ForbiddenException('This senior is not in your teams')
    }

    await this.db.db.delete(interviews).where(eq(interviews.id, id))
  }

  private async assertUpdateAccess(interview: InterviewWithRelations, currentUser: SessionUser): Promise<void> {
    if (currentUser.role === 'ADMIN') return

    if (currentUser.role === 'SENIOR') {
      if (interview.seniorId !== currentUser.id) throw new ForbiddenException()
      return
    }

    if (currentUser.role === 'HR') {
      const accessibleSeniorIds = await this.getAccessibleSeniorIds(currentUser)
      if (!accessibleSeniorIds.has(interview.seniorId)) throw new ForbiddenException()
      return
    }

    throw new ForbiddenException()
  }
}
