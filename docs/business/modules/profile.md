# Module: Profile

## Status: ✅ Partially implemented (PHASE 7 partial)

## Implemented

- `/crm/profile` — editing phone and Telegram
- `/crm/users/:id` — viewing another user's profile (read-only)
- Links to profiles from Team/Projects/Interviews cards

## Planned (PHASE 7 full)

- Avatar photo upload (S3 + sharp compression)
- **USDT wallet** (mandatory for JUNIOR + SENIOR for the smart contract, Phase 8)
  - Changing the wallet — with confirmation (security critical)
- **SENIOR legend** — a profile for the client company (full name, date of birth, address, hobbies)
  - Visible to: ADMIN, the HR of that senior, the JUNIOR of that senior

## DB tables (current)

```sql
users: id, email, displayName, avatar, role, googleId,
       telegram, phone, createdAt, updatedAt
```

## Endpoints

```
GET    /api/users        → list (for dropdowns)
GET    /api/users/:id    → user profile
PATCH  /api/users/me     → update own profile (phone, telegram)
```

## Edge Cases

- The Google avatar is updated on every login
- Email and displayName are read-only (from Google OAuth, cannot be changed)
- walletAddress — changing it requires confirmation (risk of losing money)
