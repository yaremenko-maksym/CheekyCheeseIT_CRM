import { useRef, useState } from 'react'
import { CONTRACT_VARIABLE_DESCRIPTIONS } from '@crm/shared'
import type { CustomVariable } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pencil, Trash2, Plus, Check, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useContractTokens } from '@/hooks/use-contract-tokens'
import { AddCustomVariableDialog, DeleteCustomVariableDialog } from './AddCustomVariableDialog'

// ── Variable source labels ─────────────────────────────────────────────────
const SYSTEM_VARIABLE_SOURCE: Partial<Record<string, string>> = {
  employeeName: 'Карточка сотрудника',
  employeeEmail: 'Карточка сотрудника',
  role: 'Карточка сотрудника',
  onboardingDate: 'Авто',
  salary: 'Карточка сотрудника',
  salaryCurrency: 'Карточка сотрудника',
  sharePercent: 'Карточка сотрудника',
  companySharePercent: 'Авто (100 − sharePercent)',
  rnokpp: 'Карточка сотрудника',
  phone: 'Карточка сотрудника',
  registrationAddress: 'Карточка сотрудника',
  usrRecord: 'Карточка сотрудника',
  companyName: 'Константы компании',
  companyLegalName: 'Константы компании',
  companyAddress: 'Константы компании',
  companyCountry: 'Константы компании',
  companyRegNumber: 'Константы компании',
  companyVat: 'Константы компании',
  companyBank: 'Константы компании',
  companyAuthorityBasis: 'Константы компании',
  walletUsdt: 'Карточка сотрудника',
  bankUahFop: 'Карточка сотрудника',
  preferredMethod: 'Карточка сотрудника',
  requisites: 'Авто (по методу оплаты)',
  contractNumber: 'Авто (CHK-N-YYYY)',
}

// ── SystemVariableRow ──────────────────────────────────────────────────────
interface SystemVariableRowProps {
  varKey: string
  description: string
  isUsed: boolean
  onInsert: (token: string) => void
}

function SystemVariableRow({ varKey, description, isUsed, onInsert }: SystemVariableRowProps) {
  const token = `{{${varKey}}}`
  const source = SYSTEM_VARIABLE_SOURCE[varKey] ?? 'Авто'

  return (
    <div
      className="flex items-start justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors"
      data-testid={`system-var-row-${varKey}`}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
            {token}
          </code>
          {isUsed && (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
              <Check className="h-3 w-3" />
              Используется в тексте
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">{description}</p>
        <p className="text-[10px] text-muted-foreground/60">{source}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => onInsert(token)}
        aria-label={`Вставить ${token}`}
        data-testid={`insert-var-${varKey}`}
      >
        Вставить
      </Button>
    </div>
  )
}

// ── CustomVariableRow ──────────────────────────────────────────────────────
interface CustomVariableRowProps {
  variable: CustomVariable
  isUsed: boolean
  onInsert: (token: string) => void
  onUpdateLabel: (key: string, newLabel: string) => void
  onDelete: (key: string) => void
}

function CustomVariableRow({
  variable,
  isUsed,
  onInsert,
  onUpdateLabel,
  onDelete,
}: CustomVariableRowProps) {
  const token = `{{${variable.key}}}`
  const [editing, setEditing] = useState(false)
  const [labelValue, setLabelValue] = useState(variable.label)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function commitLabel() {
    const trimmed = labelValue.trim()
    if (trimmed && trimmed !== variable.label) {
      onUpdateLabel(variable.key, trimmed)
    } else {
      setLabelValue(variable.label)
    }
    setEditing(false)
  }

  return (
    <>
      <div
        className="flex items-start justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors"
        data-testid={`custom-var-row-${variable.key}`}
      >
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[11px] text-amber-700 dark:text-amber-300">
              {token}
            </span>
            {isUsed && (
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                <Check className="h-3 w-3" />
                Используется в тексте
              </span>
            )}
          </div>

          {editing ? (
            <Input
              ref={inputRef}
              value={labelValue}
              onChange={(e) => setLabelValue(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLabel()
                if (e.key === 'Escape') {
                  setLabelValue(variable.label)
                  setEditing(false)
                }
              }}
              className="h-6 text-xs py-0 px-1.5 mt-0.5"
              autoFocus
              data-testid={`cv-label-edit-${variable.key}`}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">{variable.label}</p>
          )}

          {variable.defaultValue && (
            <p className="text-[10px] text-muted-foreground/60">
              По умолчанию: {variable.defaultValue}
            </p>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onInsert(token)}
            aria-label={`Вставить ${token}`}
            data-testid={`insert-custom-var-${variable.key}`}
          >
            Вставить
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              setEditing(true)
              setTimeout(() => inputRef.current?.focus(), 0)
            }}
            aria-label={`Изменить метку ${variable.key}`}
            data-testid={`edit-cv-label-${variable.key}`}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setDeleteOpen(true)}
            aria-label={`Удалить переменную ${variable.key}`}
            data-testid={`delete-cv-${variable.key}`}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <DeleteCustomVariableDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variableKey={variable.key}
        onConfirm={() => onDelete(variable.key)}
      />
    </>
  )
}

// ── SyncWarningBanner ──────────────────────────────────────────────────────
interface SyncWarningBannerProps {
  orphanedCustom: string[]
  unknownInText: string[]
  onRegisterUnknown: (key: string) => void
}

