import { createFileRoute } from '@tanstack/react-router'
import { motion, AnimatePresence } from 'framer-motion'
import { useState, useEffect } from 'react'
import { ArrowUpRight, Brain, ShoppingCart, GraduationCap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/brand-mark'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/')({
  component: LandingPage,
})

// ─── Data ─────────────────────────────────────────────────────────────────────

type LineType = 'import' | 'code' | 'string' | 'comment' | 'blank'

interface CodeLine {
  text: string
  type: LineType
}

interface Snippet {
  domain: string
  color: string
  ext: string
  lines: CodeLine[]
}

const snippets: Snippet[] = [
  {
    domain: 'AI / ML',
    color: '#a78bfa',
    ext: 'py',
    lines: [
      { text: 'from cheeky import LLMPipeline', type: 'import' },
      { text: '', type: 'blank' },
      { text: 'model = LLMPipeline.load(', type: 'code' },
      { text: '  checkpoint="cheese-7b-v2",', type: 'string' },
      { text: '  device="cuda", quantize=True,', type: 'code' },
      { text: ')', type: 'code' },
      { text: '', type: 'blank' },
      { text: '# 94.2% accuracy · 40B token dataset', type: 'comment' },
    ],
  },
  {
    domain: 'EdTech',
    color: '#34d399',
    ext: 'ts',
    lines: [
      { text: 'const lesson = await ai.generate({', type: 'code' },
      { text: "  topic: 'React Server Components',", type: 'string' },
      { text: "  level: 'intermediate',", type: 'string' },
      { text: '  includeExercises: true,', type: 'code' },
      { text: '})', type: 'code' },
      { text: '', type: 'blank' },
      { text: 'await platform.publish(lesson)', type: 'code' },
      { text: '// 50 000+ active learners', type: 'comment' },
    ],
  },
  {
    domain: 'E-Commerce',
    color: '#fb923c',
    ext: 'ts',
    lines: [
      { text: 'const order = await checkout.process({', type: 'code' },
      { text: '  cart: userCart,', type: 'code' },
      { text: '  payment: stripe.createIntent(cart),', type: 'code' },
      { text: '  shipping: dhl.estimate(address),', type: 'code' },
      { text: '  analytics: track(session),', type: 'code' },
      { text: '})', type: 'code' },
      { text: '', type: 'blank' },
      { text: '// $2M+ GMV · 99.97% uptime', type: 'comment' },
    ],
  },
]

const services = [
  {
    Icon: Brain,
    label: 'AI / ML',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
    desc: 'LLM integrations, custom model fine-tuning, RAG pipelines, and AI-powered product features — shipped to production.',
  },
  {
    Icon: GraduationCap,
    label: 'EdTech',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    desc: 'Interactive learning platforms, adaptive curricula, real-time collaboration tools, and progress analytics.',
  },
  {
    Icon: ShoppingCart,
    label: 'E-Commerce',
    color: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
    desc: 'High-performance storefronts, payment integrations, inventory management, and conversion-optimised checkout flows.',
  },
]

const stats = [
  { value: '40+', label: 'Projects delivered' },
  { value: '15+', label: 'Happy clients' },
  { value: '3+', label: 'Years on market' },
  { value: '20+', label: 'Engineers' },
]

