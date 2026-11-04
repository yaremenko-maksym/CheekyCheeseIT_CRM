import { describe, expect, it } from 'vitest'
import { parseGeminiModelId } from './model-id'

describe('parseGeminiModelId (ADR §3.4 Gemini family pattern)', () => {
  it.each([
    ['gemini-2.5-flash', '2.5', 'flash'],
    ['gemini-3-flash-preview', '3', 'flash'],
    ['gemini-2.5-flash-lite', '2.5', 'flash-lite'],
    ['gemini-2.5-pro', '2.5', 'pro'],
    ['gemini-12.34-pro', '12.34', 'pro'],
    ['gemini-2.5-flash-preview-09-2025', '2.5', 'flash'],
  ])('admits %s', (id, version, variant) => {
    expect(parseGeminiModelId(id)).toEqual({ id, version, variant })
  })

  it('strips the models/ prefix', () => {
    expect(parseGeminiModelId('models/gemini-2.5-flash')).toEqual({
      id: 'gemini-2.5-flash',
      version: '2.5',
      variant: 'flash',
    })
  })

  it.each([
    'gemini-2.5-flash-001', // revision suffix
    'gemini-flash-latest', // alias
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-preview-9-2025',
    'gemini-2.5-flash-preview-09-25',
    'gemini-2.5-flash-preview-09',
    'gemini-2.-flash',
    'gemini-.5-flash',
    'gemini-2.5.1-flash',
    'gemini-2.5-ultra',
    'xgemini-2.5-flash',
    ' gemini-2.5-flash',
    'gemini-2.5-flash\n',
    'models/models/gemini-2.5-flash',
    'Models/gemini-2.5-flash',
    'gemma-4-e4b',
    'gemini-2.5-flash-preview-09-2025x',
    '',
  ])('refuses %j', (id) => {
    expect(parseGeminiModelId(id)).toBeNull()
  })
})
