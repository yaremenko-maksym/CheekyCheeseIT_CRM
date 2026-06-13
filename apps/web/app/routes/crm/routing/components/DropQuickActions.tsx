import { ArrowUpRight, Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { CreateTransactionDialog } from '@/routes/crm/finance/components/dialogs/CreateTransactionDialog'

export function DropQuickActions() {
  const [showCreate, setShowCreate] = useState(false)
  const navigate = useNavigate()

  return (
    <>
      <div className="col-span-full flex flex-col sm:flex-row gap-3" aria-label="Быстрые действия">
        {/* Register income */}
        <Button
          variant="outline"
          className="flex items-center gap-2 sm:flex-none"
          onClick={() => setShowCreate(true)}
          data-testid="drop-quick-register-btn"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Зарегистрировать приход
        </Button>

        {/* Pay company */}
        <Button
          variant="default"
          className="flex items-center gap-2 sm:flex-none"
          data-testid="drop-quick-pay-btn"
          onClick={() => void navigate({ to: '/crm/finance' })}
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          Платить компании
        </Button>
      </div>

      <CreateTransactionDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  )
}
