/**
 * Where `apps/api/src/assets/**` lives at runtime.
 *
 * The same file has two homes depending on how the process was started:
 *   - `dist/assets/...` under `node dist/main` (production), because
 *     `nest-cli.json` copies the tree there;
 *   - `src/assets/...` under Vitest / `tsx`, where nothing is copied.
 *
 * This was open-coded inside `loadFontBuffer`, and the Typst renderer needs
 * exactly the same resolution for the template and the font DIRECTORY. Two
 * copies of a two-path rule is one copy too many: whoever adds the next asset
 * kind would copy it a third time, and the day `nest-cli.json` changes, only
 * one of them gets fixed.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Absolute path of an asset, preferring the production location.
 *
 * `relativeToAssets` is a path INSIDE `assets/` (`'fonts/Roboto-Bold.ttf'`,
 * `'typst'`). Works for directories as well as files — `existsSync` does not
 * care which, and the Typst renderer passes a directory as `--font-path`.
 *
 * Falls back to the source path when neither exists, so a genuinely missing
 * asset fails at the point of use with a path in the message, rather than here
 * with a less useful one.
 */
export function resolveAssetPath(relativeToAssets: string): string {
  // `__dirname` is `dist/common` in production and `src/common` in tests.
  const distPath = resolve(__dirname, '..', 'assets', relativeToAssets)
  if (existsSync(distPath)) return distPath
  return resolve(__dirname, '..', '..', 'src', 'assets', relativeToAssets)
}
