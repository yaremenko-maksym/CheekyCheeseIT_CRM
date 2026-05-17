# E2E Сценарии

> AutoTest-агент читает этот файл и `docs/business/user-flows.md` для генерации тестов в `apps/e2e/tests/`.

## Покрытые сценарии

### Auth
- [ ] Google OAuth — успешный логин (пользователь есть в БД)
- [ ] Google OAuth — отказ (email не в БД → redirect `/login?error=unauthorized`)
- [ ] Logout — cookie очищается, redirect на `/login`
- [ ] Прямой доступ к `/crm` без сессии → redirect `/login`

### Teams
- [ ] ADMIN: создать команду, добавить HR, SENIOR, ACCOUNTANT
- [ ] HR: создать команду, добавить SENIOR
- [ ] SENIOR/JUNIOR/HR: просмотр состава команды (read-only)
- [ ] ADMIN: удалить команду

### Projects
- [ ] ADMIN/HR: создать проект, назначить SENIOR
- [ ] SENIOR: видит только свои проекты
- [ ] JUNIOR: видит проекты где он активный member
- [ ] Закрытие проекта (ADMIN/HR)

### Interviews Kanban
- [ ] HR: создать карточку собеседования
- [ ] DnD: переместить карточку между колонками
- [ ] Button move: переместить через кнопку в диалоге (PATCH method)
- [ ] SENIOR: видит только свою доску
- [ ] HR: переключение между досками синьоров (`?seniorId=`)
- [x] CLIENT_INTERVIEW стейдж: последний активный стейдж после FINAL_INTERVIEW
- [x] CLIENT_INTERVIEW стейдж: перемещение карточки в Client колонку
- [x] Все активные стейджи отображаются: HR Screen, English, Tech, Final, Client

### Finance
- [ ] SENIOR: добавить транзакцию
- [ ] ACCOUNTANT: валидировать транзакцию
- [ ] SENIOR: статус меняется на VALIDATED
- [x] HR: видит "История ваших выплат" (свои зарплаты, не список проектов)
- [ ] PDF инвойс: скачать
- [ ] TODO: PENDING_PAYMENT статус (выявлено в BA аудите, не реализовано)

### Profile
- [ ] Редактировать телефон, Telegram
- [ ] Просмотр профиля другого пользователя по `/crm/users/:id`
