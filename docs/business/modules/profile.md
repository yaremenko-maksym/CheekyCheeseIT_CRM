# Модуль: Профиль (Profile)

## Статус: ✅ Частично реализован (PHASE 7 partial)

## Реализовано

- `/crm/profile` — редактирование телефона и Telegram
- `/crm/users/:id` — просмотр профиля другого пользователя (read-only)
- Ссылки на профили из Team/Projects/Interviews карточек

## Планируется (PHASE 7 полный)

- Загрузка фото аватара (S3 + sharp сжатие)
- **USDT кошелёк** (обязательно JUNIOR + SENIOR для смарт-контракта, Phase 8)
  - Смена кошелька — с подтверждением (security critical)
- **Легенда SENIOR** — профиль для клиентской компании (ФИО, дата рождения, адрес, хобби)
  - Видят: ADMIN, HR своего синьора, JUNIOR своего синьора

## Таблицы БД (текущие)

```sql
users: id, email, displayName, avatar, role, googleId,
       telegram, phone, createdAt, updatedAt
```

## Endpoints

```
GET    /api/users        → список (для dropdowns)
GET    /api/users/:id    → профиль пользователя
PATCH  /api/users/me     → обновить свой профиль (phone, telegram)
```

## Edge Cases

- Google avatar обновляется при каждом логине
- Email и displayName — read-only (из Google OAuth, нельзя менять)
- walletAddress — при смене требуется подтверждение (риск потери денег)
