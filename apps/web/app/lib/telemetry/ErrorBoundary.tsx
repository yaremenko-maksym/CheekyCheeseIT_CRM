/**
 * telemetry/ErrorBoundary — task-telemetry-web §3 ("интеграция с
 * существующим ErrorBoundary — найди через ast-grep; если его нет —
 * добавь корневой"). ast-grep/codegraph search (T2 recon) found no
 * pre-existing error boundary anywhere in `apps/web` — this is the first
 * one, mounted at the very top of `__root.tsx` (via `TelemetryProvider`) so
 * it catches render errors from EVERY CRM route, authenticated or not.
 *
 * Class component — `componentDidCatch` is the only React error-catching
 * primitive; there's no hook equivalent. Reports through the same
 * fail-silent `reportClientError` pipeline as `window.onerror`/
 * `unhandledrejection` (same dedupe, same immediate-send, same disabled-SDK
 * no-op) — see `errors.ts`.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { reportClientError } from './errors'

interface TelemetryErrorBoundaryProps {
  children: ReactNode
}

interface TelemetryErrorBoundaryState {
  hasError: boolean
}

export class TelemetryErrorBoundary extends Component<
  TelemetryErrorBoundaryProps,
  TelemetryErrorBoundaryState
> {
  state: TelemetryErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): TelemetryErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(error.message, { stack: error.stack ?? info.componentStack ?? undefined })
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <p className="text-lg font-semibold text-foreground">Что-то пошло не так</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Произошла непредвиденная ошибка. Мы уже знаем о ней — попробуйте обновить страницу.
        </p>
        <Button onClick={this.handleReload}>Обновить страницу</Button>
      </div>
    )
  }
}
