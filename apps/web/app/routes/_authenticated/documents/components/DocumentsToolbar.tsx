import { Search, X } from 'lucide-react'
import { List, LayoutGrid } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { DocumentCategory, UserProfileDto } from '@crm/shared'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CATEGORY_LABEL_MESSAGES } from '@/components/documents/document-labels'
import { SORT_OPTION_MESSAGES, type SortKey } from '@/lib/documents-filter-sort'
import type { CategoryFilter, DocumentView } from '../types'

export interface DocumentsToolbarProps {
  searchInput: string
  onSearchInputChange: (value: string) => void
  onClearSearch: () => void
  showOwnerFilter: boolean
  ownerFilter: string
  onOwnerFilterChange: (value: string) => void
  users: UserProfileDto[] | undefined
  categoryFilter: CategoryFilter
  onCategoryFilterChange: (value: CategoryFilter) => void
  availableCategories: DocumentCategory[]
  sortKey: SortKey
  onSortKeyChange: (value: SortKey) => void
  view: DocumentView
  onViewChange: (value: DocumentView) => void
}

export function DocumentsToolbar({
  searchInput,
  onSearchInputChange,
  onClearSearch,
  showOwnerFilter,
  ownerFilter,
  onOwnerFilterChange,
  users,
  categoryFilter,
  onCategoryFilterChange,
  availableCategories,
  sortKey,
  onSortKeyChange,
  view,
  onViewChange,
}: DocumentsToolbarProps) {
  const { t, i18n } = useLingui()
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 pt-4 pb-4">
        {/* Search */}
        <div className="relative flex-1 min-w-50">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            enterKeyHint="search"
            placeholder={t`Пошук за назвою…`}
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
            className={searchInput ? 'pl-8 pr-8' : 'pl-8'}
            data-testid="documents-search"
          />
          {searchInput ? (
            <button
              type="button"
              onClick={onClearSearch}
              aria-label={t`Очистити пошук`}
              className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        {/* Owner filter — ADMIN/HR only */}
        {showOwnerFilter ? (
          <Select value={ownerFilter} onValueChange={onOwnerFilterChange}>
            <SelectTrigger className="w-44" data-testid="documents-owner-filter">
              <SelectValue placeholder={t`Усі власники`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">
                <Trans>Усі власники</Trans>
              </SelectItem>
              {(users ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.displayName} ({u.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {/* Category filter */}
        <Select
          value={categoryFilter}
          onValueChange={(v) => onCategoryFilterChange(v as CategoryFilter)}
        >
          <SelectTrigger className="w-44" data-testid="documents-category-filter">
            <SelectValue placeholder={t`Усі категорії`} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">
              <Trans>Усі категорії</Trans>
            </SelectItem>
            {availableCategories.map((cat) => (
              <SelectItem key={cat} value={cat}>
                {i18n._(CATEGORY_LABEL_MESSAGES[cat])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="hidden h-6 w-px bg-border sm:block" aria-hidden />

        {/* Sort */}
        <Select value={sortKey} onValueChange={(v) => onSortKeyChange(v as SortKey)}>
          <SelectTrigger className="w-52" data-testid="documents-sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTION_MESSAGES.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {i18n._(opt.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* View toggle — list / grid */}
        <div
          className="ml-auto flex items-center gap-1 rounded-md border border-border p-0.5"
          data-testid="documents-view-toggle"
        >
          <button
            type="button"
            aria-label={t`Список`}
            aria-pressed={view === 'list'}
            data-testid="documents-view-list"
            onClick={() => onViewChange('list')}
            className={`flex h-7 w-7 items-center justify-center rounded transition ${
              view === 'list'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <List className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t`Сітка`}
            aria-pressed={view === 'grid'}
            data-testid="documents-view-grid"
            onClick={() => onViewChange('grid')}
            className={`flex h-7 w-7 items-center justify-center rounded transition ${
              view === 'grid'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>
      </CardContent>
    </Card>
  )
}
