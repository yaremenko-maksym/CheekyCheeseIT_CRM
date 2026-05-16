import { relations } from 'drizzle-orm'
import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'])

export const currencyEnum = pgEnum('currency', ['USDT', 'USD', 'EUR', 'UAH'])

export const projectStatusEnum = pgEnum('project_status', ['ACTIVE', 'CLOSED'])

export const interviewStageEnum = pgEnum('interview_stage', [
  'HR_SCREEN',
  'ENGLISH_CHECK',
  'TECH_INTERVIEW',
  'FINAL_INTERVIEW',
  'CLIENT_INTERVIEW',
  'OFFER_RECEIVED',
  'HIRED',
  'REJECTED',
  'ARCHIVED',
])

export const transactionTypeEnum = pgEnum('transaction_type', [
  'ADMIN_INCOME',    // Admin income from own project — no validation needed
  'SENIOR_INCOME',   // Senior income from project — requires validation flow
  'EXPENSE',         // Company expense (category in receiverLabel)
  'SALARY',          // Salary to employee (HR/ACCOUNTANT/JUNIOR)
  'ADMIN_TRANSFER',  // Balance transfer between Maksym and Kostya
  'PAYOUT',          // Senior pays CheekyCheeseIT (from payout_request)
  'PAYOUT_ADMIN',    // Auto-created: 50/50 split to each admin after payout
])

export const transactionStatusEnum = pgEnum('transaction_status', [
  'PENDING',    // Awaiting action (senior_income awaits validation; salary awaits payment)
  'VALIDATED',  // Accountant/admin confirmed senior_income; senior can now create payout
  'REJECTED',   // Accountant/admin rejected; senior must edit and resubmit
  'PAID',       // Completed/paid
  'LOCKED',     // Junior salary locked until senior has validated income for the month
])

export const payoutRequestStatusEnum = pgEnum('payout_request_status', [
  'PENDING',  // Created by senior, txHash not yet submitted
  'PAID',     // Senior submitted txHash, auto-transactions created
])

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  avatar: varchar('avatar', { length: 1000 }),
  role: roleEnum().notNull().default('JUNIOR'),
  googleId: varchar('google_id', { length: 255 }).unique(),
  telegram: varchar('telegram', { length: 100 }),
  phone: varchar('phone', { length: 30 }),
  techStack: varchar('tech_stack', { length: 100 }),
  // USDT ERC-20 wallet address (required for junior auto-salary, admin payout splits)
  walletAddress: varchar('wallet_address', { length: 255 }),
  // For SENIOR and ADMIN: percentage they keep from project income (0-100)
  seniorSharePercent: integer('senior_share_percent').notNull().default(26),
  // For JUNIOR/HR/ACCOUNTANT: fixed monthly salary in USD
  monthlySalary: numeric('monthly_salary', { precision: 10, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const teamMembers = pgTable('team_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 100 }).notNull(),
  startDate: timestamp('start_date').notNull(),
  endDate: timestamp('end_date'),
  // seniorId can be SENIOR or ADMIN (admin-owned projects)
  seniorId: uuid('senior_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rate: integer('rate').notNull(),
  currency: currencyEnum().notNull().default('USDT'),
  status: projectStatusEnum().notNull().default('ACTIVE'),
  logoUrl: text('logo_url'),
  techStack: varchar('tech_stack', { length: 500 }),
  teamSize: varchar('team_size', { length: 100 }),
  benefits: varchar('benefits', { length: 500 }),
  paymentType: varchar('payment_type', { length: 100 }),
  salaryReview: varchar('salary_review', { length: 255 }),
  corpTech: varchar('corp_tech', { length: 255 }),
  notesGeneral: varchar('notes_general', { length: 1000 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// Per-project finance overrides (ADMIN/ACCOUNTANT only)
export const projectFinanceSettings = pgTable('project_finance_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  // Override senior share percent for this project; null = use users.seniorSharePercent
  seniorSharePercentOverride: integer('senior_share_percent_override'),
  // Override junior monthly salary for this project; null = use users.monthlySalary
  juniorSalaryOverride: numeric('junior_salary_override', { precision: 10, scale: 2 }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const projectMembers = pgTable('project_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
  leftAt: timestamp('left_at'),
})

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

export const interviews = pgTable('interviews', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hrId: uuid('hr_id').references(() => users.id, { onDelete: 'set null' }),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  vacancyUrl: varchar('vacancy_url', { length: 1000 }),
  callUrl: varchar('call_url', { length: 1000 }),
  stage: interviewStageEnum().notNull().default('HR_SCREEN'),
  notesDomain: varchar('notes_domain', { length: 255 }),
  notesTechStack: varchar('notes_tech_stack', { length: 500 }),
  notesTeamSize: varchar('notes_team_size', { length: 100 }),
  notesBenefits: varchar('notes_benefits', { length: 500 }),
  notesPaymentType: varchar('notes_payment_type', { length: 100 }),
  notesSalaryReview: varchar('notes_salary_review', { length: 255 }),
  notesCorpTech: varchar('notes_corp_tech', { length: 255 }),
  notesGeneral: varchar('notes_general', { length: 1000 }),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Finance — Transactions (unified ledger)
// ---------------------------------------------------------------------------

// Groups validated SENIOR_INCOME transactions into a single payout obligation
export const payoutRequests = pgTable('payout_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Total income amount across all linked SENIOR_INCOME transactions
  incomeAmount: numeric('income_amount', { precision: 18, scale: 6 }).notNull(),
  // Amount senior must pay = incomeAmount * (1 - seniorSharePercent/100)
  payableAmount: numeric('payable_amount', { precision: 18, scale: 6 }).notNull(),
  txHash: varchar('tx_hash', { length: 255 }),
  status: payoutRequestStatusEnum().notNull().default('PENDING'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const transactions = pgTable('transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: transactionTypeEnum().notNull(),
  status: transactionStatusEnum().notNull().default('PENDING'),
  amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
  // currency always stored; USDT for crypto flows, USD for salary/expenses
  currency: currencyEnum().notNull().default('USDT'),
  // Sender: real user or null (use senderLabel for named non-user entities)
  senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
  // "CheekyCheeseIT", "Project: Acme Corp", expense category, etc.
  senderLabel: varchar('sender_label', { length: 255 }),
  // Receiver: real user or null
  receiverId: uuid('receiver_id').references(() => users.id, { onDelete: 'set null' }),
  receiverLabel: varchar('receiver_label', { length: 255 }),
  // Project this income/payout is associated with
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  // For PAYOUT / PAYOUT_ADMIN: links to the payout_request that triggered them
  payoutRequestId: uuid('payout_request_id').references(() => payoutRequests.id, { onDelete: 'set null' }),
  // Snapshot of senior share percent at time of SENIOR_INCOME creation
  seniorSharePercent: integer('senior_share_percent'),
  // Receipt / proof of payment URL
  receiptUrl: text('receipt_url'),
  // Blockchain TX hash (for PAYOUT, PAYOUT_ADMIN)
  txHash: varchar('tx_hash', { length: 255 }),
  // Accountant/admin validation fields (for SENIOR_INCOME)
  validatedBy: uuid('validated_by').references(() => users.id, { onDelete: 'set null' }),
  validatedAt: timestamp('validated_at'),
  rejectionReason: varchar('rejection_reason', { length: 500 }),
  notes: varchar('notes', { length: 1000 }),
  // Calendar month this transaction belongs to (for SALARY/LOCKED logic): YYYY-MM
  salaryMonth: varchar('salary_month', { length: 7 }),
  // User-specified transaction date (defaults to creation time if not provided)
  txDate: timestamp('tx_date'),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  teamMemberships: many(teamMembers),
  projects: many(projects),
  projectMemberships: many(projectMembers),
  seniorInterviews: many(interviews, { relationName: 'seniorInterviews' }),
  hrInterviews: many(interviews, { relationName: 'hrInterviews' }),
  sentTransactions: many(transactions, { relationName: 'sentTransactions' }),
  receivedTransactions: many(transactions, { relationName: 'receivedTransactions' }),
  validatedTransactions: many(transactions, { relationName: 'validatedTransactions' }),
  createdTransactions: many(transactions, { relationName: 'createdTransactions' }),
  payoutRequests: many(payoutRequests),
}))

export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
}))

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  senior: one(users, { fields: [projects.seniorId], references: [users.id] }),
  members: many(projectMembers),
  transactions: many(transactions),
  financeSettings: one(projectFinanceSettings),
}))

export const projectFinanceSettingsRelations = relations(projectFinanceSettings, ({ one }) => ({
  project: one(projects, { fields: [projectFinanceSettings.projectId], references: [projects.id] }),
  updatedByUser: one(users, { fields: [projectFinanceSettings.updatedBy], references: [users.id] }),
}))

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}))

