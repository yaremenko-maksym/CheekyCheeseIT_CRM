import { useForm } from '@tanstack/react-form'
import { useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import { Pencil, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CreateUserDto, UserProfileDto } from '@crm/shared'
import { adminUpdateUserSchema, createDropSchema, createUserSchema } from '@crm/shared'
import { toast } from 'sonner'
import { useAuth } from '@/context/auth'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogHeader,
  Dialog,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { translateZodCode, translateZodMessage } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { CreateWizardStepper } from './CreateWizardStepper'
import { WizardStep2 } from './user-dialog/WizardStep2'
import { WizardStep3 } from './user-dialog/WizardStep3'
import { ContactsSection } from './user-dialog/ContactsSection'
import { FinanceSection } from './user-dialog/FinanceSection'
import { PaymentRequisitesSection } from './user-dialog/PaymentRequisitesSection'
import { TeamSection } from './user-dialog/TeamSection'
import { IdentitySection } from './user-dialog/IdentitySection'
import { TechStackSection } from './user-dialog/TechStackSection'
import { ContractDataSection } from './user-dialog/ContractDataSection'
import { EmailChangeWarningDialog } from './user-dialog/EmailChangeWarningDialog'
import { UserDialogFooter } from './user-dialog/UserDialogFooter'
import { useCreateWizard } from './user-dialog/useCreateWizard'
import { useUserDialogMutations } from './user-dialog/useUserDialogMutations'
import { useEditingUser } from './user-dialog/useEditingUser'
import { useUserDialogData } from './user-dialog/useUserDialogData'
import { useTeamSelection } from './user-dialog/useTeamSelection'

// Re-exported so existing test imports from '../UserDialog' keep resolving.
export { WizardStep2 }
import { buildUserDialogDefaults } from './user-dialog/form-defaults'
import {
  buildCreateDropPayload,
  buildCreateUserPayload,
  buildEditUpdatePayload,
  buildWizardUpdatePayload,
} from './user-dialog/payloads'

type CommonProps = {
  mode: 'create' | 'edit'
  onClose: () => void
  /** Restrict role choices to SENIOR-only (HR creating senior). create mode. */
  hrOnly?: boolean
}

type CreateProps = CommonProps & { mode: 'create'; open: boolean; user?: never }
type EditProps = CommonProps & { mode: 'edit'; user: UserProfileDto | null; open?: never }

export type UserDialogProps = CreateProps | EditProps

/**
 * Sectioned user CRUD dialog. 6 sections in a single vertical scroll:
 *   1. Identity (email + name + role)
 *   2. Contacts (telegram + phone)
 *   3. Tech stack
 *   4. Finance (SENIOR ShareSlider | non-SENIOR monthly salary with currency)
 *   5. Payment requisites (USDT / Bank UAH FOP)
 *   6. Team (SENIOR HR multiselect + Accountant; JUNIOR initial project (create) / current projects read-only (edit))
 *
 * Sticky footer: role badge (left) + Cancel/Submit (right).
 *
 * Edit mode now allows email changes (ut-9) — with a confirm dialog warning
 * about Google OAuth breakage. ADMIN cannot edit another ADMIN (ut-10), cannot
 * change their own role (ut-11), and ADMIN is removed from Create's role
 * dropdown (ut-12).
 */
export function UserDialog(props: UserDialogProps) {
  const { t } = useLingui()
  const queryClient = useQueryClient()
  const { user: me } = useAuth()
  const isCreate = props.mode === 'create'
  const isEdit = props.mode === 'edit'
  const open = isCreate ? props.open : !!props.user
  const listUser = isEdit ? props.user : null

  const { editingUser, fullProfileLoadedId } = useEditingUser({ isEdit, open, listUser })

  const hrOnly = isCreate ? !!props.hrOnly : false

  // ── Wizard state (create-mode only) ─────────────────────────────────────
  const {
    currentStep,
    setCurrentStep,
    createdUserId,
    setCreatedUserId,
    hasContract,
    setHasContract,
    wizardContractBody,
    setWizardContractBody,
    wizardContractDirty,
    setWizardContractDirty,
    handleWizardSaveDraft,
  } = useCreateWizard({
    isCreate,
    open,
    queryClient,
    onClose: props.onClose,
    draftSavedMessage: t`Користувача створено, контракт збережено як чернетку`,
  })

  // ut-11: SENIOR/ADMIN locked for self-ADMIN edit. We compute it once and
  // reuse in the Role select + footer hint.
  const isSelfAdminEdit =
    isEdit && !!editingUser && !!me && editingUser.id === me.id && editingUser.role === 'ADMIN'

  // ── Auxiliary data: HR / Accountant / project / team queries + derived lists ──
  const {
    exchangeRates,
    allTeams,
    hrUsers,
    accountantUsers,
    vacantDropTeams,
    juniorActiveProjects,
    availableJuniorProjects,
  } = useUserDialogData({ open, isCreate, isEdit, editingUser })

  // ── Mutations ────────────────────────────────────────────────────────────
  const {
    createMutation,
    createDropMutation,
    wizardUpdateMutation,
    markReadyMutation,
    updateMutation,
  } = useUserDialogMutations({
    queryClient,
    createdUserId,
    setCreatedUserId,
    setCurrentStep,
    setHasContract,
    editingUser,
    onClose: props.onClose,
  })

  // ── Form ─────────────────────────────────────────────────────────────────
  const form = useForm({
    defaultValues: buildUserDialogDefaults(editingUser, { hrOnly }),
    onSubmit: async ({ value }) => {
      const isSenior = value.role === 'SENIOR'
      const isDrop = value.role === 'DROP'
      const hrIds = selectedHrIdsRef.current
      const accountantId = selectedAccountantIdRef.current

      if (isCreate && isDrop) {
        // DROP creation hits the dedicated endpoint which atomically
        // provisions both the user and the drop-team. HR is mandatory (≥1);
        // the accountant picker is OPTIONAL (a workspace may have 0
        // accountants — a drop-team is valid without one, same as a senior
        // team). We surface an inline error under the HR multiselect AND a
        // field-specific toast so the user sees *which* field blocked submit
        // even if their eyes are off the form.
        if (hrIds.length === 0) {
          setHrError(translateZodCode('HR_REQUIRED_MIN'))
          toast.error(translateZodCode('HR_REQUIRED_MIN'))
          return
        }
        const payload = buildCreateDropPayload(value, { hrIds, accountantId })
        const result = createDropSchema.safeParse(payload)
        if (!result.success) {
          const first = result.error.issues[0]
          toast.error(
            // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
            translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
          )
          return
        }
        createDropMutation.mutate(result.data)
        return
      }

      if (isCreate) {
        // A3-3 AC6: if user was already created (createdUserId set after first
        // successful POST), «Далее» from step 1 must PATCH — not POST again.
        // This handles the «Назад» → edit → «Далее» flow without 409 duplicate.
        if (createdUserId !== null) {
          const updatePayload = buildWizardUpdatePayload(value, {
            hrIds,
            accountantId,
            exchangeRates,
          })
          const updateResult = adminUpdateUserSchema.safeParse(updatePayload)
          if (!updateResult.success) {
            const first = updateResult.error.issues[0]
            toast.error(
              // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
              translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
            )
            return
          }
          wizardUpdateMutation.mutate(updateResult.data)
          return
        }

        // Drop role - phase 1 (AC3): when JOIN_DROP_TEAM, HR/accountant are
        // sourced from the existing drop-team — local pickers stay hidden
        // and we skip the «HR required» guard. CREATE_NEW retains the
        // legacy validation 1:1.
        const isJoinDropTeam = isSenior && value.teamMode === 'JOIN_DROP_TEAM'
        if (isSenior && !isJoinDropTeam && hrIds.length === 0) {
          // Same inline + toast pair as the DROP branch — see comment above.
          // Toast names the field so the user knows what blocked submit.
          setHrError(translateZodCode('HR_REQUIRED_MIN'))
          toast.error(translateZodCode('HR_REQUIRED_MIN'))
          return
        }
        if (isJoinDropTeam && !value.dropTeamId) {
          toast.error(translateZodCode('DROP_TEAM_ID_REQUIRED'))
          return
        }

        const payload: CreateUserDto = buildCreateUserPayload(value, {
          hrIds,
          accountantId,
          exchangeRates,
        })
        const result = createUserSchema.safeParse(payload)
        if (!result.success) {
          // Surface the first issue inline + as a single toast — the form
          // fields keep their own per-field error indicators below.
          const first = result.error.issues[0]
          toast.error(
            // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
            translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
          )
          return
        }
        createMutation.mutate(result.data)
      } else {
        // Edit
        const payload = buildEditUpdatePayload(value, {
          editingUser,
          hrIds,
          accountantId,
          exchangeRates,
        })
        const result = adminUpdateUserSchema.safeParse(payload)
        if (!result.success) {
          const first = result.error.issues[0]
          toast.error(
            // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
            translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
          )
          return
        }
        updateMutation.mutate(result.data)
      }
    },
  })

  // ── Team selection (SENIOR/DROP HR + Accountant) ─────────────────────────
  // Must stay after `useUserDialogData` (reads its lists) and `useForm` (takes `form`).
  const {
    selectedHrIds,
    selectedAccountantId,
    setSelectedAccountantId,
    hrError,
    setHrError,
    handleHrChange,
    selectedHrIdsRef,
    selectedAccountantIdRef,
  } = useTeamSelection(form, {
    editingUser,
    allTeams,
    hrUsers,
    accountantUsers,
    isCreate,
    isEdit,
    open,
  })

  // ut-9: Email change warning. We delay the form-level update until the admin
  // confirms; cancel reverts the field to the original email.
  const [pendingEmailChange, setPendingEmailChange] = useState<string | null>(null)
  const originalEmail = editingUser?.email ?? ''

  // Re-seed form when editing user changes (dialog reopens for different user).
  // `form.reset(defaults)` is idiomatic TanStack Form re-seed — clears touched/dirty
  // state between edit sessions, unlike per-field setFieldValue which preserves them.
  // Deps are intentionally limited to `editingUser?.id` + `isEdit`: `form` is
  // stable and re-running on every prop change would clobber user edits in-flight.
  useEffect(() => {
    if (isEdit && editingUser) {
      form.reset(buildUserDialogDefaults(editingUser, { hrOnly }))
    }
    // Re-seed when the edited user changes AND when the full profile finishes
    // loading (slim list → full /:id). `fullProfileLoadedId` flips from null to
    // the user id once GET /api/users/:id resolves, so the requisite / salary /
    // FOP-PII fields (absent from the slim list) get prefilled into the form.
    // `form` is stable and intentionally excluded (re-running on every form
    // change would clobber edits in progress).
  }, [editingUser?.id, isEdit, fullProfileLoadedId])

  const handleClose = () => {
    if (isCreate) {
      form.reset()
      setCurrentStep(1)
      setCreatedUserId(null)
      setHasContract(false)
    }
    props.onClose()
  }

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    createDropMutation.isPending ||
    wizardUpdateMutation.isPending ||
    markReadyMutation.isPending
  const submitLabel = isCreate
    ? createMutation.isPending || createDropMutation.isPending
      ? t`Створюємо…`
      : // Stryker disable next-line StringLiteral: unreachable in the DOM — `submitLabel` is only ever rendered by the `user-dialog-submit` button in the `!isCreate` footer branch below (create mode shows the wizard's own step buttons instead), so this half of the ternary is computed every create-mode render but never inserted anywhere a test (or a user) can observe.
        t`Створити`
    : updateMutation.isPending
      ? t`Зберігаємо…`
      : t`Зберегти`

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
        <CrmDialogContent maxWidth="sm:max-w-lg" data-testid="user-dialog">
          <CrmDialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isCreate ? (
                <>
                  <UserPlus className="h-4 w-4" />
                  <Trans>Новий користувач</Trans>
                </>
              ) : (
                <>
                  <Pencil className="h-4 w-4" />
                  <Trans>Редагувати користувача</Trans>
                </>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Створення або редагування користувача</Trans>
            </DialogDescription>
          </CrmDialogHeader>

          <CrmDialogBody>
            {/* ── Wizard Stepper (create-mode only) ─────────────────────── */}
            {isCreate && (
              <div className="px-1 pt-2">
                <CreateWizardStepper current={currentStep} />
              </div>
            )}

            {/* ── Step 2: Contract editor (create wizard) ────────────────── */}
            {isCreate && currentStep === 2 && createdUserId && (
              <WizardStep2
                userId={createdUserId}
                onHasContract={setHasContract}
                body={wizardContractBody}
                onBodyChange={(v) => {
                  setWizardContractBody(v)
                  setWizardContractDirty(true)
                }}
                isDirty={wizardContractDirty}
              />
            )}

            {/* ── Step 3: Confirm (create wizard) ───────────────────────── */}
            {isCreate && currentStep === 3 && (
              <WizardStep3
                hasContract={hasContract}
                onSaveDraft={handleWizardSaveDraft}
                onMarkReady={() => markReadyMutation.mutate()}
                isMarkingReady={markReadyMutation.isPending}
                onBack={() => setCurrentStep(2)}
              />
            )}

            {/* ── Step 1 form (or edit form) — hidden at wizard steps 2/3 ─ */}
            <div className={cn('grid gap-3 py-2', isCreate && currentStep !== 1 && 'hidden')}>
              {/* ── Section 1: Identity ─────────────────────────────────── */}
              <IdentitySection
                form={form}
                isCreate={isCreate}
                isEdit={isEdit}
                editingUser={editingUser}
                hrOnly={hrOnly}
                isSelfAdminEdit={isSelfAdminEdit}
                originalEmail={originalEmail}
                onEmailChangeIntent={setPendingEmailChange}
              />

              {/* ── Section 1.5: Contract data (non-ADMIN only) ─────────── */}
              <ContractDataSection form={form} isCreate={isCreate} />

              {/* ── Section 2: Contacts ─────────────────────────────────── */}
              <ContactsSection form={form} />

              {/* ── Section 3: Profession (Tech stack) ──────────────────── */}
              <TechStackSection form={form} />

              {/* ── Section 4: Finance ──────────────────────────────────── */}
              <FinanceSection form={form} isCreate={isCreate} editingUser={editingUser} />

              <PaymentRequisitesSection form={form} />

              <TeamSection
                form={form}
                isCreate={isCreate}
                isEdit={isEdit}
                hrUsers={hrUsers}
                accountantUsers={accountantUsers}
                selectedHrIds={selectedHrIds}
                handleHrChange={handleHrChange}
                hrError={hrError}
                selectedAccountantId={selectedAccountantId}
                setSelectedAccountantId={setSelectedAccountantId}
                vacantDropTeams={vacantDropTeams}
                availableJuniorProjects={availableJuniorProjects}
                juniorActiveProjects={juniorActiveProjects}
                onClose={props.onClose}
              />
            </div>
            {/* end step-1 form grid */}
          </CrmDialogBody>

          <UserDialogFooter
            form={form}
            isCreate={isCreate}
            currentStep={currentStep}
            setCurrentStep={setCurrentStep}
            isPending={isPending}
            submitLabel={submitLabel}
            createPending={createMutation.isPending}
            onClose={handleClose}
          />
        </CrmDialogContent>
      </Dialog>

      {/* ut-9: Email change warning. Confirms or reverts the email field. */}
      <EmailChangeWarningDialog
        pendingEmailChange={pendingEmailChange}
        editingUser={editingUser}
        originalEmail={originalEmail}
        onCancel={() => {
          form.setFieldValue('email', originalEmail)
          setPendingEmailChange(null)
        }}
        // Stryker disable next-line ArrowFunction: equivalent mutant — Radix AlertDialogAction also fires onOpenChange(false), whose onDismiss clears the same state, so no assertion can tell a no-op onConfirm apart (kept verbatim from the pre-extraction handler)
        onConfirm={() => setPendingEmailChange(null)}
        onDismiss={() => setPendingEmailChange(null)}
      />
    </>
  )
}
