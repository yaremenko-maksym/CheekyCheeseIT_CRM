import '@testing-library/jest-dom'
import { beforeAll, afterAll } from 'vitest'

// Suppress act() warnings for userEvent interactions
const originalError = console.error
beforeAll(() => {
  console.error = (...args) => {
    if (
      typeof args[0] === 'string' && 
      args[0].includes('Warning: An update to') && 
      args[0].includes('inside a test was not wrapped in act')
    ) {
      return
    }
    return originalError.call(console, ...args)
  }
})

afterAll(() => {
  console.error = originalError
})
