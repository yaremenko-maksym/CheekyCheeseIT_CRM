import { useId } from 'react'
import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { useLingui } from '@lingui/react/macro'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { Field, Section } from '../section'
import { seniorTechStackError } from './validation'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface TechStackSectionProps {
  form: Pick<AnyForm, 'Field' | 'Subscribe'>
  /** The stored user on edit (`null` on create) — see `seniorTechStackError`. */
  editingUser?: { role: string; techStack?: string[] | null | undefined } | null | undefined
}

/**
 * Profession (tech stack) section of UserDialog: the `techStack` chip field.
 * A SENIOR needs at least 3 distinct technologies (shared rule); the error shows
 * on submit and then follows every change until it is fixed.
 */
export function TechStackSection({ form, editingUser }: TechStackSectionProps) {
  const { t } = useLingui()
  const errorId = useId()
  const original = editingUser
    ? { role: editingUser.role, techStack: editingUser.techStack }
    : undefined
  return (
    <Section title={t`Професія`}>
      <form.Subscribe selector={(s) => [s.values.role as string, s.submissionAttempts] as const}>
        {([role, attempts]) => (
          <form.Field
            name="techStack"
            validators={{
              onSubmit: ({ value }) => seniorTechStackError(role, value, original),
            }}
          >
            {(field) => {
              // Recomputed from the current role + stack after the first submit, so the
              // message follows every change and never goes stale.
              const err =
                attempts > 0 ? seniorTechStackError(role, field.state.value, original) : undefined
              return (
                <Field label={t`Технології`} error={err} errorId={errorId}>
                  <TechAutocompleteInput
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    placeholder={t`Почніть вводити: React, Node.js…`}
                    errorId={err ? errorId : undefined}
                  />
                </Field>
              )
            }}
          </form.Field>
        )}
      </form.Subscribe>
    </Section>
  )
}
