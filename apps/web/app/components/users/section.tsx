import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'

/** Generic section wrapper for sectioned dialogs (Identity / Contacts / Tech / Finance / Team). */
export function Section({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-md border border-border/60 bg-muted/20 p-3 space-y-3', className)}>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
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
