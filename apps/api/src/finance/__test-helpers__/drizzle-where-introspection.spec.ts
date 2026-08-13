/**
 * task-drop-sees-own-obligations, security-review PR #523 round 2 follow-up.
 *
 * `drizzle-where-introspection.ts` exists to prove a WHERE clause's own SQL
 * scope — it is itself infrastructure FOR mutation-gate closure, not
 * business logic. When it moved out of `transactions.drop-self-feeds.spec.ts`
 * into this shared, non-`.spec.ts` helper, the mutation gate started
 * mutating it as ordinary source (spec files are excluded from mutation;
 * this file, despite living under `__test-helpers__/`, is not one). The two
 * consumer specs only ever exercise it through REAL Drizzle `where` ASTs,
 * which never contain a bare `null`/`undefined` node at the point
 * `collectParamValues` is called on it — so the null/undefined guard on
 * line 40, and the array-vs-generic-object branch on line 41, were never
 * actually reached with the inputs that would distinguish them. Reviewer
 * confirmed (and this file demonstrates directly): the null/undefined guard
 * is NOT equivalent — remove it and `'value' in null` throws a TypeError
 * instead of returning `[]`, which is the walker aborting on an ordinary,
 * expected shape (many optional AST fields ARE `null`/`undefined`).
 */
import { describe, expect, it } from 'vitest'
import { collectParamValues } from './drizzle-where-introspection'

describe('collectParamValues (drizzle-where-introspection helper)', () => {
  describe('null/undefined guard (line 40) — genuinely observable, not equivalent', () => {
    it('a bare null node returns [] without throwing', () => {
      // Without the guard, execution falls through to `typeof null !==
      // 'object'` (false — typeof null IS 'object' in JS), then
      // `'value' in (null as Record<string, unknown>)` — a TypeError, not a
      // silently-wrong value. This is exactly the crash the reviewer named.
      expect(() => collectParamValues(null)).not.toThrow()
      expect(collectParamValues(null)).toEqual([])
    })

    it('a bare undefined node returns [] without throwing', () => {
      expect(() => collectParamValues(undefined)).not.toThrow()
      expect(collectParamValues(undefined)).toEqual([])
    })

    it('a null VALUE nested inside an object tree does not abort the walk — sibling Params are still found', () => {
      // This is the realistic shape: a Drizzle AST node with an optional
      // field that is `null` (e.g. an unset operand), sitting next to a
      // real bound Param. The walker must skip the null branch and keep
      // going, not throw and lose everything collected so far.
      const tree = {
        left: null,
        right: { value: 'bound-1', encoder: 'text' },
      }
      expect(collectParamValues(tree)).toEqual(['bound-1'])
    })

    it('an undefined VALUE nested inside an object tree is likewise skipped, not thrown on', () => {
      const tree = {
        optionalOperand: undefined,
        param: { value: 42, encoder: 'int' },
      }
      expect(collectParamValues(tree)).toEqual([42])
    })

    it('null and undefined mixed into an ARRAY of nodes are both skipped without throwing', () => {
      const nodes = [null, undefined, { value: 'a', encoder: 'e' }, { value: 'b', encoder: 'e' }]
      expect(collectParamValues(nodes)).toEqual(['a', 'b'])
    })
  })

  describe('array branch (line 41) — arrays are walked element-by-element, not treated as a single Param', () => {
    it('collects params from a plain array of Param-shaped nodes, in order', () => {
      const arr = [
        { value: 'first', encoder: 'e' },
        { value: 'second', encoder: 'e' },
      ]
      expect(collectParamValues(arr)).toEqual(['first', 'second'])
    })

    it('an array is never mistaken for a single Param node even if it happens to carry value/encoder properties', () => {
      // Arrays are objects, so `'value' in obj && 'encoder' in obj` COULD
      // match one if the branch that dispatches on Array.isArray were gone
      // — the fallback generic-object path checks that condition BEFORE
      // ever reaching `Object.values`. This never happens with a real
      // Drizzle AST array, but the walker's contract is "arrays are always
      // walked as element collections", and this proves that holds even in
      // the adversarial case where an array literal happens to carry those
      // exact two keys as extra own properties.
      const arr = Object.assign([{ value: 'elem', encoder: 'e' }], {
        value: 'should-be-ignored',
        encoder: 'should-be-ignored',
      })
      expect(collectParamValues(arr)).toEqual(['elem'])
    })
  })

  describe('baseline shapes (documented in the helper itself, pinned here too)', () => {
    it('a primitive (non-object, non-array) node returns []', () => {
      expect(collectParamValues('just a string')).toEqual([])
      expect(collectParamValues(42)).toEqual([])
      expect(collectParamValues(true)).toEqual([])
    })

    it('a Param-shaped node ({ value, encoder }) returns its value, not recursing into it', () => {
      expect(collectParamValues({ value: 'bound', encoder: 'text' })).toEqual(['bound'])
    })

    it('a circular object reference does not infinite-loop (visited-set guard)', () => {
      // A Param-shaped node returns early and never recurses into its own
      // properties, so self-reference there is safe regardless — the
      // visited-set guard is exercised by a NON-Param circular object:
      const node: Record<string, unknown> = {}
      node.self = node
      expect(() => collectParamValues(node)).not.toThrow()
      expect(collectParamValues(node)).toEqual([])
    })
  })
})
