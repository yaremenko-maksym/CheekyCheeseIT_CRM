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
  form: Pick<AnyForm, 'Field'>
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
      <form.Field
        name="techStack"
        validators={{
          onChangeListenTo: ['role'],
          onChange: ({ value, fieldApi }) =>
            fieldApi.form.state.submissionAttempts > 0
              ? seniorTechStackError(fieldApi.form.getFieldValue('role'), value, original)
              : undefined,
          onSubmit: ({ value, fieldApi }) =>
            seniorTechStackError(fieldApi.form.getFieldValue('role'), value, original),
        }}
      >
        {(field) => {
          const err = field.state.meta.errors[0] as string | undefined
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
    </Section>
  )
}
