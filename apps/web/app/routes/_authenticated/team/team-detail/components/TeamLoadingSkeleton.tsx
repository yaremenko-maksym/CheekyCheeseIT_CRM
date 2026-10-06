import { Skeleton } from '@/components/ui/skeleton'

/** Loading placeholder for the team detail page (mirrors the real layout grid). */
export function TeamLoadingSkeleton() {
  return (
    <div className="space-y-6 px-6 pt-4 pb-6" data-testid="team-loading-skeleton">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-md" />
        <div className="space-y-1.5">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          {/* Members card skeleton — matches real grid gap-2 sm:grid-cols-2 */}
          <div className="rounded-xl border border-border p-4 space-y-3">
            <Skeleton className="h-5 w-36" />
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-lg" />
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    </div>
  )
}
