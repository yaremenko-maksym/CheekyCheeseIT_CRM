/**
 * telemetry/form-abandon — task-telemetry-web AC1 ("form_abandon-детектор —
 * чистая функция тестируема без DOM-хаков").
 *
 * Tracks a Sheet/Dialog-with-form's open → dirty → close lifecycle and
 * decides `form_submit` vs `form_abandon` vs nothing (spec §3: "открыл +
 * ввёл что-то (dirty) + закрыл без submit → abandon (target = имя формы,
 * БЕЗ каких-либо значений полей)"). Pure state machine, keyed by form name
 * so several forms can be tracked independently in the same session — see
 * `use-form-abandon-tracking.ts` for the React-facing wiring.
 */
export type FormCloseOutcome = 'abandon' | 'submitted' | 'none'

interface FormState {
  dirty: boolean
  submitted: boolean
}

export class FormAbandonTracker {
  private readonly forms = new Map<string, FormState>()

  /** Call when the Sheet/Dialog housing `formName` opens — (re)starts tracking clean. */
  open(formName: string): void {
    this.forms.set(formName, { dirty: false, submitted: false })
  }

  /** Call whenever the form's dirty flag flips true (e.g. TanStack Form `state.isDirty`). */
  markDirty(formName: string): void {
    const state = this.forms.get(formName)
    if (state) state.dirty = true
  }

  /** Call right before/at a successful submit — suppresses the abandon signal on the subsequent close. */
  markSubmitted(formName: string): void {
    const state = this.forms.get(formName)
    if (state) state.submitted = true
  }

  /**
   * Call when the Sheet/Dialog closes. `'abandon'` only when the form was
   * dirty and never marked submitted; `'submitted'` when it was;
   * `'none'` when the user closed a pristine (never-touched) form, or when
   * `formName` was never opened — neither is worth a signal.
   */
  close(formName: string): FormCloseOutcome {
    const state = this.forms.get(formName)
    this.forms.delete(formName)
    if (!state) return 'none'
    if (state.submitted) return 'submitted'
    if (state.dirty) return 'abandon'
    return 'none'
  }
}
