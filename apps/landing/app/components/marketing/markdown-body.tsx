import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/**
 * Vacancy description renderer (landing-redesign.md §2.4 `MarkdownBody`,
 * Vacancy.dc.html `.cc-prose`). Same pattern as
 * `apps/web/app/components/onboarding/AcceptTosStep.tsx` — `<ReactMarkdown>`
 * WITHOUT `rehype-raw`, so raw HTML embedded in `descriptionMd` never
 * renders (safe by default, no separate sanitizer needed).
 */
export function MarkdownBody({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <article
      className={cn(
        'leading-[1.72] text-foreground/82',
        '[&_h3]:mt-[30px] [&_h3]:mb-3 [&_h3]:text-[1.15rem] [&_h3]:font-semibold [&_h3]:tracking-[-0.01em] [&_h3]:text-foreground',
        '[&_p]:mb-4 [&_p]:mt-0',
        '[&_ul]:mb-[18px] [&_ul]:list-disc [&_ul]:pl-5',
        '[&_li]:mb-2 [&_li]:marker:text-primary',
        '[&_strong]:font-semibold [&_strong]:text-foreground',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </article>
  )
}