function SyncWarningBanner({
  orphanedCustom,
  unknownInText,
  onRegisterUnknown,
}: SyncWarningBannerProps) {
  if (orphanedCustom.length === 0 && unknownInText.length === 0) return null

  return (
    <div
      className="rounded-md border-l-2 border-amber-500 bg-amber-500/8 px-3 py-2 space-y-1.5"
      data-testid="sync-warning-banner"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Несоответствия переменных
      </div>

      {orphanedCustom.map((key) => (
        <div key={key} className="text-[11px] text-amber-700 dark:text-amber-300/80">
          <code className="rounded bg-amber-500/20 px-1 font-mono">{`{{${key}}}`}</code> —
          добавлена, но не используется в тексте
        </div>
      ))}

      {unknownInText.map((key) => (
        <div key={key} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-amber-700 dark:text-amber-300/80">
            <code className="rounded bg-amber-500/20 px-1 font-mono">{`{{${key}}}`}</code> —
            используется, но не зарегистрирована
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px] text-amber-700 dark:text-amber-300 hover:bg-amber-500/15"
            onClick={() => onRegisterUnknown(key)}
            data-testid={`register-unknown-${key}`}
          >
            + Зарегистрировать
          </Button>
        </div>
      ))}
    </div>
  )
}

// ── VariablesPanel (main export) ───────────────────────────────────────────
export interface VariablesPanelProps {
  body: string
  customVariables: CustomVariable[]
  onCustomVariablesChange: (vars: CustomVariable[]) => void
  /** Called when user clicks «Вставить» — inserts token at editor cursor */
  onInsertToken: (token: string) => void
}

export function VariablesPanel({
  body,
  customVariables,
  onCustomVariablesChange,
  onInsertToken,
}: VariablesPanelProps) {
  const [addOpen, setAddOpen] = useState(false)
  const [prefillKey, setPrefillKey] = useState('')
  const [systemCollapsed, setSystemCollapsed] = useState(true)

  const { tokensInText, systemUsed, orphanedCustom, unknownInText } = useContractTokens(
    body,
    customVariables,
  )

  const systemEntries = Object.entries(CONTRACT_VARIABLE_DESCRIPTIONS)
  const existingCustomKeys = customVariables.map((v) => v.key)

  // ── Handlers ──────────────────────────────────────────────────────────────
  function handleAddVariable(variable: CustomVariable) {
    onCustomVariablesChange([...customVariables, variable])
    toast.success(`Переменная {{${variable.key}}} добавлена`)
  }

  function handleDeleteVariable(key: string) {
    onCustomVariablesChange(customVariables.filter((v) => v.key !== key))
    toast.success(`Переменная {{${key}}} удалена`)
  }

  function handleUpdateLabel(key: string, newLabel: string) {
    onCustomVariablesChange(
      customVariables.map((v) => (v.key === key ? { ...v, label: newLabel } : v)),
    )
  }

  function handleRegisterUnknown(key: string) {
    setPrefillKey(key)
    setAddOpen(true)
  }

  function handleOpenAdd() {
    setPrefillKey('')
    setAddOpen(true)
  }

  return (
    <div className="flex flex-col gap-3 overflow-y-auto" data-testid="variables-panel">
      {/* Sync warning */}
      <SyncWarningBanner
        orphanedCustom={orphanedCustom}
        unknownInText={unknownInText}
        onRegisterUnknown={handleRegisterUnknown}
      />

      {/* ── Custom variables — первые, чтобы кнопка «Добавить» сразу видна ── */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">Кастомные переменные</span>
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
              {customVariables.length}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={handleOpenAdd}
            data-testid="add-custom-variable-button"
          >
            <Plus className="h-3.5 w-3.5" />
            Добавить переменную
          </Button>
        </div>

        {customVariables.length === 0 ? (
          <p className="px-2 text-[11px] text-muted-foreground italic">
            Кастомные переменные не добавлены
          </p>
        ) : (
          <div className="space-y-0.5">
            {customVariables.map((variable) => (
              <CustomVariableRow
                key={variable.key}
                variable={variable}
                isUsed={tokensInText.has(variable.key)}
                onInsert={onInsertToken}
                onUpdateLabel={handleUpdateLabel}
                onDelete={handleDeleteVariable}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── System variables — collapsible, по умолчанию свёрнуты ─────────── */}
      <div>
        <button
          type="button"
          className="flex w-full items-center gap-2 mb-1.5 px-1 hover:opacity-80 transition-opacity"
          onClick={() => setSystemCollapsed((v) => !v)}
          aria-expanded={!systemCollapsed}
          data-testid="system-vars-toggle"
        >
          {systemCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-xs font-semibold text-foreground">Системные переменные</span>
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
            {systemEntries.length}
          </Badge>
          {systemUsed.size > 0 && (
            <span className="ml-auto text-[10px] text-muted-foreground">
              используется {systemUsed.size}
            </span>
          )}
        </button>
        {!systemCollapsed && (
          <div className="space-y-0.5">
            {systemEntries.map(([key, description]) => (
              <SystemVariableRow
                key={key}
                varKey={key}
                description={description}
                isUsed={systemUsed.has(key)}
                onInsert={onInsertToken}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add dialog */}
      <AddCustomVariableDialog
        open={addOpen}
        onOpenChange={(v) => {
          setAddOpen(v)
          if (!v) setPrefillKey('')
        }}
        existingCustomKeys={existingCustomKeys}
        prefillKey={prefillKey}
        onAdd={handleAddVariable}
      />
    </div>
  )
}
