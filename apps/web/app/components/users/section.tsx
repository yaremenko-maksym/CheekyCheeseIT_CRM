import { useId } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'

/**
 * Generic section wrapper for sectioned dialogs
 * (Identity / Contacts / Tech / Finance / Team).
 *
 * Uses semantic `<section aria-labelledby>` + `<h3>` so screen readers
 * announce the section title when navigating into the group.
 */
export function Section({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className={cn('rounded-md border border-border/60 bg-muted/20 p-3 space-y-3', className)}
    >
      <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function Field({
  label,
  error,
  required,
  children,
}: {
  label: string
  error?: string | undefined
  required?: boolean | undefined
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label className={cn(error && 'text-destructive')}>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