export const interviewsRelations = relations(interviews, ({ one }) => ({
  senior: one(users, { fields: [interviews.seniorId], references: [users.id], relationName: 'seniorInterviews' }),
  hr: one(users, { fields: [interviews.hrId], references: [users.id], relationName: 'hrInterviews' }),
}))

export const payoutRequestsRelations = relations(payoutRequests, ({ one, many }) => ({
  senior: one(users, { fields: [payoutRequests.seniorId], references: [users.id] }),
  transactions: many(transactions),
}))

export const transactionsRelations = relations(transactions, ({ one }) => ({
  sender: one(users, { fields: [transactions.senderId], references: [users.id], relationName: 'sentTransactions' }),
  receiver: one(users, { fields: [transactions.receiverId], references: [users.id], relationName: 'receivedTransactions' }),
  validator: one(users, { fields: [transactions.validatedBy], references: [users.id], relationName: 'validatedTransactions' }),
  creator: one(users, { fields: [transactions.createdBy], references: [users.id], relationName: 'createdTransactions' }),
  project: one(projects, { fields: [transactions.projectId], references: [projects.id] }),
  payoutRequest: one(payoutRequests, { fields: [transactions.payoutRequestId], references: [payoutRequests.id] }),
}))

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Team = typeof teams.$inferSelect
export type NewTeam = typeof teams.$inferInsert
export type TeamMember = typeof teamMembers.$inferSelect
export type NewTeamMember = typeof teamMembers.$inferInsert
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type ProjectMember = typeof projectMembers.$inferSelect
export type NewProjectMember = typeof projectMembers.$inferInsert
export type ProjectFinanceSettings = typeof projectFinanceSettings.$inferSelect
export type NewProjectFinanceSettings = typeof projectFinanceSettings.$inferInsert
export type Interview = typeof interviews.$inferSelect
export type NewInterview = typeof interviews.$inferInsert
export type Transaction = typeof transactions.$inferSelect
export type NewTransaction = typeof transactions.$inferInsert
export type PayoutRequest = typeof payoutRequests.$inferSelect
export type NewPayoutRequest = typeof payoutRequests.$inferInsert
