import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useContractTokens } from './use-contract-tokens'
import type { CustomVariable } from '@crm/shared'

// Use fake timers to control debounce
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const CUSTOM_VARS: CustomVariable[] = [
  { key: 'contractCity', label: 'Місто підписання' },
  { key: 'witnessName', label: 'ПІБ свідка' },
]

describe('useContractTokens', () => {
  it('returns empty sets for empty body', () => {
    const { result } = renderHook(() => useContractTokens('', [], 300))

    act(() => vi.advanceTimersByTime(300))

    expect(result.current.tokensInText.size).toBe(0)
    expect(result.current.systemUsed.size).toBe(0)
    expect(result.current.orphanedCustom).toEqual([])
    expect(result.current.unknownInText).toEqual([])
  })

  it('detects system variable tokens in body', () => {
    const body = 'Привіт {{employeeName}}, ваш email: {{employeeEmail}}.'
    const { result } = renderHook(() => useContractTokens(body, [], 300))

    act(() => vi.advanceTimersByTime(300))

    expect(result.current.tokensInText.has('employeeName')).toBe(true)
    expect(result.current.tokensInText.has('employeeEmail')).toBe(true)
    expect(result.current.systemUsed.has('employeeName')).toBe(true)
    expect(result.current.systemUsed.has('employeeEmail')).toBe(true)
  })

  it('custom variable present in body — isUsed, not orphaned', () => {
    const body = 'Місто: {{contractCity}}, контракт №1.'
    const { result } = renderHook(() => useContractTokens(body, CUSTOM_VARS, 300))

    act(() => vi.advanceTimersByTime(300))

    expect(result.current.tokensInText.has('contractCity')).toBe(true)
    expect(result.current.orphanedCustom).not.toContain('contractCity')
    // witnessName is registered but not in body → orphaned
    expect(result.current.orphanedCustom).toContain('witnessName')
  })

  it('custom variable registered but absent from body → orphaned', () => {
    const body = 'No custom tokens here.'
    const { result } = renderHook(() => useContractTokens(body, CUSTOM_VARS, 300))

    act(() => vi.advanceTimersByTime(300))

    expect(result.current.orphanedCustom).toContain('contractCity')
    expect(result.current.orphanedCustom).toContain('witnessName')
  })

  it('unknown token in body (not system, not custom) → unknownInText', () => {
    const body = '{{unknownVar}} is not registered anywhere.'
    const { result } = renderHook(() => useContractTokens(body, [], 300))

    act(() => vi.advanceTimersByTime(300))

    expect(result.current.unknownInText).toContain('unknownVar')
    expect(result.current.systemUsed.has('unknownVar')).toBe(false)
  })

  it('known system token is not unknown', () => {
    const body = '{{salary}} and {{unknownToken}}'
    const { result } = renderHook(() => useContractTokens(body, [], 300))

    act(() => vi.advanceTimersByTime(300))

    expect(result.current.unknownInText).not.toContain('salary')
    expect(result.current.unknownInText).toContain('unknownToken')
  })

  it('debounces body changes — result not updated until delay elapsed', () => {
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useContractTokens(body, [], 300),
      { initialProps: { body: '' } },
    )

    // Initial state after first render (no timer advance yet)
    expect(result.current.tokensInText.size).toBe(0)

    // Update body but don't advance timers
    rerender({ body: '{{employeeName}}' })
    expect(result.current.tokensInText.size).toBe(0)

    // Advance past debounce
    act(() => vi.advanceTimersByTime(300))
    expect(result.current.tokensInText.has('employeeName')).toBe(true)
  })

  it('handles multiple identical tokens in body (deduped in set)', () => {
    const body = '{{salary}} and {{salary}} again {{salary}}'
    const { result } = renderHook(() => useContractTokens(body, [], 300))

    act(() => vi.advanceTimersByTime(300))

    // Set deduplicates
    expect(result.current.tokensInText.has('salary')).toBe(true)
    expect(result.current.tokensInText.size).toBe(1)
  })

  it('custom variable key same as unknown → registered custom not in unknownInText', () => {
    const body = '{{contractCity}} hello'
    const { result } = renderHook(() => useContractTokens(body, CUSTOM_VARS, 300))

    act(() => vi.advanceTimersByTime(300))

    expect(result.current.unknownInText).not.toContain('contractCity')
  })
})
