/**
 * input-scan.ts — task-mobile-keyboards.md §1 static-analysis primitive.
 *
 * Walks the real TypeScript/JSX AST (via the `typescript` compiler API —
 * already a project dependency, no new package) of every `.tsx` source file
 * under a root directory and returns one `ScannedField` per `<input>` /
 * `<Input>` / `<textarea>` / `<Textarea>` JSX element it finds — the exact
 * same tag set `task-mobile-keyboards.md`'s recon counted by hand.
 *
 * This is deliberately a SOURCE scan, not a rendered-DOM scan: it mirrors
 * `apps/landing/app/__tests__/support/heading-keys.ts` (heading-punctuation
 * guard precedent) in spirit — a structural fact about the source is
 * asserted directly, no component needs to be mounted. That also means a
 * single shared component (`AmountCurrencyInput`, `PhoneInput`, …) shows up
 * as exactly ONE scanned field regardless of how many screens render it —
 * fixing that one JSX node fixes every call site's runtime DOM at once,
 * which is the whole point of "чинить сверху вниз, начиная с общих
 * компонентов" (task §"Порядок работы").
 */
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import ts from 'typescript'

const FIELD_TAGS = new Set(['input', 'Input', 'textarea', 'Textarea'])

/** Types that never take a mobile TEXT keyboard — no classification needed. */
const NON_TEXT_TYPES = new Set([
  'file',
  'checkbox',
  'radio',
  'hidden',
  'range',
  'color',
  'date',
  'time',
  'month',
  'week',
  'datetime-local',
])

export interface ScannedField {
  /** Stable identity: `data-testid` > `id` > `name` > `${file}#${n}` (nth field in the file, source order). */
  key: string
  file: string
  line: number
  tag: string
  /** True when the element is a native non-text input type (file/checkbox/…) — no keyboard concern. */
  isNonTextType: boolean
  /** True when the element is unconditionally `disabled` or `readOnly` — never focusable/editable, no keyboard concern. */
  isNeverEditable: boolean
  attrs: ScannedAttrs
}

/**
 * Extracted attribute values. Each getter returns the SET of literal values
 * the attribute's initializer could statically resolve to — a plain
 * `type="email"` yields `['email']`, a toggle like
 * `type={showPassword ? 'text' : 'password'}` yields `['text', 'password']`.
 * This is intentionally permissive (rather than requiring a single static
 * value) so conditional attributes used for legitimate UX (show/hide
 * password) aren't forced into an unnatural always-static shape.
 */
export class ScannedAttrs {
  private readonly values = new Map<string, Set<string>>()
  private readonly booleans = new Map<string, boolean>()
  private readonly present = new Set<string>()

  hasAttr(name: string): boolean {
    return this.present.has(name)
  }

  /** Literal string values reachable for this attribute (empty set if attribute absent or fully dynamic). */
  stringValues(name: string): Set<string> {
    return this.values.get(name) ?? new Set()
  }

  /** True if `name`'s reachable string values include `value`. */
  has(name: string, value: string): boolean {
    return this.stringValues(name).has(value)
  }

  /** Boolean literal for a `{false}`/`{true}`/shorthand attribute, if statically known. */
  boolValue(name: string): boolean | undefined {
    return this.booleans.get(name)
  }

  addString(name: string, value: string): void {
    this.present.add(name)
    const set = this.values.get(name) ?? new Set<string>()
    set.add(value)
    this.values.set(name, set)
  }

  addBool(name: string, value: boolean): void {
    this.present.add(name)
    this.booleans.set(name, value)
  }

  markPresentDynamic(name: string): void {
    this.present.add(name)
  }
}

