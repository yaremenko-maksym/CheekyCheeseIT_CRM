# Cheeky Cheese IT business model

## Concept

**Cheeky Cheese IT** is a reverse recruiting company.

**The essence of the model:** HR finds vacancies on the market → a SENIOR goes through interviews on behalf of the company → a JUNIOR works in their place → finances are distributed among all participants.

## Roles and access rights

| Role           | Description                                  | Can create                       | Sees                                                              |
| -------------- | -------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| **ADMIN**      | System owner                                 | Everything                       | All data of all users                                             |
| **SENIOR**     | Goes through interviews, manages the project | Transactions, interview notes    | Their own projects, their own interview board, their own finances |
| **JUNIOR**     | Works on the project                         | —                                | Projects where they are an active member, basic data              |
| **HR**         | Finds vacancies, conducts interviews         | Teams, projects, interview cards | Their own teams + related seniors/projects                        |
| **ACCOUNTANT** | Financial accounting                         | Expenses, payouts                | All transactions of all seniors                                   |

## Financial flow

```
SENIOR receives a salary from the client
        ↓
SENIOR enters a transaction into the system
  (date, amount, currency, project, receipt)
        ↓
ACCOUNTANT gets a notification → validates the transaction
        ↓
SENIOR sees status VALIDATED → clicks "Pay for services"
        ↓
SENIOR pays 74% to the smart contract (Phase 8)
  JUNIOR receives a fixed amount first
  The remainder 50/50 → ADMIN wallet + partner wallet
        ↓
SENIOR keeps 26%
```

## Organizational structure

- A team = 1 HR + 1-4 SENIOR + the corresponding JUNIOR + 1 ACCOUNTANT (shared across the whole company)
- ADMIN can create at most 10 teams
- A JUNIOR can be in several teams at the same time
- There is one ACCOUNTANT for the whole company (automatically added to every team)

## Project lifecycle

```
HR/ADMIN creates a project → assigns a SENIOR
        ↓
SENIOR goes through interviews (kanban board) → gets an offer
        ↓
JUNIOR is added to the project (ADMIN/HR)
        ↓
SENIOR receives salaries → ACCOUNTANT validates → financial flow
        ↓
SENIOR leaves → the project is closed (status CLOSED, archive)
```

## Implemented modules

- ✅ Auth (Google OAuth, JWT)
- ✅ Teams
- ✅ Projects
- ✅ Interviews Kanban
- ✅ Finance — monitoring (Finance tracking)
- ⬜ Knowledge base + Documents (PHASE 6)
- ⬜ Full profile (PHASE 7)
- ⬜ USDT ERC-20 smart contracts (PHASE 8)
- ⬜ Dashboard (PHASE 9)
