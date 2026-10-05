# Module: Auth (Authorization)

## Status: ✅ Implemented (PHASE 1)

## Business logic

### Google SSO Only

The only way to sign in is Google OAuth. Access is only for company employees: if the email is not in the `users` table → 403 + redirect `/login?error=unauthorized`.

### JWT in an HttpOnly Cookie

- Lifetime: 7 days
- Cookie: HttpOnly, Secure, SameSite=Strict
- Payload: `SessionUser` (id, email, displayName, avatar, role)
- Signed via `@nestjs/jwt`

### CSRF Protection

- A random `state` parameter on the OAuth redirect
- Stored in the signed cookie `oauth_state`, TTL 600 sec
- Verified on the callback

## Endpoints

```
GET /api/auth/google           → redirect to Google
GET /api/auth/google/callback  → callback handling
GET /api/auth/me               → current user (requires JWT)
POST /api/auth/logout          → clear cookie
```

## Roles

The role is set in the `users` table on creation (seed script / manual addition). Available: `ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT`.

## Frontend

- Login: `/login` — a Google SSO button, errors: `?error=unauthorized|google_error|invalid_state`
- AuthContext: the `useAuth()` hook, `staleTime: 5 min`
- Protection: `routes/crm/route.tsx` — redirect to `/login` if not authenticated
- A skeleton while the auth state loads

## Edge Cases

- Email not in the DB → redirect `/login?error=unauthorized` (403)
- Google OAuth timeout → `google_error`
- Expired JWT (7 days) → redirect to login
- Invalid `state` → `invalid_state`