const stack = [
  'TypeScript',
  'React',
  'Next.js',
  'Node.js',
  'Python',
  'FastAPI',
  'PostgreSQL',
  'Redis',
  'Docker',
  'Kubernetes',
  'AWS',
  'GCP',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lineColor(type: LineType): string {
  switch (type) {
    case 'comment':
      return '#6e7681'
    case 'import':
      return '#ff7b72'
    case 'string':
      return '#a5d6ff'
    default:
      return '#e6edf3'
  }
}

// ─── Terminal ─────────────────────────────────────────────────────────────────

function Terminal() {
  const [snippetIdx, setSnippetIdx] = useState(0)
  const [lineIdx, setLineIdx] = useState(0)
  const [charIdx, setCharIdx] = useState(0)
  const [visible, setVisible] = useState(true)

  const snippet = snippets[snippetIdx]!

  // Typewriter: advance one character per tick, then one line, then cycle snippet
  useEffect(() => {
    const lines = snippets[snippetIdx]!.lines
    const currentLine = lines[lineIdx]
    if (!currentLine) return

    if (charIdx < currentLine.text.length) {
      const t = setTimeout(() => setCharIdx((c) => c + 1), 28)
      return () => clearTimeout(t)
    }

    if (lineIdx < lines.length - 1) {
      const delay = currentLine.type === 'blank' ? 60 : 160
      const t = setTimeout(() => {
        setLineIdx((l) => l + 1)
        setCharIdx(0)
      }, delay)
      return () => clearTimeout(t)
    }

    // All lines done — pause then fade out
    const t = setTimeout(() => setVisible(false), 2400)
    return () => clearTimeout(t)
  }, [snippetIdx, lineIdx, charIdx])

  // After fade-out, advance to next snippet
  useEffect(() => {
    if (visible) return
    const t = setTimeout(() => {
      setSnippetIdx((i) => (i + 1) % snippets.length)
      setLineIdx(0)
      setCharIdx(0)
      setVisible(true)
    }, 380)
    return () => clearTimeout(t)
  }, [visible])

  const lines = snippet.lines
  const displayedLines = lines
    .slice(0, Math.min(lineIdx + 1, lines.length))
    .map((l, i) => ({
      ...l,
      text: i < lineIdx ? l.text : l.text.slice(0, charIdx),
    }))

  return (
    <div className="relative w-full max-w-lg">
      {/* Ambient glow */}
      <div
        className="absolute -inset-6 rounded-2xl blur-[70px] transition-colors duration-700"
        style={{ background: `${snippet.color}18` }}
      />

      {/* macOS-style window chrome */}
      <div className="relative flex items-center gap-1.5 rounded-t-xl border border-b-0 border-white/10 bg-[#161b22] px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <AnimatePresence mode="wait">
          <motion.span
            key={snippetIdx}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="ml-4 font-mono text-xs text-white/35"
          >
            {snippet.domain.toLowerCase().replace(' / ', '_')}_project.{snippet.ext}
          </motion.span>
        </AnimatePresence>
      </div>

      {/* Code body */}
      <div className="relative min-h-[224px] rounded-b-xl border border-white/10 bg-[#0d1117] p-5 font-mono text-sm leading-6">
        <AnimatePresence mode="wait">
          {visible && (
            <motion.div
              key={snippetIdx}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              {displayedLines.map((line, i) => (
                <div key={i}>
                  {line.type === 'blank' ? (
                    <span>&nbsp;</span>
                  ) : (
                    <span style={{ color: lineColor(line.type) }}>{line.text}</span>
                  )}
                  {i === displayedLines.length - 1 && (
                    <motion.span
                      animate={{ opacity: [1, 0] }}
                      transition={{ repeat: Infinity, duration: 0.75, ease: 'linear' }}
                      className="ml-px inline-block w-[7px] rounded-sm align-middle"
                      style={{ height: '0.85em', background: `${snippet.color}cc` }}
                    />
                  )}
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Domain badge */}
      <AnimatePresence mode="wait">
        <motion.div
          key={snippetIdx}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          className="absolute -bottom-5 right-0"
        >
          <span
            className="rounded-full border px-3 py-1 text-xs font-medium"
            style={{
              color: snippet.color,
              borderColor: `${snippet.color}40`,
              background: `${snippet.color}12`,
            }}
          >
            {snippet.domain}
          </span>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ── Nav ───────────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 border-b border-border/40 bg-background/80 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandMark className="h-8 w-8 text-primary" />
            <span className="font-semibold tracking-tight">CheekyCheeseIT</span>
          </div>

          <div className="hidden items-center gap-8 text-sm text-muted-foreground sm:flex">
            {['Services', 'Stack', 'Careers'].map((label) => (
              <a
                key={label}
                href={`#${label.toLowerCase()}`}
                className="transition-colors hover:text-foreground"
              >
                {label}
              </a>
            ))}
          </div>

          <Button size="sm" variant="outline" asChild>
            <a href="mailto:contact@cheekycheeseit.com">
              Contact Us <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </nav>

      {/* ── Hero ──────────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-6 pb-28 pt-24 lg:pt-32">
        <div className="pointer-events-none absolute left-[15%] top-0 h-[550px] w-[600px] -translate-y-1/2 rounded-full bg-primary/10 blur-[130px]" />
        <div className="pointer-events-none absolute bottom-0 right-[5%] h-[400px] w-[400px] rounded-full bg-violet-500/8 blur-[110px]" />

        <div className="relative mx-auto grid max-w-7xl items-center gap-16 lg:grid-cols-2">
          {/* Left: copy */}
          <motion.div
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.65, ease: [0.25, 0.1, 0.25, 1] as const }}
          >
            <Badge variant="outline" className="mb-6 border-primary/30 text-primary">
              Outsource · Outstaffing
            </Badge>

            <h1 className="mb-6 text-5xl font-bold leading-[1.1] tracking-tight sm:text-6xl lg:text-7xl">
              We build{' '}
              <span className="text-primary">products</span>
              <br />
              that scale
            </h1>

            <p className="mb-10 max-w-lg text-lg leading-relaxed text-muted-foreground">
              AI, EdTech, E-Commerce — full-cycle development with senior engineers who care about
              your product as much as you do.
            </p>

            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <a href="mailto:contact@cheekycheeseit.com">
                  Start a project <ArrowUpRight />
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#services">Our services</a>
              </Button>
            </div>
          </motion.div>

          {/* Right: animated terminal */}
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.65, delay: 0.15, ease: [0.25, 0.1, 0.25, 1] as const }}
            className="flex justify-center lg:justify-end"
          >
            <Terminal />
          </motion.div>
        </div>
      </section>

      {/* ── Stats ─────────────────────────────────────────────────────────────── */}
      <section className="border-y border-border/40 px-6 py-14">
        <div className="mx-auto grid max-w-3xl grid-cols-2 gap-10 sm:grid-cols-4">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08, duration: 0.45 }}
              className="text-center"
            >
              <p className="text-3xl font-bold">{s.value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{s.label}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── Services ──────────────────────────────────────────────────────────── */}
      <section id="services" className="px-6 py-24">
        <div className="mx-auto max-w-7xl">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-14 text-center"
          >
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">What we build</h2>
            <p className="mt-3 text-muted-foreground">
              Three domains. Senior-led teams. Production-first mindset.
            </p>
          </motion.div>

          <div className="grid gap-6 sm:grid-cols-3">
            {services.map((svc, i) => (
              <motion.div
                key={svc.label}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.5 }}
                className={cn('group rounded-2xl border p-8 transition-all duration-300 hover:bg-white/2', svc.border)}
              >
                <div
                  className={cn('mb-5 flex h-12 w-12 items-center justify-center rounded-xl', svc.bg)}
                >
                  <svc.Icon className={cn('h-6 w-6', svc.color)} />
                </div>
                <h3 className="mb-3 text-xl font-semibold">{svc.label}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{svc.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Stack ─────────────────────────────────────────────────────────────── */}
      <section id="stack" className="border-y border-border/40 bg-white/[0.01] px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="mb-10 text-center text-xs uppercase tracking-widest text-muted-foreground/70"
          >
            Our tech stack
          </motion.p>
          <div className="flex flex-wrap justify-center gap-3">
            {stack.map((tech, i) => (
              <motion.span
                key={tech}
                initial={{ opacity: 0, scale: 0.88 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.035, duration: 0.35 }}
                className="cursor-default rounded-full border border-border/60 bg-card/50 px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {tech}
              </motion.span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Careers ───────────────────────────────────────────────────────────── */}
      <section id="careers" className="relative overflow-hidden px-6 py-32">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[500px] w-[800px] rounded-full bg-primary/8 blur-[130px]" />
        </div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.55 }}
          className="relative mx-auto max-w-2xl text-center"
        >
          <Badge variant="outline" className="mb-6 border-primary/30 text-primary">
            We're hiring
          </Badge>
          <h2 className="mb-5 text-4xl font-bold tracking-tight sm:text-5xl">Join the team</h2>
          <p className="mb-10 text-lg leading-relaxed text-muted-foreground">
            We work on interesting problems for product companies worldwide. Remote-first,
            async-friendly, no corporate bureaucracy — just clean code and shipped features.
          </p>
          <Button size="lg" asChild>
            <a href="mailto:careers@cheekycheeseit.com">
              See open roles <ArrowUpRight />
            </a>
          </Button>
        </motion.div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border/40 px-6 py-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <BrandMark variant="flat" className="h-6 w-6 text-primary" />
            <span>© 2026 CheekyCheeseIT. All rights reserved.</span>
          </div>
          <span>AI · EdTech · E-Commerce</span>
        </div>
      </footer>
    </div>
  )
}
