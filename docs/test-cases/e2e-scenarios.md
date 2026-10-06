# E2E Scenarios

> The AutoTest agent reads this file and `docs/business/user-flows.md` to generate tests in `apps/e2e/tests/`.

## Covered scenarios

### Auth

- [ ] Google OAuth — successful login (user exists in the DB)
- [ ] Google OAuth — rejection (email not in the DB → redirect `/login?error=unauthorized`)
- [ ] Logout — cookie is cleared, redirect to `/login`
- [ ] Direct access to `/crm` without a session → redirect `/login`

### Teams

- [ ] ADMIN: create a team, add HR, SENIOR, ACCOUNTANT
- [ ] HR: create a team, add SENIOR
- [ ] SENIOR/JUNIOR/HR: view team composition (read-only)
- [ ] ADMIN: delete a team

### Projects

- [ ] ADMIN/HR: create a project, assign SENIOR
- [ ] SENIOR: sees only their own projects
- [ ] JUNIOR: sees projects where they are an active member
- [ ] Closing a project (ADMIN/HR)

### Interviews Kanban

- [ ] HR: create an interview card
- [ ] DnD: move a card between columns
- [ ] Button move: move via the button in the dialog (PATCH method)
- [ ] SENIOR: sees only their own board
- [ ] HR: switching between seniors' boards (`?seniorId=`)
- [x] CLIENT_INTERVIEW stage: the last active stage after FINAL_INTERVIEW
- [x] CLIENT_INTERVIEW stage: moving a card to the Client column
- [x] All active stages are displayed: HR Screen, English, Tech, Final, Client

### Finance

- [ ] SENIOR: add a transaction
- [ ] ACCOUNTANT: validate a transaction
- [ ] SENIOR: status changes to VALIDATED
- [x] HR: sees "История ваших выплат" (their own salaries, not a list of projects)
- [ ] PDF invoice: download
- [ ] TODO: PENDING_PAYMENT status (identified in the BA audit, not implemented)

### Profile

- [ ] Edit phone, Telegram
- [ ] View another user's profile at `/crm/users/:id`
