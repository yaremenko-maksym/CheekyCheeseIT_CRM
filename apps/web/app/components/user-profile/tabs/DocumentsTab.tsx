import { FileText, Upload } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function DocumentsTab() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Документы</CardTitle>
        <Button size="sm" variant="outline" disabled>
          <Upload className="mr-2 h-4 w-4" />
          Загрузить
        </Button>
      </CardHeader>
      <CardContent>
        <div className="rounded border border-dashed py-8 text-center text-sm text-muted-foreground">
          <FileText className="mx-auto mb-2 h-8 w-8 opacity-40" />
          Документы появятся здесь (Phase 6)
        </div>
      </CardContent>
    </Card>
  )
}
