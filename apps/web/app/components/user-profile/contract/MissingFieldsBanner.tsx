import { AlertTriangle } from 'lucide-react'
import type { ContractVariableInfo } from '@crm/shared'

interface MissingFieldsBannerProps {
  missingVariables: ContractVariableInfo[]
  userId: string
}

/**
 * Screen 2: Shows a banner listing all empty variables that block
 * the "Готов к подписанию" button, with a link to the employee profile
 * for user-sourced fields.
 */
export function MissingFieldsBanner({ missingVariables, userId }: MissingFieldsBannerProps) {
  if (missingVariables.length === 0) return null

  const profileVars = missingVariables.filter((v) => v.source === 'user')
  const customVars = missingVariables.filter((v) => v.source === 'custom' || v.source === 'unknown')

  return (
    <div
      className="rounded-md border-l-2 border-amber-500 bg-amber-500/8 px-3 py-2.5 space-y-2"
      data-testid="missing-fields-banner"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Необходимо заполнить перед генерацией
      </div>

      {profileVars.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-amber-700/80 dark:text-amber-400/70">
            Из карточки сотрудника (заполните в профиле):
          </p>
          <ul className="space-y-0.5 pl-2">
            {profileVars.map((v) => (
              <li key={v.key} className="flex items-center gap-1.5 text-[11px]">
                <span className="h-1 w-1 rounded-full bg-amber-500 shrink-0" />
                <span className="text-amber-700 dark:text-amber-300">
                  {v.label}{' '}
                  <code className="rounded bg-amber-500/15 px-1 font-mono text-[10px]">
                    {`{{${v.key}}}`}
                  </code>
                </span>
              </li>
            ))}
          </ul>
          <a
            href={`/profile/${userId}?tab=requisites`}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:no-underline"
            data-testid="fill-in-profile-link"
          >
            Заполнить в профиле →
          </a>
        </div>
      )}

      {customVars.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-amber-700/80 dark:text-amber-400/70">
            Кастомные переменные (заполните ниже):
          </p>
          <ul className="space-y-0.5 pl-2">
            {customVars.map((v) => (
              <li key={v.key} className="flex items-center gap-1.5 text-[11px]">
                <span className="h-1 w-1 rounded-full bg-amber-500 shrink-0" />
                <span className="text-amber-700 dark:text-amber-300">
                  {v.label}{' '}
                  <code className="rounded bg-amber-500/15 px-1 font-mono text-[10px]">
                    {`{{${v.key}}}`}
                  </code>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
