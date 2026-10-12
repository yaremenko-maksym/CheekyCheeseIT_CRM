import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DialogTxType, ProjectOption } from './shared'

// Project selector + the USDT gate hints (SENIOR / DROP / ACCOUNTANT).
export function ProjectSelectSection({
  type,
  projectId,
  fieldErrors,
  adminProjects,
  dropProjects,
  myProjects,
  adminOwnProjects,
  projects,
  userId,
  isAccountant,
  onProjectChange,
}: {
  type: DialogTxType
  projectId: string
  fieldErrors: Record<string, string>
  adminProjects: ProjectOption[]
  dropProjects: ProjectOption[]
  myProjects: ProjectOption[]
  adminOwnProjects: ProjectOption[]
  projects: ProjectOption[]
  userId: string | undefined
  isAccountant: boolean
  onProjectChange: (v: string) => void
}) {
  const { t } = useLingui()
  return (
    <>
      {/* Project selector */}
      {(type === 'SENIOR_INCOME' || type === 'ADMIN_INCOME' || type === 'DROP_INCOME') && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            <Trans>Проєкт</Trans>
          </Label>
          <Select value={projectId} onValueChange={onProjectChange}>
            <SelectTrigger
              className={cn(
                // Stryker disable next-line StringLiteral: `SelectTrigger`'s own base classes already include `h-9` and `text-sm`, and `cn` (tailwind-merge) de-duplicates them — dropping this redundant pair from the className changes no rendered class, so it is unobservable by construction (the `border-destructive` literal on the next line IS pinned by the error-state tests).
                'h-9 text-sm',
                fieldErrors.project && 'border-destructive',
              )}
              data-testid="create-transaction-project-trigger"
            >
              <SelectValue
                placeholder={
                  // Stryker disable next-line StringLiteral: unselected-state placeholder text — never rendered in a project-selected test fixture, and the empty-selection case is asserted via `create-transaction-error-project`'s message (`validate()`), not this placeholder.
                  t`Виберіть проєкт`
                }
              />
            </SelectTrigger>
            <SelectContent>
              {(type === 'ADMIN_INCOME'
                ? adminProjects
                : type === 'DROP_INCOME'
                  ? dropProjects
                  : myProjects
              ).map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-sm">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldErrors.project && (
            <p
              className="text-[11px] text-destructive"
              data-testid="create-transaction-error-project"
            >
              {fieldErrors.project}
            </p>
          )}
        </div>
      )}

      {/* task-drop-share-override-and-receiver (Surface B, ADR D2). Gate
              hints — shown only when the SENIOR/DROP genuinely has projects but
              ALL of them are USDT-payment (the filtered pool is empty despite a
              non-empty underlying list). A senior/drop with a mix of FOP/GIG +
              USDT projects sees no hint — the USDT ones are just silently
              absent from the Select above. */}
      {type === 'SENIOR_INCOME' &&
        projects.some((p) => p.seniorId === userId) &&
        myProjects.length === 0 && (
          <p
            className="text-xs text-muted-foreground italic"
            data-testid="senior-income-usdt-gate-hint"
          >
            <Trans>
              На всіх ваших проєктах дохід декларує адміністратор (USDT). Звертайтеся до
              адміністратора.
            </Trans>
          </p>
        )}
      {type === 'DROP_INCOME' &&
        projects.some((p) => p.dropId === userId) &&
        dropProjects.length === 0 && (
          <p
            className="text-xs text-muted-foreground italic"
            data-testid="drop-income-usdt-gate-hint"
          >
            <Trans>
              На всіх ваших проєктах дохід декларує адміністратор (USDT). Звертайтеся до
              адміністратора.
            </Trans>
          </p>
        )}
      {/* task-admin-income-unified. ACCOUNTANT-only hint: unlike ADMIN
              (whose pool now includes every USDT project, unified — see
              `adminProjects` above), the accountant's pool still excludes
              them — `declareUsdtProjectIncome` is ADMIN-only server-side, so
              offering a project that endpoint will 403 on is a dead end. Shown
              only when it actually cost the accountant something (their
              admin-owned pool is non-empty but every project in it is USDT). */}
      {type === 'ADMIN_INCOME' &&
        isAccountant &&
        adminOwnProjects.length > 0 &&
        adminProjects.length === 0 && (
          <p
            className="text-xs text-muted-foreground italic"
            data-testid="admin-income-accountant-usdt-gate-hint"
          >
            <Trans>Дохід за USDT-проєктами може провести лише адміністратор.</Trans>
          </p>
        )}
    </>
  )
}