/** Walks `expr`, collecting every reachable string-literal leaf (handles ternaries + parens). */
function collectStringLiterals(expr: ts.Expression, out: Set<string>): void {
  if (ts.isStringLiteralLike(expr)) {
    out.add(expr.text)
    return
  }
  if (ts.isParenthesizedExpression(expr)) {
    collectStringLiterals(expr.expression, out)
    return
  }
  if (ts.isConditionalExpression(expr)) {
    collectStringLiterals(expr.whenTrue, out)
    collectStringLiterals(expr.whenFalse, out)
    return
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    collectStringLiterals(expr.left, out)
    collectStringLiterals(expr.right, out)
  }
}

function boolLiteral(expr: ts.Expression): boolean | undefined {
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
  return undefined
}

function extractAttrs(attributes: ts.JsxAttributes): ScannedAttrs {
  const attrs = new ScannedAttrs()
  for (const prop of attributes.properties) {
    if (!ts.isJsxAttribute(prop)) continue // skip {...spread}
    const name = prop.name.getText()
    if (!prop.initializer) {
      // Boolean shorthand, e.g. `disabled` alone === `disabled={true}`.
      attrs.addBool(name, true)
      continue
    }
    if (ts.isStringLiteral(prop.initializer)) {
      attrs.addString(name, prop.initializer.text)
      continue
    }
    if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
      const inner = prop.initializer.expression
      const bool = boolLiteral(inner)
      if (bool !== undefined) {
        attrs.addBool(name, bool)
        continue
      }
      const literals = new Set<string>()
      collectStringLiterals(inner, literals)
      if (literals.size > 0) {
        for (const v of literals) attrs.addString(name, v)
      } else {
        attrs.markPresentDynamic(name)
      }
      continue
    }
    attrs.markPresentDynamic(name)
  }
  return attrs
}

function isNeverEditable(attrs: ScannedAttrs): boolean {
  // Only auto-exempt when the literal is unconditionally `true` — a
  // `disabled={someCondition}` field CAN become editable, so it still needs
  // classification (dynamic → boolValue() is undefined → not exempted).
  return attrs.boolValue('disabled') === true || attrs.boolValue('readOnly') === true
}

function isNonTextType(attrs: ScannedAttrs): boolean {
  const types = attrs.stringValues('type')
  if (types.size === 0) return false
  for (const t of types) {
    if (!NON_TEXT_TYPES.has(t)) return false
  }
  return true
}

/** Scans one source file's text and returns every `ScannedField` in source order. */
export function scanFileSource(
  sourceText: string,
  absPath: string,
  rootDir: string,
): ScannedField[] {
  const sourceFile = ts.createSourceFile(
    absPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const relPath = relative(rootDir, absPath).split('\\').join('/')
  const fields: ScannedField[] = []
  let occurrence = 0

  function visit(node: ts.Node): void {
    let tagName: string | undefined
    let attributes: ts.JsxAttributes | undefined
    let pos = node.getStart(sourceFile)

    if (ts.isJsxSelfClosingElement(node)) {
      tagName = node.tagName.getText()
      attributes = node.attributes
    } else if (ts.isJsxOpeningElement(node)) {
      tagName = node.tagName.getText()
      attributes = node.attributes
    }

    if (tagName && FIELD_TAGS.has(tagName) && attributes) {
      occurrence += 1
      const attrs = extractAttrs(attributes)
      const testid = [...attrs.stringValues('data-testid')][0]
      const id = [...attrs.stringValues('id')][0]
      const name = [...attrs.stringValues('name')][0]
      const key = testid
        ? `testid:${testid}`
        : id
          ? `${relPath}#id:${id}`
          : name
            ? `${relPath}#name:${name}`
            : `${relPath}#${occurrence}`
      const { line } = sourceFile.getLineAndCharacterOfPosition(pos)
      fields.push({
        key,
        file: relPath,
        line: line + 1,
        tag: tagName,
        isNonTextType: isNonTextType(attrs),
        isNeverEditable: isNeverEditable(attrs),
        attrs,
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return fields
}

export function scanFile(absPath: string, rootDir: string): ScannedField[] {
  return scanFileSource(readFileSync(absPath, 'utf8'), absPath, rootDir)
}
