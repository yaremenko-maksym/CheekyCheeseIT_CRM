import { z } from 'zod'

// ---------------------------------------------------------------------------
// Project Credentials — work-account passwords stored per project.
//
// SECURITY INVARIANT: the plaintext password is NEVER part of any list/read
// schema. It is only ever returned by the dedicated `reveal` endpoint, modeled
// by `revealResponseSchema` below. The list/item schema (`projectCredentialSchema`)
// deliberately has no `password` / `ciphertext` field — even masked.
// ---------------------------------------------------------------------------

/**
 * A single credential record as returned by list/read endpoints.
 * NO password and NO ciphertext — by design. The frontend renders a static
 * mask («••••••••») and fetches plaintext on demand via the reveal endpoint.
 */
export const projectCredentialSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  label: z.string().min(1),
  login: z.string().nullable(),
  url: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(), // ISO 8601
  updatedAt: z.string(), // ISO 8601
})

export type ProjectCredential = z.infer<typeof projectCredentialSchema>

/**
 * Body for creating a credential. `password` is required on create.
 * Optional fields are coerced to null at the boundary by the frontend, but
 * accepted as absent / empty here for ergonomic forms.
 */
export const createCredentialSchema = z.object({
  label: z.string().trim().min(1, 'Название обязательно').max(200),
  login: z.string().trim().max(200).optional().nullable(),
  password: z.string().min(1, 'Пароль обязателен').max(1024),
  url: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
})

export type CreateCredentialDto = z.infer<typeof createCredentialSchema>

/**
 * Body for updating a credential. ALL fields optional.
 * `password` absent → the stored password is NOT changed (the backend skips
 * re-encryption). `password` present (non-empty) → re-encrypted.
 */
export const updateCredentialSchema = z.object({
  label: z.string().trim().min(1, 'Название обязательно').max(200).optional(),
  login: z.string().trim().max(200).optional().nullable(),
  // Empty string is treated as "do not change" by the backend (same as absent).
  password: z.string().max(1024).optional(),
  url: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
})

export type UpdateCredentialDto = z.infer<typeof updateCredentialSchema>

/**
 * Response of the reveal endpoint — the ONLY place plaintext crosses the wire.
 */
export const revealResponseSchema = z.object({
  password: z.string(),
})

export type RevealResponse = z.infer<typeof revealResponseSchema>
