import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { useLingui } from '@lingui/react/macro'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { Field, Section } from '../section'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface TechStackSectionProps {
  form: Pick<AnyForm, 'Field'>
}

/**
 * Profession (tech stack) section of UserDialog: the `techStack` chip field.
 * Pure move out of UserDialog — behavior unchanged.
 */
export function TechStackSection({ form }: TechStackSectionProps) {
  const { t } = useLingui()
  return (
    <Section title={t`Професія`}>
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
    </Section>
  )
}
