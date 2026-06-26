import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { OAuth2Client, type TokenPayload } from 'google-auth-library'
import type { Env } from '../config/env'

interface GoogleTokenResponse {
  access_token: string
  id_token: string
  expires_in: number
}

/**
 * Normalised Google identity returned to the controller from BOTH auth paths
 * (OAuth2 callback + One-Tap). `id` is the stable Google account id (`sub`).
 */
interface GoogleUserInfo {
  id: string
  email: string
  name: string
  picture: string
}

/**
 * Raw shape of the OpenID Connect UserInfo response
 * (https://openidconnect.googleapis.com/v1/userinfo). Per the OIDC spec the
 * verified-email flag is `email_verified` (boolean); the deprecated v2 endpoint
 * used `verified_email`, hence we read both defensively. `sub` is the stable
 * account id.
 */
interface GoogleOidcUserInfo {
  sub: string
  email: string
  name?: string
  picture?: string
  email_verified?: boolean | string
  /** Legacy v2 alias — tolerated for forward-compat, but we query v1 (OIDC). */
  verified_email?: boolean | string
}

@Injectable()
export class AuthService {
  /**
   * Single OAuth2Client used to locally verify Google ID tokens (signature via
   * cached JWKS + iss/aud/exp). Replaces the previous network call to the
   * deprecated `tokeninfo` endpoint (audit LOW #4).
   */
  private readonly oauthClient: OAuth2Client

  constructor(private config: ConfigService<Env>) {
    this.oauthClient = new OAuth2Client(this.config.get('GOOGLE_CLIENT_ID', { infer: true })!)
  }

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

  /**
   * OAuth2 callback path. Fetches the profile from the OpenID Connect UserInfo
   * endpoint (returns `email_verified` per the OIDC spec) and REJECTS accounts
   * whose email is not verified (audit HIGH #2 — defence in depth, mirrors the
   * One-Tap check). Returns the stable account id (`sub`) as `id`.
   */
  async getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      throw new Error(`Google userinfo failed: ${response.status}`)
    }
    const info = (await response.json()) as GoogleOidcUserInfo
    if (!isEmailVerified(info.email_verified ?? info.verified_email)) {
      throw new Error('Google account email is not verified')
    }
    if (!info.sub || !info.email) {
      throw new Error('Google userinfo missing required fields')
    }
    return {
      id: info.sub,
      email: info.email,
      name: info.name ?? '',
      picture: info.picture ?? '',
    }
  }

  /**
   * One-Tap path. Verifies the ID token LOCALLY (signature via JWKS + iss/aud/exp
   * — no network round-trip to the deprecated `tokeninfo` endpoint, audit LOW #4)
   * and REJECTS unverified emails (audit HIGH #1). Returns the stable account id
   * (`sub`).
   */
  async verifyGoogleIdToken(
    idToken: string,
  ): Promise<{ sub: string; email: string; name: string; picture: string }> {
    const clientId = this.config.get('GOOGLE_CLIENT_ID', { infer: true })!
    let payload: TokenPayload | undefined
    try {
      const ticket = await this.oauthClient.verifyIdToken({ idToken, audience: clientId })
      payload = ticket.getPayload()
    } catch {
      // Invalid signature / expired / audience mismatch all surface here.
      throw new Error('Google ID token verification failed')
    }
    if (!payload) {
      throw new Error('Google ID token has no payload')
    }
    if (!isEmailVerified(payload.email_verified)) {
      throw new Error('Google account email is not verified')
    }
    if (!payload.sub || !payload.email) {
      throw new Error('Google ID token missing required claims')
    }
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name ?? '',
      picture: payload.picture ?? '',
    }
  }
}

/**
 * Google sometimes serialises the verified flag as the string `"true"`
 * (legacy / userinfo) and sometimes as a real boolean (ID token). Treat ONLY an
 * explicit truthy verified value as verified — anything else (false, "false",
 * undefined) is rejected.
 */
function isEmailVerified(value: boolean | string | undefined): boolean {
  return value === true || value === 'true'
}
