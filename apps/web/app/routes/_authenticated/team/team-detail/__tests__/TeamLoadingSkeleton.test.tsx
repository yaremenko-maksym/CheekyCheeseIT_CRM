import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TeamLoadingSkeleton } from '../components/TeamLoadingSkeleton'

describe('TeamLoadingSkeleton', () => {
  it('renders the layout placeholder with no text content', () => {
    render(<TeamLoadingSkeleton />)
    const root = screen.getByTestId('team-loading-skeleton')
    expect(root.textContent).toBe('')
    expect(root).toMatchInlineSnapshot(`
      <div
        class="space-y-6 px-6 pt-4 pb-6"
        data-testid="team-loading-skeleton"
      >
        <div
          class="flex items-center gap-3"
        >
          <div
            class="animate-pulse bg-muted h-9 w-9 rounded-md"
          />
          <div
            class="space-y-1.5"
          >
            <div
              class="animate-pulse rounded-md bg-muted h-7 w-48"
            />
            <div
              class="animate-pulse rounded-md bg-muted h-4 w-32"
            />
          </div>
        </div>
        <div
          class="grid gap-6 lg:grid-cols-3"
        >
          <div
            class="lg:col-span-2 space-y-4"
          >
            <div
              class="rounded-xl border border-border p-4 space-y-3"
            >
              <div
                class="animate-pulse rounded-md bg-muted h-5 w-36"
              />
              <div
                class="grid gap-2 sm:grid-cols-2"
              >
                <div
                  class="animate-pulse bg-muted h-14 rounded-lg"
                />
                <div
                  class="animate-pulse bg-muted h-14 rounded-lg"
                />
                <div
                  class="animate-pulse bg-muted h-14 rounded-lg"
                />
                <div
                  class="animate-pulse bg-muted h-14 rounded-lg"
                />
              </div>
            </div>
          </div>
          <div
            class="space-y-4"
          >
            <div
              class="animate-pulse bg-muted h-32 rounded-xl"
            />
          </div>
        </div>
      </div>
    `)
  })
})
