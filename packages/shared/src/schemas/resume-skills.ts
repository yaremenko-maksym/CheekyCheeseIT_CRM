/**
 * Canonical resume skills vocabulary (verified-base-resume spec §3).
 *
 * A resume stores each skill once, in its display form (`Node.js`, not `nodejs`
 * and `Node JS` side by side). Spellings are folded through the vacancy
 * matcher's tokenizer (`stackTokens`), so `C#`, `C++`, `.NET`, `CI/CD` and the
 * `X.js` convention survive as distinct tokens instead of collapsing to `c` or
 * `net`, and the resume and vacancy sides never disagree on what a token is.
 */
import { stackTokens } from '../utils/stack-keywords'

export const SKILL_SYNONYM_GROUPS: readonly { canonical: string; aliases: readonly string[] }[] = [
  // --- languages ---
  { canonical: 'JavaScript', aliases: ['JS', 'ECMAScript'] },
  { canonical: 'TypeScript', aliases: ['TS'] },
  { canonical: 'Python', aliases: ['Python3', 'Python 3'] },
  { canonical: 'Go', aliases: ['Golang'] },
  { canonical: 'Java', aliases: [] },
  { canonical: 'Kotlin', aliases: [] },
  { canonical: 'C#', aliases: ['C Sharp'] },
  { canonical: 'C++', aliases: ['CPP'] },
  // --- runtimes / frameworks ---
  { canonical: 'Node.js', aliases: ['Node', 'NodeJS', 'Node JS'] },
  { canonical: 'React', aliases: ['React.js', 'ReactJS'] },
  { canonical: 'Next.js', aliases: ['NextJS'] },
  { canonical: 'Vue.js', aliases: ['Vue', 'VueJS'] },
  { canonical: 'Angular', aliases: ['AngularJS', 'Angular.js'] },
  { canonical: '.NET', aliases: ['dotnet', 'dot net', 'dotnet core', 'net core', 'netcore'] },
  // --- data ---
  { canonical: 'PostgreSQL', aliases: ['Postgres', 'psql'] },
  { canonical: 'MySQL', aliases: [] },
  { canonical: 'MongoDB', aliases: ['Mongo', 'Mongo DB'] },
  { canonical: 'Redis', aliases: [] },
  // --- platform / infra ---
  { canonical: 'Docker', aliases: [] },
  { canonical: 'Kubernetes', aliases: ['K8s', 'kube'] },
  { canonical: 'Amazon Web Services (AWS)', aliases: ['AWS', 'Amazon Web Services'] },
  {
    canonical: 'Google Cloud Platform (GCP)',
    aliases: ['GCP', 'Google Cloud', 'Google Cloud Platform'],
  },
  { canonical: 'Azure', aliases: ['Microsoft Azure'] },
  { canonical: 'Terraform', aliases: [] },
  { canonical: 'CI/CD', aliases: ['CICD', 'CI-CD', 'CI CD'] },
  // --- API styles ---
  { canonical: 'GraphQL', aliases: ['Graph QL'] },
  { canonical: 'REST', aliases: ['REST API', 'RESTful', 'RESTful API'] },
]

/** Normalised lookup key: tokenizer-folded, separators removed (`Node JS` → `nodejs`). */
function keyOf(raw: string): string {
  return stackTokens(raw).join('')
}

/** Space-joined token phrase, padded so `includes` only hits whole tokens. */
function phraseOf(raw: string): string {
  // `C Sharp` / `Java Script` would otherwise leave a bare `c` / `java` token that matches C / Java.
  const folded = raw
    .replace(/\bc\s+sharp\b/gi, 'csharp')
    .replace(/\bjava\s+script\b/gi, 'javascript')
  return ` ${stackTokens(folded).join(' ')} `
}

/**
 * Every spelling of the group `raw` belongs to, or undefined for an unknown skill.
 * Looked up at call time, not via a module-level index: a table this small costs
 * nothing to scan, and load-time code is code the mutation gate cannot exercise.
 */
function spellingsOf(raw: string): string[] | undefined {
  const key = keyOf(raw)
  const group = SKILL_SYNONYM_GROUPS.find(({ canonical, aliases }) =>
    [canonical, ...aliases].some((spelling) => keyOf(spelling) === key),
  )
  return group && [group.canonical, ...group.aliases]
}

/** The display form of a skill; an unknown skill passes through trimmed. */
export function canonicalSkill(raw: string): string {
  const trimmed = raw.trim()
  return spellingsOf(trimmed)?.[0] ?? trimmed
}

/** Skills, then each job's technologies: canonicalised, blanks dropped, first-seen order. */
export function mergeSkills(skills: string[], technologies: string[][]): string[] {
  const merged = new Map<string, string>()
  for (const raw of [...skills, ...technologies.flat()]) {
    const skill = canonicalSkill(raw)
    const key = keyOf(skill)
    if (key && !merged.has(key)) merged.set(key, skill)
  }
  return [...merged.values()]
}

/**
 * True when `text` mentions `skill` (any spelling of its group) as whole tokens:
 * `Java` is not in `JavaScript`, `C` is not in `C#` / `C++`.
 */
export function mentionsSkill(text: string, skill: string): boolean {
  const spellings = spellingsOf(skill) ?? [skill]
  const haystack = phraseOf(text)
  return spellings.some((spelling) => {
    const needle = phraseOf(spelling)
    return needle.trim() !== '' && haystack.includes(needle)
  })
}
