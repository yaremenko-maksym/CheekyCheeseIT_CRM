import { createFileRoute } from '@tanstack/react-router'
import { FileText } from 'lucide-react'

export const Route = createFileRoute('/crm/documents')({
  component: DocumentsPage,
})

function DocumentsPage() {
  return (
    <div className="">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Документы</h1>
        <p className="text-sm text-muted-foreground">Резюме, договора и сканы</p>
      </div>
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
        <FileText className="h-10 w-10 text-muted-foreground/30" />
        <p className="mt-4 text-sm font-medium">Хранилище документов</p>
        <p className="mt-1 text-xs text-muted-foreground">В разработке</p>
      </div>
    </div>
  )
}
