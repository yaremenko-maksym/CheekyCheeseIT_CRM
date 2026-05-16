import { createFileRoute } from '@tanstack/react-router'
import { BookOpen } from 'lucide-react'

export const Route = createFileRoute('/crm/knowledge')({
  component: KnowledgePage,
})

function KnowledgePage() {
  return (
    <div className="">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">База знаний</h1>
        <p className="text-sm text-muted-foreground">Ресурсы, легенды и обучающие материалы</p>
      </div>
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
        <BookOpen className="h-10 w-10 text-muted-foreground/30" />
        <p className="mt-4 text-sm font-medium">База знаний</p>
        <p className="mt-1 text-xs text-muted-foreground">В разработке</p>
      </div>
    </div>
  )
}
