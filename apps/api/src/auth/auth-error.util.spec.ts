import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import {
  GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE,
  INVITE_TARGET_ARCHIVED_MESSAGE,
} from '../users/users.service'
import { mapInviteAcceptError } from './auth-error.util'

const envelope = (code: string, status = 400) =>
  new HttpException({ statusCode: status, code, message: 'ignored' }, status)

describe('mapInviteAcceptError', () => {
  describe('envelope codes (apiError-built HttpException)', () => {
    it.each([
      ['INVITE_ALREADY_USED', 'invite_used'],
      ['INVITE_EXPIRED', 'invite_expired'],
      ['INVITE_GOOGLE_ACCOUNT_MISMATCH', 'invite_email_mismatch'],
      ['INVITE_INVALID', 'invite_invalid'],
      ['SOMETHING_UNKNOWN', 'invite_invalid'],
    ])('%s -> %s', (code, expected) => {
      expect(mapInviteAcceptError(envelope(code))).toBe(expected)
    })

    it('envelope code wins over exception class dispatch', () => {
      const err = new HttpException({ code: 'INVITE_EXPIRED' }, 403)
      expect(mapInviteAcceptError(err)).toBe('invite_expired')
    })

    it('HttpException with a string body falls to invite_invalid', () => {
      expect(mapInviteAcceptError(new HttpException('plain', 400))).toBe('invite_invalid')
    })

    it('HttpException with an object body lacking code falls to invite_invalid', () => {
      expect(mapInviteAcceptError(new HttpException({ message: 'x' }, 400))).toBe('invite_invalid')
    })
  })

  describe('ForbiddenException sentinels', () => {
    it('target archived sentinel -> account_disabled', () => {
      expect(mapInviteAcceptError(new ForbiddenException(INVITE_TARGET_ARCHIVED_MESSAGE))).toBe(
        'account_disabled',
      )
    })

    it('any other forbidden message -> invite_email_mismatch', () => {
      expect(mapInviteAcceptError(new ForbiddenException('wrong account'))).toBe(
        'invite_email_mismatch',
      )
    })

    it('forbidden without a message -> invite_email_mismatch', () => {
      expect(mapInviteAcceptError(new ForbiddenException())).toBe('invite_email_mismatch')
    })
  })

  describe('ConflictException sentinels', () => {
    it('google account already bound sentinel -> invite_account_taken', () => {
      expect(
        mapInviteAcceptError(new ConflictException(GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE)),
      ).toBe('invite_account_taken')
    })

    it('any other conflict message -> invite_used', () => {
      expect(mapInviteAcceptError(new ConflictException('token used'))).toBe('invite_used')
    })

    it('conflict without a message -> invite_used', () => {
      expect(mapInviteAcceptError(new ConflictException())).toBe('invite_used')
    })
  })

  describe('everything else', () => {
    it.each([
      ['BadRequestException', new BadRequestException('x')],
      ['NotFoundException', new NotFoundException()],
      ['plain Error', new Error('boom')],
      ['string', 'boom'],
      ['null', null],
      ['undefined', undefined],
    ])('%s -> invite_invalid', (_name, err) => {
      expect(mapInviteAcceptError(err)).toBe('invite_invalid')
    })
  })
})
