import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CreateTransactionDialog } from '@/routes/crm/finance/components/dialogs/CreateTransactionDialog'

export function DropQuickActions() {
  const [showCreate, setShowCreate] = useState(false)

  return (
    <>
      <div className="col-span-full flex flex-col sm:flex-row gap-3" aria-label="Быстрые действия">
        {/* Register income — sole quick action. «Платить компании» removed (UT):
            it only navigated to /crm/finance and read as an action, not a shortcut.
            Real payment is per-income via the finance cabinet / action-required list. */}
        <Button
          variant="outline"
          className="flex items-center gap-2 sm:flex-none"
          onClick={() => setShowCreate(true)}
          data-testid="drop-register-income-btn"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Зарегистрировать приход
        </Button>
      </div>

      <CreateTransactionDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  )
}
