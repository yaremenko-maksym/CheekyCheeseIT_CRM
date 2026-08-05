/**
 * input-scan.ts — task-mobile-keyboards.md §1 static-analysis primitive.
 *
 * See `apps/web/app/__tests__/support/input-scan.ts` module doc for the full
 * rationale — this is the same scanner, duplicated (not imported) because
 * `apps/web` and `apps/landing` are separate workspace packages with their
 * own `node_modules`/tsconfig, matching the existing `__tests__/support/`
 * per-app convention (`heading-keys.ts` isn't shared either).
 */
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import ts from 'typescript'

const FIELD_TAGS = new Set(['input', 'Input', 'textarea', 'Textarea'])

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
  key: string
  file: string
  line: number
  tag: string
  isNonTextType: boolean
  isNeverEditable: boolean
  attrs: ScannedAttrs
}

export class ScannedAttrs {
  private readonly values = new Map<string, Set<string>>()
  private readonly booleans = new Map<string, boolean>()
  private readonly present = new Set<string>()

  hasAttr(name: string): boolean {
    return this.present.has(name)
  }

  stringValues(name: string): Set<string> {
    return this.values.get(name) ?? new Set()
  }

  has(name: string, value: string): boolean {
    return this.stringValues(name).has(value)
  }

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

interface CollectedLiterals {
  strings: Set<string>
  booleans: Set<boolean>
}

function collectLiterals(expr: ts.Expression, out: CollectedLiterals): void {
  if (ts.isStringLiteralLike(expr)) {
    out.strings.add(expr.text)
    return
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    out.booleans.add(true)
    return
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    out.booleans.add(false)
    return
  }
  if (ts.isParenthesizedExpression(expr)) {
    collectLiterals(expr.expression, out)
    return
  }
  if (ts.isConditionalExpression(expr)) {
    collectLiterals(expr.whenTrue, out)
    collectLiterals(expr.whenFalse, out)
    return
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    collectLiterals(expr.left, out)
    collectLiterals(expr.right, out)
  }
}

function extractAttrs(attributes: ts.JsxAttributes): ScannedAttrs {
  const attrs = new ScannedAttrs()
  for (const prop of attributes.properties) {
    if (!ts.isJsxAttribute(prop)) continue
    const name = prop.name.getText()
    if (!prop.initializer) {
      attrs.addBool(name, true)
      continue
    }
    if (ts.isStringLiteral(prop.initializer)) {
      attrs.addString(name, prop.initializer.text)
      continue
    }
    if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
      const inner = prop.initializer.expression
      const found: CollectedLiterals = { strings: new Set(), booleans: new Set() }
      collectLiterals(inner, found)
      if (found.strings.size === 0 && found.booleans.size === 0) {
        attrs.markPresentDynamic(name)
      } else {
        for (const v of found.strings) attrs.addString(name, v)
        for (const v of found.booleans) attrs.addBool(name, v)
      }
      continue
    }
    attrs.markPresentDynamic(name)
  }
  return attrs
}

function isNeverEditable(attrs: ScannedAttrs): boolean {
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

export function scanFileSource(sourceText: string, absPath: string, rootDir: string): ScannedField[] {
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
    const pos = node.getStart(sourceFile)

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
