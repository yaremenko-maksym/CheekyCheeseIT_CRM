import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { useLingui } from '@lingui/react/macro'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { Field, Section } from '../section'
import { RolesSection } from './RolesSection'
import { seniorRolesError } from './validation'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface TechStackSectionProps {
  form: Pick<AnyForm, 'Field' | 'Subscribe'>
  /** The stored user on edit (`null` on create) — see `seniorRolesError`. */
  editingUser?:
    | {
        role: string
        techStack?: string[] | null | undefined
        technicalRoles?: string[] | undefined
      }
    | null
    | undefined
}

/**
 * Profession section of UserDialog. A SENIOR picks technical roles (`RolesSection`, at least one,
 * shared `seniorRolesSchema`); every other role keeps the `techStack` chip field, with no floor.
 * The roles error shows on submit and then follows every change until it is fixed.
 */
export function TechStackSection({ form, editingUser }: TechStackSectionProps) {
  const { t } = useLingui()
  const original = editingUser
    ? { role: editingUser.role, technicalRoles: editingUser.technicalRoles ?? [] }
    : undefined
  return (
    <Section title={t`Професія`}>
      <form.Subscribe selector={(s) => [s.values.role as string, s.submissionAttempts] as const}>
        {([role, attempts]) =>
          role === 'SENIOR' ? (
            <form.Field
              name="technicalRoles"
              validators={{
                onSubmit: ({ value }) => seniorRolesError(role, value, original),
              }}
            >
              {(field) => (
                <RolesSection
                  value={field.state.value}
                  onChange={field.handleChange}
                  // Recomputed after the first submit, so the message follows every change.
                  error={
                    attempts > 0 ? seniorRolesError(role, field.state.value, original) : undefined
                  }
                />
              )}
            </form.Field>
          ) : (
            <form.Field name="techStack">
              {(field) => (
                <Field label={t`Технології`}>
                  <TechAutocompleteInput
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    placeholder={t`Почніть вводити: React, Node.js…`}
                  />
                </Field>
              )}
            </form.Field>
          )
        }
      </form.Subscribe>
    </Section>
  )
}
