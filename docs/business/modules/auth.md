# Модуль: Auth (Авторизация)

## Статус: ✅ Реализован (PHASE 1)

## Бизнес-логика

### Google SSO Only

Единственный способ входа — Google OAuth. Доступ только для сотрудников компании: если email не в таблице `users` → 403 + redirect `/login?error=unauthorized`.

### JWT в HttpOnly Cookie

- Срок: 7 дней
- Cookie: HttpOnly, Secure, SameSite=Strict
- Payload: `SessionUser` (id, email, displayName, avatar, role)
- Подписан через `@nestjs/jwt`

### CSRF Protection

- Случайный `state` параметр при OAuth redirect
- Хранится в signed cookie `oauth_state`, TTL 600 сек
- Проверяется при callback

## Endpoints

```
GET /api/auth/google           → redirect на Google
GET /api/auth/google/callback  → обработка callback
GET /api/auth/me               → текущий пользователь (требует JWT)
POST /api/auth/logout          → очистка cookie
```

## Роли

Роль задаётся в таблице `users` при создании (seed скрипт / ручное добавление). Доступные: `ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT`.

## Frontend

- Login: `/login` — кнопка Google SSO, ошибки: `?error=unauthorized|google_error|invalid_state`
- AuthContext: `useAuth()` хук, `staleTime: 5 мин`
- Защита: `routes/crm/route.tsx` — redirect на `/login` если не аутентифицирован
- Скелетон при загрузке auth state

## Edge Cases

- Email не в БД → redirect `/login?error=unauthorized` (403)
- Google OAuth timeout → `google_error`
- Expired JWT (7 дней) → redirect на login
- Недействительный `state` → `invalid_state`
