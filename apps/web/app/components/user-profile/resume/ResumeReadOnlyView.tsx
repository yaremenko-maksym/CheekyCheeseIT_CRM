/**
 * The resume text as a viewer without write access sees it (design §4: the
 * `!canEdit` row keeps the existing read-only view; no facts form).
 *
 * Resume text is untrusted: it is only ever rendered as escaped text, and a link
 * is clickable only when `isSafeResumeUrl` accepts it (AC7).
 */
import type { ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { isSafeResumeUrl, type ResumeContent, type ResumeExperienceItem } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function ResumeReadOnlyView({ content }: { content: ResumeContent }) {
  const { t } = useLingui()
  return (
    <>
      <Section id="summary" title={t`Про себе`}>
        {content.summary.trim() === '' ? (
          <Placeholder />
        ) : (
          // `whitespace-pre-wrap` keeps the author's line breaks without any markup pass.
          <p className="whitespace-pre-wrap text-sm" data-testid="resume-summary-view">
            {content.summary}
          </p>
        )}
      </Section>

      <Section id="skills" title={t`Навички`}>
        {content.skills.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" data-testid="resume-skills-view">
            {content.skills.map((skill, i) => (
              <li key={i} className="rounded-full bg-muted px-2.5 py-1 text-xs">
                {skill}
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder />
        )}
      </Section>

      <Section id="experience" title={t`Досвід роботи`}>
        {content.experience.length > 0 ? (
          // divide-y, not a bordered box per item ("не карточка в карточке").
          <ol className="divide-y divide-border" data-testid="resume-experience-view">
            {content.experience.map((item, i) => (
              <ExperienceRow key={i} item={item} index={i} />
            ))}
          </ol>
        ) : (
          <Placeholder />
        )}
      </Section>

      <Section id="education" title={t`Освіта`}>
        {content.education.length > 0 ? (
          <ul className="space-y-2" data-testid="resume-education-view">
            {content.education.map((item, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{item.degree}</span>
                {item.institution && (
                  <span className="text-muted-foreground"> · {item.institution}</span>
                )}
                {item.period && <div className="text-xs text-muted-foreground">{item.period}</div>}
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder />
        )}
      </Section>

      <Section id="languages" title={t`Мови`}>
        {content.languages.length > 0 ? (
          <ul className="flex flex-wrap gap-2 text-sm" data-testid="resume-languages-view">
            {content.languages.map((item, i) => (
              <li key={i} className="rounded-md border px-2.5 py-1">
                {item.name}
                {item.level && <span className="text-muted-foreground"> — {item.level}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder />
        )}
      </Section>

      <Section id="links" title={t({ message: 'Посилання', context: 'resume' })}>
        {content.links.length > 0 ? (
          <ul className="space-y-1.5 text-sm" data-testid="resume-links-view">
            {content.links.map((item, i) => (
              <li key={i}>
                {/* The server already rejects other schemes; an unsafe URL degrades to text. */}
                {isSafeResumeUrl(item.url) ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-primary underline underline-offset-2"
                  >
                    {item.label || item.url}
                  </a>
                ) : (
                  <span className="text-muted-foreground">{item.label || item.url}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder />
        )}
      </Section>
    </>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card data-testid={`resume-section-${id}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Placeholder() {
  return (
    <p className="text-sm italic text-muted-foreground">
      <Trans>Не заповнено</Trans>
    </p>
  )
}

function ExperienceRow({ item, index }: { item: ResumeExperienceItem; index: number }) {
  const bullets = item.bullets.filter((b) => b.trim() !== '')
  return (
    <li
      className="space-y-1 py-3 first:pt-0 last:pb-0"
      data-testid={`resume-experience-row-${index}`}
    >
      <p className="text-sm font-medium">
        {item.role}
        {item.company && <span className="text-muted-foreground"> — {item.company}</span>}
      </p>
      {item.period && <p className="text-xs text-muted-foreground">{item.period}</p>}
      {bullets.length > 0 && (
        <ul className="list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
          {bullets.map((bullet, i) => (
            <li key={i}>{bullet}</li>
          ))}
        </ul>
      )}
    </li>
  )
}
