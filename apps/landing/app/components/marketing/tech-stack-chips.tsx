import { Chip } from '@/components/ui/chip'

/** "Tech stack" chip grid (landing-redesign.md §2.4 `TechStackChips`). */
export function TechStackChips({ stack }: { stack: string[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {stack.map((tech) => (
        <Chip key={tech}>{tech}</Chip>
      ))}
    </div>
  )
}
