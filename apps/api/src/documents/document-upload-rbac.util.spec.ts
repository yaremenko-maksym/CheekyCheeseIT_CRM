import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import type { DocumentCategory, Role } from '@crm/shared'
import { assertCanUpload } from './document-upload-rbac.util'

type Outcome =
  | 'ok'
  | 'CATEGORY_FORBIDDEN'
  | 'SELF_ONLY'
  | 'CONTRACT_RESTRICTED'
  | 'RECEIPT_SELF_ONLY'
  | 'AVATAR_SELF_ONLY'
  | 'INVOICE_FORBIDDEN'

const CODE_BY_OUTCOME: Record<Exclude<Outcome, 'ok'>, string> = {
  CATEGORY_FORBIDDEN: 'DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN',
  SELF_ONLY: 'DOCUMENT_UPLOAD_SELF_ONLY',
  CONTRACT_RESTRICTED: 'DOCUMENT_UPLOAD_CONTRACT_RESTRICTED',
  RECEIPT_SELF_ONLY: 'DOCUMENT_UPLOAD_RECEIPT_SELF_ONLY',
  AVATAR_SELF_ONLY: 'DOCUMENT_UPLOAD_AVATAR_SELF_ONLY',
  INVOICE_FORBIDDEN: 'DOCUMENT_UPLOAD_INVOICE_FORBIDDEN',
}

const ACTOR = 'actor-id'
const OTHER = 'someone-else'

function run(
  role: Role,
  category: DocumentCategory,
  ownerId: string,
): { outcome: Outcome; body?: Record<string, unknown>; status?: number } {
  try {
    assertCanUpload(role, ACTOR, category, ownerId)
    return { outcome: 'ok' }
  } catch (e) {
    if (!(e instanceof HttpException)) throw e
    const body = e.getResponse() as Record<string, unknown>
    const outcome = (Object.keys(CODE_BY_OUTCOME) as Array<Exclude<Outcome, 'ok'>>).find(
      (k) => CODE_BY_OUTCOME[k] === body.code,
    )
    if (!outcome) throw new Error(`unexpected code ${String(body.code)}`)
    return { outcome, body, status: e.getStatus() }
  }
}

// Hand-written expected matrix: [self-owner outcome, other-owner outcome] per role.
const MATRIX: Record<DocumentCategory, Record<Role, [Outcome, Outcome]>> = {
  RESUME: {
    ADMIN: ['ok', 'ok'],
    HR: ['ok', 'ok'],
    SENIOR: ['ok', 'ok'],
    JUNIOR: ['ok', 'SELF_ONLY'],
    DROP: ['ok', 'SELF_ONLY'],
    ACCOUNTANT: ['CATEGORY_FORBIDDEN', 'CATEGORY_FORBIDDEN'],
  },
  SCAN: {
    ADMIN: ['ok', 'ok'],
    HR: ['ok', 'ok'],
    SENIOR: ['ok', 'ok'],
    JUNIOR: ['ok', 'SELF_ONLY'],
    DROP: ['ok', 'SELF_ONLY'],
    ACCOUNTANT: ['CATEGORY_FORBIDDEN', 'CATEGORY_FORBIDDEN'],
  },
  CONTRACT: {
    ADMIN: ['ok', 'ok'],
    SENIOR: ['ok', 'CONTRACT_RESTRICTED'],
    DROP: ['ok', 'CONTRACT_RESTRICTED'],
    HR: ['CONTRACT_RESTRICTED', 'CONTRACT_RESTRICTED'],
    JUNIOR: ['CONTRACT_RESTRICTED', 'CONTRACT_RESTRICTED'],
    ACCOUNTANT: ['CONTRACT_RESTRICTED', 'CONTRACT_RESTRICTED'],
  },
  RECEIPT: {
    ADMIN: ['ok', 'ok'],
    ACCOUNTANT: ['ok', 'ok'],
    SENIOR: ['ok', 'RECEIPT_SELF_ONLY'],
    HR: ['CATEGORY_FORBIDDEN', 'CATEGORY_FORBIDDEN'],
    JUNIOR: ['CATEGORY_FORBIDDEN', 'CATEGORY_FORBIDDEN'],
    DROP: ['CATEGORY_FORBIDDEN', 'CATEGORY_FORBIDDEN'],
  },
  AVATAR: {
    ADMIN: ['ok', 'ok'],
    HR: ['ok', 'AVATAR_SELF_ONLY'],
    SENIOR: ['ok', 'AVATAR_SELF_ONLY'],
    JUNIOR: ['ok', 'AVATAR_SELF_ONLY'],
    DROP: ['ok', 'AVATAR_SELF_ONLY'],
    ACCOUNTANT: ['ok', 'AVATAR_SELF_ONLY'],
  },
  LOGO: {
    ADMIN: ['ok', 'ok'],
    HR: ['ok', 'ok'],
    SENIOR: ['ok', 'ok'],
    JUNIOR: ['CATEGORY_FORBIDDEN', 'CATEGORY_FORBIDDEN'],
    DROP: ['CATEGORY_FORBIDDEN', 'CATEGORY_FORBIDDEN'],
    ACCOUNTANT: ['CATEGORY_FORBIDDEN', 'CATEGORY_FORBIDDEN'],
  },
  INVOICE: {
    ADMIN: ['INVOICE_FORBIDDEN', 'INVOICE_FORBIDDEN'],
    HR: ['INVOICE_FORBIDDEN', 'INVOICE_FORBIDDEN'],
    SENIOR: ['INVOICE_FORBIDDEN', 'INVOICE_FORBIDDEN'],
    JUNIOR: ['INVOICE_FORBIDDEN', 'INVOICE_FORBIDDEN'],
    DROP: ['INVOICE_FORBIDDEN', 'INVOICE_FORBIDDEN'],
    ACCOUNTANT: ['INVOICE_FORBIDDEN', 'INVOICE_FORBIDDEN'],
  },
}

