/**
 * Ambient declaration for axios's own `./unsafe/core/settle.js` subpath
 * export (present in `axios`'s `package.json` `exports` map, but shipped
 * without a `.d.ts`). Used ONLY by `axios.repro.spec.ts` — the real
 * `settle()` is how real adapters (xhr/http/fetch) turn a raw HTTP response
 * into resolve/reject, and calling it for real (via a custom test
 * `adapter`) is what makes that spec's repro exercise 100% real axios
 * internals instead of a hand-built rejection.
 */
declare module 'axios/unsafe/core/settle.js' {
  import type { AxiosResponse } from 'axios'

  export default function settle(
    resolve: (value: AxiosResponse) => void,
    reject: (reason: unknown) => void,
    response: AxiosResponse,
  ): void
}
