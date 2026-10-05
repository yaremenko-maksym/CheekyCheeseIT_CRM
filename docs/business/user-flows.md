# User Flows

## How to read this file

Each flow is a step-by-step scenario for a specific role. The QA agent uses it as a basis for testing. The AutoTest agent generates tests from it.

---

## Auth

### Flow: Google SSO Login

**Role:** Any

1. The user opens `/login`
2. Clicks "Sign in with Google"
3. Redirect to `GET /api/auth/google` → Google OAuth
4. Google returns to `GET /api/auth/google/callback`
5. The server checks the email in the `users` table
   - Email exists → JWT cookie → redirect to `/crm`
   - Email does not exist → redirect to `/login?error=unauthorized`
6. `/crm` — shows the dashboard

### Flow: Logout

1. The user clicks "Sign out" in the header dropdown
2. Request `POST /api/auth/logout`
3. The cookie is cleared → redirect to `/login`

### Flow: Direct access to /crm without a session

1. The user opens `/crm/anything`
2. `/crm/route.tsx` checks the auth state
3. If not authenticated → redirect `/login`

---

## Teams

### Flow: ADMIN creates a team

1. ADMIN goes to `/crm/team`
2. Clicks "Create team"
3. Enters the team name
4. Selects an HR from the list of users with the HR role
5. Selects SENIOR(s)
6. Selects an ACCOUNTANT (autofill — one per company)
7. Saves → the team appears in the list

### Flow: HR manages the team roster

1. HR sees only their own teams
2. Can add a SENIOR to the team
3. Can remove a SENIOR (if not the last one)
4. CANNOT remove themselves (the last HR)
5. CANNOT see/edit other teams

### Flow: SENIOR/JUNIOR opens their team

1. A SENIOR or JUNIOR goes to `/crm/team`
2. Request `GET /api/teams` returns a single team
3. The frontend automatically redirects to `/crm/team/:id`
4. On the detail page the SENIOR sees all participants (read-only)
5. The JUNIOR sees all participants except other JUNIORs (server-side filtering)

### Flow: Viewing the team detail page

1. ADMIN/HR/ACCOUNTANT click a team card in the list
2. `/crm/team/:id` opens
3. The roster is shown (avatar, name, role badge) + the team creation date
4. ADMIN/HR-owner sees "Add" / "Remove" buttons to manage the roster

---

## Projects

### Flow: ADMIN/HR creates a project

1. Go to `/crm/projects`
2. The "Create project" button
3. Form: name, client company, domain, start date, SENIOR, rate, currency
4. Create → a project with status ACTIVE

### Flow: Add a JUNIOR to a project

1. ADMIN/HR opens the project
2. The "Add participant" button
3. Select a user with the JUNIOR role
4. The JUNIOR now sees the project in their list

### Flow: Close a project

1. ADMIN/HR in the project card → "Close project"
2. Confirmation
3. The project gets status CLOSED and `endDate = now`
4. The project stays in the archive (soft delete)

---

## Interviews Kanban (Interviews)

### Flow: HR creates an interview card

1. HR on `/crm/interviews` selects a senior's board (`?seniorId=uuid`)
2. The "Create interview" button
3. Form: company, vacancy link, call link
4. The card appears in the `HR_SCREEN` column

### Flow: Advancing a card (DnD or button)

1. HR/SENIOR drags the card to the next column
   **OR** opens the dialog → the "Move →" button
2. Stages: `HR_SCREEN` → `ENGLISH_CHECK` → `TECH_INTERVIEW` → `FINAL_INTERVIEW` → `OFFER_RECEIVED`
3. Terminal: `HIRED`, `REJECTED`, `ARCHIVED`

### Flow: SENIOR fills in data after the interview

1. The SENIOR opens the card
2. In the notes form enters: domain, technologies, technique, team composition, benefits, payment type
3. Saves the notes (does not change the stage)

---

## Finance

### Flow: SENIOR enters a transaction

1. The SENIOR on `/crm/finance`
2. The "Add transaction" button
3. Form: project, date, amount, currency, upload a receipt (file)
4. The transaction is created with status `PENDING`

### Flow: ACCOUNTANT validates a transaction

1. The ACCOUNTANT sees all transactions with status PENDING
2. Opens a transaction → views the receipt
3. The "Validate" button → status `VALIDATED`
   OR "Reject" → status `REJECTED` + reason

### Flow: SENIOR pays for services

1. After a VALIDATED transaction the SENIOR gets the "Pay for services" button
2. The SENIOR clicks → status `PENDING_PAYMENT`
3. After the payment is confirmed → `PAID`

---

## Profile

### Flow: Editing your own profile

1. The user on `/crm/profile`
2. Edits: phone, Telegram
3. Saves → the data is updated

### Flow: Viewing another user's profile

1. A click on a user's name in a Team / Project / Interview
2. `/crm/users/:id` opens
3. Read-only (not their own page)