describe('assertCanUpload — full role x category x ownership matrix', () => {
  for (const category of Object.keys(MATRIX) as DocumentCategory[]) {
    for (const role of Object.keys(MATRIX[category]) as Role[]) {
      const [selfExpected, otherExpected] = MATRIX[category][role]
      it(`${category} / ${role} / own owner -> ${selfExpected}`, () => {
        expect(run(role, category, ACTOR).outcome).toBe(selfExpected)
      })
      it(`${category} / ${role} / other owner -> ${otherExpected}`, () => {
        expect(run(role, category, OTHER).outcome).toBe(otherExpected)
      })
    }
  }

  it('every refusal is a 403', () => {
    expect(run('JUNIOR', 'RESUME', OTHER).status).toBe(HttpStatus.FORBIDDEN)
    expect(run('ACCOUNTANT', 'RESUME', ACTOR).status).toBe(HttpStatus.FORBIDDEN)
    expect(run('HR', 'CONTRACT', ACTOR).status).toBe(HttpStatus.FORBIDDEN)
    expect(run('SENIOR', 'RECEIPT', OTHER).status).toBe(HttpStatus.FORBIDDEN)
    expect(run('JUNIOR', 'AVATAR', OTHER).status).toBe(HttpStatus.FORBIDDEN)
    expect(run('ADMIN', 'INVOICE', ACTOR).status).toBe(HttpStatus.FORBIDDEN)
  })

  it('CATEGORY_FORBIDDEN carries the refused category as a param', () => {
    expect(run('ACCOUNTANT', 'RESUME', ACTOR).body?.params).toEqual({ category: 'RESUME' })
    expect(run('ACCOUNTANT', 'SCAN', ACTOR).body?.params).toEqual({ category: 'SCAN' })
    expect(run('JUNIOR', 'RECEIPT', ACTOR).body?.params).toEqual({ category: 'RECEIPT' })
    expect(run('JUNIOR', 'LOGO', ACTOR).body?.params).toEqual({ category: 'LOGO' })
  })

  it('codes without params carry none', () => {
    expect(run('JUNIOR', 'RESUME', OTHER).body?.params).toBeUndefined()
    expect(run('HR', 'CONTRACT', ACTOR).body?.params).toBeUndefined()
    expect(run('SENIOR', 'RECEIPT', OTHER).body?.params).toBeUndefined()
    expect(run('JUNIOR', 'AVATAR', OTHER).body?.params).toBeUndefined()
    expect(run('ADMIN', 'INVOICE', ACTOR).body?.params).toBeUndefined()
  })

  it('an unknown category is a BadRequestException naming it', () => {
    let caught: unknown
    try {
      assertCanUpload('ADMIN', ACTOR, 'BOGUS' as DocumentCategory, ACTOR)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(BadRequestException)
    expect((caught as BadRequestException).message).toBe('Unknown category: BOGUS')
  })
})
