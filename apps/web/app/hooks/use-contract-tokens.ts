import { useMemo, useState, useEffect } from 'react'
import type { CustomVariable } from '@crm/shared'
import { CONTRACT_VARIABLE_DESCRIPTIONS } from '@crm/shared'

const TOKEN_REGEX = /\{\{([a-zA-Z0-9_]+)\}\}/g

export interface ContractTokensResult {
  /** All token keys found in body text */
  tokensInText: Set<string>
  /** System variable keys used in body */
  systemUsed: Set<string>
  /** Custom variable keys registered but NOT in body */
  orphanedCustom: string[]
  /** Token keys in body that are neither system nor registered custom */
  unknownInText: string[]
}

function parseTokens(body: string): Set<string> {
  const found = new Set<string>()
  let match: RegExpExecArray | null
  const re = new RegExp(TOKEN_REGEX.source, 'g')
  while ((match = re.exec(body)) !== null) {
    const key = match[1]
    if (key) found.add(key)
  }
  return found
}

/**
 * Debounced analysis of contract template body tokens.
 * Returns which tokens are in text, which system vars are used,
 * which custom vars are orphaned (registered but absent from text),
 * and which tokens are unknown (in text but not registered anywhere).
 */
export function useContractTokens(
  body: string,
  customVars: CustomVariable[],
  debounceMs = 300,
): ContractTokensResult {
  const [debouncedBody, setDebouncedBody] = useState(body)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedBody(body), debounceMs)
    return () => clearTimeout(id)
  }, [body, debounceMs])

  return useMemo<ContractTokensResult>(() => {
    const systemKeys = new Set(Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS))
    const customKeys = new Set(customVars.map((v) => v.key))
    const tokensInText = parseTokens(debouncedBody)

    const systemUsed = new Set<string>()
    for (const key of tokensInText) {
      if (systemKeys.has(key)) systemUsed.add(key)
    }

    const orphanedCustom: string[] = []
    for (const key of customKeys) {
      if (!tokensInText.has(key)) orphanedCustom.push(key)
    }

    const unknownInText: string[] = []
    for (const key of tokensInText) {
      if (!systemKeys.has(key) && !customKeys.has(key)) {
        unknownInText.push(key)
      }
    }

    return { tokensInText, systemUsed, orphanedCustom, unknownInText }
  }, [debouncedBody, customVars])
}
