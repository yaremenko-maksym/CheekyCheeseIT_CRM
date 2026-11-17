import type { Reply } from './router-harness'

/** A synthetic account id: 32 lower-case hex characters, no real account. */
export const CLOUDFLARE_ACCOUNT = '0123456789abcdef0123456789abcdef'

type PriceItem = { unit: string; price: unknown; currency: string }

export type CloudflareEntryOptions = {
  task?: string | undefined
  /** The `context_window` property value; `undefined` leaves the property out. */
  context?: string | undefined
  /** `[input, output]` USD per million tokens; `undefined` leaves the `price` property out. */
  price?: readonly [number, number] | undefined
  /** A raw `price` value, in place of `price`. */
  priceList?: PriceItem[]
  currency?: string
  /** The `planned_deprecation_date` property value; absent unless given. */
  deprecation?: string
  /** `undefined` leaves the whole `properties` array out. */
  properties?: undefined
}

/**
 * One catalogue entry in the shape Cloudflare's docs pipeline stores (facts file 2026-11-17):
 * `name` is the model id, `properties` a list of `{ property_id, value }`. Synthetic values only.
 */
export function cloudflareEntry(id: string, o: CloudflareEntryOptions = {}): object {
  const has = (k: keyof CloudflareEntryOptions): boolean => k in o
  const currency = o.currency ?? 'USD'
  const [input, output] = o.price ?? [0.2, 0.3]
  const price: PriceItem[] = o.priceList ?? [
    { unit: 'per M input tokens', price: input, currency },
    { unit: 'per M output tokens', price: output, currency },
  ]
  const properties = [
    ...(has('context') && o.context === undefined
      ? []
      : [{ property_id: 'context_window', value: o.context ?? '128000' }]),
    ...(has('price') && o.price === undefined ? [] : [{ property_id: 'price', value: price }]),
    ...(o.deprecation === undefined
      ? []
      : [{ property_id: 'planned_deprecation_date', value: o.deprecation }]),
    { property_id: 'function_calling', value: 'true' },
  ]
  const task =
    has('task') && o.task === undefined ? {} : { task: { name: o.task ?? 'Text Generation' } }
  return {
    id: '00000000-0000-4000-8000-000000000000',
    name: id,
    description: 'synthetic',
    ...task,
    ...(has('properties') ? {} : { properties }),
  }
}

/** One page of the models search in the v4 envelope. */
export const cloudflarePage = (entries: unknown[]): Reply => ({
  status: 200,
  body: JSON.stringify({ success: true, errors: [], messages: [], result: entries }),
})
