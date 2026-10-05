# User Stories

## Auth

- As a **user**, I want to sign in via Google SSO, so that I don't have to create a separate account
- As a **user**, I want to see a clear error if my email is not registered, so that I understand why I can't sign in
- As a **user**, I want my data to be protected by an HttpOnly cookie, so that the token can't be stolen via XSS

## Teams

- As an **ADMIN**, I want to create teams and assign HR, so that I can structure the company
- As an **HR**, I want to see only my own teams, so that I don't get confused by other people's data
- As an **HR**, I want to add and remove SENIORs from a team, so that I can manage the roster
- As a **SENIOR/JUNIOR/HR/ACCOUNTANT**, I want to see my team's roster, so that I know who I work with
- ✅ As a **SENIOR**, I want to land directly on my team's page without extra clicks, so that I can quickly see the roster
- ✅ As a **JUNIOR**, I want to see the team roster without other juniors, so that I don't reveal information about colleagues
- ✅ As an **ADMIN/HR**, I want to see team cards with participant avatars and the number of projects, so that I can quickly assess the roster

## Projects

- As an **ADMIN/HR**, I want to create projects specifying the senior and the rate, so that I can record agreements with clients
- As a **SENIOR**, I want to see only my own projects, so that I'm not distracted by other people's
- As a **JUNIOR**, I want to see the projects I participate in, so that I know where to work
- As an **ACCOUNTANT**, I want to see all projects, so that I can track finances for each

## Interviews

- As an **HR**, I want to create interview cards for seniors and see them on the kanban board, so that I can track progress
- As an **HR**, I want to move cards between stages via drag-and-drop or buttons, so that I can update the interview status
- As a **SENIOR**, I want to see only my own interview board, so that I don't see colleagues' data
- As a **SENIOR**, I want to fill in notes after each stage, so that I can record information about the company

## Finance

- As a **SENIOR**, I want to enter transactions with a receipt attached, so that I can confirm receipt of payment
- As an **ACCOUNTANT**, I want to validate or reject transactions, so that I can control the financial flow
- As a **SENIOR**, I want to see the status of my transactions (pending/validated/paid), so that I understand when I can pay for services
- As an **ADMIN/ACCOUNTANT**, I want to see all transactions of all seniors, so that I have the full financial picture

## Profile

- As **any user**, I want to edit my phone and Telegram, so that colleagues can contact me
- As **any user**, I want to view colleagues' profiles, so that I can find their contacts
