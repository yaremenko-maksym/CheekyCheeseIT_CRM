import { defineConfig } from 'vitest/config'

/**
 * Business-day / date specs run THREE times: once under the host TZ (the
 * `default` project, as before), then pinned to Europe/Kyiv and
 * America/Los_Angeles. CI runs in UTC, where a host-timezone bug is invisible —
 * that is how the finance date defects shipped. `env.TZ` is set on the forked
 * worker process, so it applies to `Date` and `Intl` for the whole file.
 */
const DATE_SPECS = ['src/utils/kyiv-day.spec.ts', 'src/i18n/format.spec.ts']

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'default', include: ['src/**/*.{spec,test}.ts'] },
      },
      ...['Europe/Kyiv', 'America/Los_Angeles'].map((tz) => ({
        extends: true as const,
        test: { name: `tz:${tz}`, include: DATE_SPECS, env: { TZ: tz } },
      })),
    ],
  },
})
