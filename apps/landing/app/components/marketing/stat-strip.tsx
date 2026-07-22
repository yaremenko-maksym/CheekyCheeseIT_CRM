import type { StatItem } from '@/content/home'

/** About-section stats grid (landing-redesign.md §2.4 `StatStrip`, §6.3). */
export function StatStrip({ stats }: { stats: StatItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-7 md:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label}>
          <div className="text-[clamp(2.2rem,5vw,3.25rem)] leading-none font-semibold tracking-[-0.03em] text-foreground">
            {stat.value}
            <em className="text-primary not-italic">{stat.suffix}</em>
          </div>
          <div className="mt-2 text-[0.92rem] text-muted-foreground">{stat.label}</div>
        </div>
      ))}
    </div>
  )
}
