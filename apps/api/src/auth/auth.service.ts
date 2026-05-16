import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'

interface GoogleTokenResponse {
  access_token: string
  id_token: string
  expires_in: number
}

interface GoogleUserInfo {
  id: string
  email: string
  name: string
  picture: string
}

interface GoogleIdTokenPayload {
  sub: string
  email: string
  name: string
  picture: string
  aud: string
}

@Injectable()
export class AuthService {
  constructor(private config: ConfigService<Env>) {}

  buildGoogleAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.get('GOOGLE_CLIENT_ID', { infer: true })!,
      redirect_uri: this.config.get('GOOGLE_CALLBACK_URL', { infer: true })!,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      state,
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  }

  async exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.get('GOOGLE_CLIENT_ID', { infer: true })!,
        client_secret: this.config.get('GOOGLE_CLIENT_SECRET', { infer: true })!,
        redirect_uri: this.config.get('GOOGLE_CALLBACK_URL', { infer: true })!,
        grant_type: 'authorization_code',
      }),
    })
    if (!response.ok) {
      throw new Error(`Google token exchange failed: ${response.status}`)
    }
    return response.json() as Promise<GoogleTokenResponse>
  }

  async getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      throw new Error(`Google userinfo failed: ${response.status}`)
    }
    return response.json() as Promise<GoogleUserInfo>
  }

  async verifyGoogleIdToken(idToken: string): Promise<{ sub: string; email: string; name: string; picture: string }> {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`,
    )
    if (!response.ok) {
      throw new Error('Google tokeninfo request failed')
    }
    const payload = (await response.json()) as GoogleIdTokenPayload
    const clientId = this.config.get('GOOGLE_CLIENT_ID', { infer: true })!
    if (payload.aud !== clientId) {
      throw new Error('Token audience mismatch')
    }
    return { sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture }
  }
}
