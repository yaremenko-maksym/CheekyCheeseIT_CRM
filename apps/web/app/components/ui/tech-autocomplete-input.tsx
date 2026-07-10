import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { TECHNOLOGIES } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface TechAutocompleteInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  /** Custom dictionary override — defaults to shared TECHNOLOGIES */
  options?: readonly string[]
  /** Max tags allowed (default 30). */
  maxItems?: number
  /** Max suggestions to show in dropdown (default 5). */
  maxSuggestions?: number
  /** Optional onBlur — used by form libraries (TanStack Form). */
  onBlur?: () => void
  /** Optional className applied to the outer container. */
  className?: string
}

const DEFAULT_MAX_ITEMS = 30
const DEFAULT_MAX_SUGGESTIONS = 5

/**
 * Reusable chip input with type-ahead suggestions for tech/skill tags.
 *
 * Behaviour:
 * - Chips render above the input, each with an X button.
 * - Suggestions are filtered case-insensitively (startsWith first, then includes),
 *   capped at `maxSuggestions`, excluding already-selected values.
 * - Tab or Enter accepts the highlighted suggestion when the dropdown is open;
 *   otherwise Enter adds the raw input as a custom tag.
 * - ArrowDown/Up navigate suggestions.
 * - Escape: ALWAYS stops propagation (prevents parent Radix Dialog from closing).
 *   Dropdown open → closes it (clears input so suggestions disappear); input
 *   non-empty → clears input; input already empty → no-op. Chips are NEVER
 *   affected by Escape.
 * - Click on a suggestion adds it.
 * - Backspace on an empty input removes the last chip (QoL — intentional).
 */
export function TechAutocompleteInput({
  value,
  onChange,
  placeholder,
  options = TECHNOLOGIES,
  maxItems = DEFAULT_MAX_ITEMS,
  maxSuggestions = DEFAULT_MAX_SUGGESTIONS,
  onBlur,
  className,
}: TechAutocompleteInputProps) {
  const [input, setInput] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [isFocused, setIsFocused] = useState(false)
  const deferredInput = useDeferredValue(input)
  const containerRef = useRef<HTMLDivElement>(null)

  const limitReached = value.length >= maxItems

  const suggestions = useMemo(() => {
    const q = deferredInput.trim().toLowerCase()
    if (!q || limitReached) return [] as string[]
    const already = new Set(value.map((v) => v.toLowerCase()))
    const starts: string[] = []
    const includes: string[] = []
    for (const tech of options) {
      const lc = tech.toLowerCase()
      if (already.has(lc)) continue
      if (lc.startsWith(q)) {
        starts.push(tech)
      } else if (lc.includes(q)) {
        includes.push(tech)
      }
      if (starts.length >= maxSuggestions) break
    }
    return [...starts, ...includes].slice(0, maxSuggestions)
  }, [deferredInput, options, value, maxSuggestions, limitReached])

  const dropdownOpen = isFocused && suggestions.length > 0

  function addTag(raw: string) {
    const tag = raw.trim()
    if (!tag) return
    if (value.length >= maxItems) return
    if (value.some((v) => v.toLowerCase() === tag.toLowerCase())) return
    onChange([...value, tag])
    setInput('')
    setActiveIdx(0)
  }

  function removeTag(tag: string) {
    onChange(value.filter((x) => x !== tag))
  }

  function commit() {
    // If a suggestion is highlighted, take it; otherwise take the raw input as custom tag.
    const highlighted = suggestions[activeIdx]
    const raw = input.trim()
    if (highlighted || raw) {
      addTag(highlighted ?? raw)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Tab' || e.key === 'Enter') {
      const highlighted = suggestions[activeIdx]
      const raw = input.trim()
      if (!highlighted && !raw) return
      e.preventDefault()
      commit()
      return
    }

    if (e.key === 'ArrowDown') {
      if (suggestions.length === 0) return
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1))
      return
    }

    if (e.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
      return
    }

    if (e.key === 'Escape') {
      // ALWAYS stop propagation: prevents Radix Dialog from intercepting Escape
      // and discarding unsaved form data (including chips added this session).
      e.preventDefault()
      e.stopPropagation()

      if (input !== '') {
        // Non-empty input: clear it. If dropdown was open, clearing input
        // removes suggestions → dropdown collapses on next render.
        setInput('')
        setActiveIdx(0)
      }
      // Empty input + dropdown closed → no-op. Chips are never touched by Escape.
      return
    }

    if (e.key === 'Backspace' && input === '' && value.length > 0) {
      // Quality-of-life: remove last chip when input is empty.
      e.preventDefault()
      const lastTag = value[value.length - 1]
      if (lastTag !== undefined) removeTag(lastTag)
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    // Only collapse the dropdown when focus leaves the entire control
    // (not when moving from input -> suggestion button).
    if (containerRef.current && containerRef.current.contains(e.relatedTarget as Node | null)) {
      return
    }
    setIsFocused(false)
    onBlur?.()
  }

  return (
    <div ref={containerRef} className={cn('space-y-3', className)} onBlur={handleBlur}>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <Badge
              key={tag}
              variant="outline"
              className="h-6 gap-1 py-0 pl-2 pr-1 text-xs font-normal"
            >
              <span className="leading-none">{tag}</span>
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="flex h-4 w-4 items-center justify-center rounded-sm transition-colors hover:bg-destructive/20 hover:text-destructive focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label={`Удалить ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="relative">
        <Input
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setActiveIdx(0)
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          placeholder={
            limitReached
              ? `Достигнут лимит ${maxItems} тегов`
              : (placeholder ?? 'Начните вводить технологию...')
          }
          disabled={limitReached}
          aria-autocomplete="list"
          aria-expanded={dropdownOpen}
          aria-controls="tech-autocomplete-listbox"
        />

        {dropdownOpen && (
          <ul
            id="tech-autocomplete-listbox"
            role="listbox"
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
          >
            {suggestions.map((suggestion, i) => {
              const isActive = i === activeIdx
              return (
                <li key={suggestion} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    // Prevent the input from losing focus before click is handled.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      addTag(suggestion)
                    }}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
                    )}
                  >
                    <span className="truncate">{suggestion}</span>
                    {isActive && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Tab / Enter
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
