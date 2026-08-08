/**
 * Test helper: run an async call that MUST reject, and hand back the thrown
 * value so the caller can assert on it at the top level of the test.
 *
 * Replaces the `try { await x(); expect.fail(...) } catch (e) { expect(e)… }`
 * shape (task-lint-teeth). Two things were wrong with that shape:
 *
 *  1. Every assertion about the error sat inside `catch`, so it only ran when
 *     something threw. `vitest/no-conditional-expect` flags exactly this: if
 *     the call under test stops throwing, the assertions are skipped rather
 *     than failed.
 *  2. `expect.fail()` throws — into the SAME `catch`. So the "it didn't throw"
 *     guard was itself swallowed, and whether the test then failed depended on
 *     the next line happening to blow up on an AssertionError (e.g. calling
 *     `.getResponse()` on it). Several call sites had no such line and failed
 *     only by luck.
 *
 * Here the "did not reject" case throws an ordinary Error from the fulfilled
 * branch, which no caller catches, so it always fails the test loudly; and the
 * error assertions run unconditionally in the test body.
 *
 * @example
 * const err = await captureRejection(() => guard.canActivate(ctx))
 * expect(err).toBeInstanceOf(ForbiddenException)
 */
export async function captureRejection(
  run: () => Promise<unknown>,
  what = 'the call under test',
): Promise<unknown> {
  return run().then(
    (value) => {
      throw new Error(
        `Expected ${what} to reject, but it resolved with: ${safeDescribe(value)}. ` +
          'If this is now the correct behaviour, assert on the resolved value instead ' +
          'of using captureRejection.',
      )
    },
    (error: unknown) => error,
  )
}

function safeDescribe(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}
