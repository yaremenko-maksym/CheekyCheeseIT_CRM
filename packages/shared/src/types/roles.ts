export const ROLES = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as const
export type Role = (typeof ROLES)[number]
