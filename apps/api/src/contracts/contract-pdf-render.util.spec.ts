import { describe, it, expect, beforeEach } from 'vitest'
import type { Color, PDFDocument, PDFFont, PDFPage } from 'pdf-lib'

import {
  BODY_SIZE,
  drawCellLine,
  drawTwoColRow,
  ensureSpace,
  parseInlineBold,
  renderParagraph,
  renderParagraphWithBreaks,
  renderTableBlock,
  wrapCellLines,
  type Cursor,
  type TextDrawer,
} from './contract-pdf-render.util'

// Hand-computed geometry (A4: 595.28 x 841.89, margin 50, content 495.28).
const PAGE_W = 595.28
const PAGE_H = 841.89
const TOP_Y = PAGE_H - 50 // 791.89
const LEFT_X = 50
const RIGHT_X = 50 + (495.28 - 16) / 2 + 16 // 305.64
const LH = 11 * 1.3 // 14.3

interface FakePage {
  id: number
}
interface Drawn {
  page: number
  text: string
  x: number
  y: number
  font: string
  size: number
  color: unknown
}

const REGULAR = { name: 'regular', widthOfTextAtSize: (t: string, s: number) => t.length * s * 0.5 }
const BOLD = { name: 'bold', widthOfTextAtSize: (t: string, s: number) => t.length * s * 0.6 }
const regularFont = REGULAR as unknown as PDFFont
const boldFont = BOLD as unknown as PDFFont
const TEXT = { c: 'text' } as unknown as Color
const MUTED = { c: 'muted' } as unknown as Color

let drawn: Drawn[]
let addPageArgs: unknown[]
let pageCount: number
let pdfGen: TextDrawer
let doc: PDFDocument

function newPage(): FakePage {
  return { id: pageCount++ }
}

beforeEach(() => {
  drawn = []
  addPageArgs = []
  pageCount = 0
  pdfGen = {
    drawText: (page: unknown, text: string, o: Record<string, unknown>) => {
      drawn.push({
        page: (page as FakePage).id,
        text,
        x: o.x as number,
        y: o.y as number,
        font: (o.font as { name: string }).name,
        size: o.size as number,
        color: o.color,
      })
    },
  } as unknown as TextDrawer
  doc = {
    addPage: (size: unknown) => {
      addPageArgs.push(size)
      return newPage() as unknown as PDFPage
    },
  } as unknown as PDFDocument
})

function makeCursor(y: number): Cursor {
  return { page: newPage() as unknown as PDFPage, y }
}
const pageId = (c: Cursor) => (c.page as unknown as FakePage).id
const texts = () => drawn.map((d) => d.text)

describe('parseInlineBold', () => {
  it('splits on ** into alternating regular/bold runs', () => {
    expect(parseInlineBold('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ])
  })

  it('strips backticks', () => {
    expect(parseInlineBold('`[X]` y')).toEqual([{ text: '[X] y', bold: false }])
  })

  it('returns a single empty run for empty or marker-only input', () => {
    expect(parseInlineBold('')).toEqual([{ text: '', bold: false }])
    expect(parseInlineBold('****')).toEqual([{ text: '', bold: false }])
  })

  it('bold segment at the start is bold', () => {
    expect(parseInlineBold('**a**b')).toEqual([
      { text: 'a', bold: true },
      { text: 'b', bold: false },
    ])
  })
})

describe('ensureSpace', () => {
  it('keeps the page when exactly at the bottom limit (120)', () => {
    const c = makeCursor(200)
    const page = c.page
    ensureSpace(doc, c, 80)
    expect(c.page).toBe(page)
    expect(c.y).toBe(200)
    expect(addPageArgs).toHaveLength(0)
  })

  it('starts a new A4 page at the top margin when below the limit', () => {
    const c = makeCursor(200)
    const page = c.page
    ensureSpace(doc, c, 81)
    expect(c.page).not.toBe(page)
    expect(c.y).toBeCloseTo(TOP_Y, 6)
    expect(addPageArgs).toEqual([[PAGE_W, PAGE_H]])
  })
})

describe('wrapCellLines', () => {
  const wrap = (t: string, header: boolean, w: number) =>
    wrapCellLines(t, header, w, regularFont, boldFont)

  it('keeps short text on one line as per-token runs', () => {
    expect(wrap('aa bb', false, 500)).toEqual([
      [
        { text: 'aa', bold: false },
        { text: ' ', bold: false },
        { text: 'bb', bold: false },
      ],
    ])
  })

  it('wraps when the next token overflows; boundary equality still fits', () => {
    // 'aa'=11, ' '=5.5 -> 16.5 == colWidth stays; 'bb' overflows.
    expect(wrap('aa bb', false, 16.5)).toEqual([
      [
        { text: 'aa', bold: false },
        { text: ' ', bold: false },
      ],
      [{ text: 'bb', bold: false }],
    ])
  })

  it('a token exactly as wide as the column fits on its own line', () => {
    expect(wrap('aaa', false, 16.5)).toEqual([[{ text: 'aaa', bold: false }]])
  })

  it('drops whitespace that overflows and leading whitespace', () => {
    expect(wrap('aaa   b', false, 22)).toEqual([
      [{ text: 'aaa', bold: false }],
      [{ text: 'b', bold: false }],
    ])
    expect(wrap('  x', false, 100)).toEqual([[{ text: 'x', bold: false }]])
  })

  it('hard-breaks a token wider than the column char by char', () => {
    expect(wrap('abcdefgh', false, 16.5)).toEqual([
      [{ text: 'abc', bold: false }],
      [{ text: 'def', bold: false }],
      [{ text: 'gh', bold: false }],
    ])
  })

  it('flushes the current line before a hard-broken token and continues after the tail', () => {
    expect(wrap('xx abcdefgh', false, 16.5)).toEqual([
      [
        { text: 'xx', bold: false },
        { text: ' ', bold: false },
      ],
      [{ text: 'abc', bold: false }],
      [{ text: 'def', bold: false }],
      [{ text: 'gh', bold: false }],
    ])
    // The tail 'gh' (11 wide) keeps counting: ' '(5.5) fits at 16.5, 'zz' overflows.
    expect(wrap('abcdefgh zz', false, 16.5)).toEqual([
      [{ text: 'abc', bold: false }],
      [{ text: 'def', bold: false }],
      [
        { text: 'gh', bold: false },
        { text: ' ', bold: false },
      ],
      [{ text: 'zz', bold: false }],
    ])
  })

  it('uses bold widths and flags for **bold** runs and for header cells', () => {
    // bold 'abcd' = 4*6.6 = 26.4 > 19.8 -> broken into 3-char chunks.
    expect(wrap('**abcd**', false, 19.8)).toEqual([
      [{ text: 'abc', bold: true }],
      [{ text: 'd', bold: true }],
    ])
    // header forces bold font widths but run.bold stays false.
    expect(wrap('abcd', true, 19.8)).toEqual([
      [{ text: 'abc', bold: false }],
      [{ text: 'd', bold: false }],
    ])
  })

  it('header/bold widths differ from regular: width 22 fits regular "abcd" but not bold', () => {
    expect(wrap('abcd', false, 22)).toEqual([[{ text: 'abcd', bold: false }]])
    expect(wrap('abcd', true, 22)).toEqual([
      [{ text: 'abc', bold: false }],
      [{ text: 'd', bold: false }],
    ])
    expect(wrap('**abcd**', false, 22)).toEqual([
      [{ text: 'abc', bold: true }],
      [{ text: 'd', bold: true }],
    ])
  })

  it('a column narrower than one character still emits one char per line (no empty line)', () => {
    expect(wrap('abc', false, 3)).toEqual([
      [{ text: 'a', bold: false }],
      [{ text: 'b', bold: false }],
      [{ text: 'c', bold: false }],
    ])
  })

  it('keeps consecutive whitespace as a single token', () => {
    expect(wrap('a  b', false, 500)).toEqual([
      [
        { text: 'a', bold: false },
        { text: '  ', bold: false },
        { text: 'b', bold: false },
      ],
    ])
  })

  it('does not flush a zero-width line before a hard-broken token', () => {
    const zw = {
      name: 'zw',
      widthOfTextAtSize: (t: string, s: number) => (t === 'Z' ? 0 : t.length * s * 0.5),
    } as unknown as PDFFont
    expect(wrapCellLines('Z abcdefgh', false, 16.5, zw, zw)).toEqual([
      [{ text: 'abc', bold: false }],
      [{ text: 'def', bold: false }],
      [
        { text: 'Z', bold: false },
        { text: 'gh', bold: false },
      ],
    ])
  })

  it('represents an empty cell as one empty line', () => {
    expect(wrap('', false, 100)).toEqual([[{ text: '', bold: false }]])
  })
})

describe('drawCellLine', () => {
  const opts = { regularFont, boldFont, textColor: TEXT, mutedColor: MUTED }

  it('draws runs left-to-right advancing x by each run width, skipping empty runs', () => {
    const page = newPage() as unknown as PDFPage
    drawCellLine(
      pdfGen,
      { page, y: 700 },
      [
        { text: 'ab', bold: false },
        { text: '', bold: false },
        { text: 'cd', bold: true },
      ],
      50,
      false,
      opts,
    )
    expect(drawn).toEqual([
      { page: 0, text: 'ab', x: 50, y: 700, font: 'regular', size: 11, color: TEXT },
      { page: 0, text: 'cd', x: 61, y: 700, font: 'bold', size: 11, color: TEXT },
    ])
  })

  it('header lines use the bold font for every run', () => {
    const page = newPage() as unknown as PDFPage
    drawCellLine(pdfGen, { page, y: 10 }, [{ text: 'ab', bold: false }], 7, true, opts)
    expect(drawn).toEqual([
      { page: 0, text: 'ab', x: 7, y: 10, font: 'bold', size: 11, color: TEXT },
    ])
  })
})

describe('drawTwoColRow', () => {
  const opts = { regularFont, boldFont, textColor: TEXT, mutedColor: MUTED }
  const line = (t: string) => [{ text: t, bold: false }]

  it('draws both columns top-aligned and advances by the taller cell', () => {
    const c = makeCursor(700)
    drawTwoColRow(pdfGen, doc, c, [line('l1'), line('l2')], [line('r1')], false, opts)
    expect(drawn.map((d) => [d.text, d.x, d.y])).toEqual([
      ['l1', LEFT_X, 700],
      ['l2', LEFT_X, 700 - LH],
      ['r1', RIGHT_X, 700],
    ])
    expect(c.y).toBeCloseTo(700 - 2 * LH, 6)
    expect(addPageArgs).toHaveLength(0)
  })

  it('advances by the right cell when it is taller', () => {
    const c = makeCursor(700)
    drawTwoColRow(pdfGen, doc, c, [line('l1')], [line('r1'), line('r2'), line('r3')], false, opts)
    expect(c.y).toBeCloseTo(700 - 3 * LH, 6)
    expect(drawn.map((d) => [d.text, d.y])).toEqual([
      ['l1', 700],
      ['r1', 700],
      ['r2', 700 - LH],
      ['r3', 700 - 2 * LH],
    ])
  })
})

describe('renderParagraph', () => {
  const base = {
    size: 10,
    forceBold: false,
    indent: 0,
    regularFont,
    boldFont,
    color: TEXT,
    leftX: 50,
    rightEdge: 85,
  }

  it('word-wraps (width 5/char), drops overflowing whitespace, advances y', () => {
    const c = makeCursor(700)
    renderParagraph(pdfGen, doc, c, [{ text: 'aaa bbb ccc', bold: false }], base)
    expect(drawn.map((d) => [d.text, d.x, d.y, d.size, d.color])).toEqual([
      ['aaa', 50, 700, 10, TEXT],
      [' ', 65, 700, 10, TEXT],
      ['bbb', 70, 700, 10, TEXT],
      ['ccc', 50, 687, 10, TEXT],
    ])
    expect(c.y).toBe(674)
  })

  it('draws consecutive whitespace as one token and handles empty runs', () => {
    renderParagraph(
      pdfGen,
      doc,
      makeCursor(700),
      [
        { text: 'a  b', bold: false },
        { text: '', bold: false },
      ],
      { ...base, rightEdge: 500 },
    )
    expect(texts()).toEqual(['a', '  ', 'b'])
  })

  it('applies indent to the start x and wrap origin', () => {
    const c = makeCursor(700)
    renderParagraph(pdfGen, doc, c, [{ text: 'aaa bbb', bold: false }], {
      ...base,
      indent: 14,
      rightEdge: 100,
    })
    // start 64: aaa 64..79, ' ' 79..84, bbb 84+15=99 <= 100
    expect(drawn.map((d) => [d.text, d.x])).toEqual([
      ['aaa', 64],
      [' ', 79],
      ['bbb', 84],
    ])
  })

  it('draws an over-wide token at the line start without wrapping', () => {
    const c = makeCursor(700)
    renderParagraph(pdfGen, doc, c, [{ text: 'wwwwwwwwwwwwww', bold: false }], base)
    expect(drawn.map((d) => [d.text, d.x, d.y])).toEqual([['wwwwwwwwwwwwww', 50, 700]])
    expect(c.y).toBe(687)
  })

  it('uses bold font for bold runs and when forceBold is set', () => {
    renderParagraph(
      pdfGen,
      doc,
      makeCursor(700),
      [
        { text: 'a', bold: false },
        { text: 'b', bold: true },
      ],
      base,
    )
    expect(drawn.map((d) => d.font)).toEqual(['regular', 'bold'])
    drawn = []
    renderParagraph(pdfGen, doc, makeCursor(700), [{ text: 'a', bold: false }], {
      ...base,
      forceBold: true,
    })
    expect(drawn.map((d) => d.font)).toEqual(['bold'])
  })

  it('breaks to a new page before drawing when no room for one line', () => {
    const c = makeCursor(125)
    renderParagraph(pdfGen, doc, c, [{ text: 'a', bold: false }], base)
    expect(drawn[0]!.y).toBeCloseTo(TOP_Y, 6)
    expect(drawn[0]!.page).toBe(pageId(c))
    expect(c.y).toBeCloseTo(TOP_Y - 13, 6)
  })

  it('breaks to a new page when a wrapped line would fall below the limit', () => {
    const c = makeCursor(135)
    renderParagraph(pdfGen, doc, c, [{ text: 'aaa bbb ccc', bold: false }], base)
    expect(drawn.map((d) => [d.text, d.y])).toEqual([
      ['aaa', 135],
      [' ', 135],
      ['bbb', 135],
      ['ccc', expect.closeTo(TOP_Y, 6)],
    ])
    expect(drawn[3]!.page).toBe(pageId(c))
    expect(drawn[0]!.page).not.toBe(pageId(c))
    expect(c.y).toBeCloseTo(TOP_Y - 13, 6)
  })
})

describe('renderParagraphWithBreaks', () => {
  const base = {
    size: 10,
    forceBold: false,
    regularFont,
    boldFont,
    color: TEXT,
    leftX: 50,
    rightEdge: 545,
  }

  it('renders each <br> / <BR/> segment as its own paragraph (indent 0)', () => {
    const c = makeCursor(700)
    renderParagraphWithBreaks(pdfGen, doc, c, 'a<br>b<BR/>c', base)
    expect(drawn.map((d) => [d.text, d.x, d.y])).toEqual([
      ['a', 50, 700],
      ['b', 50, 687],
      ['c', 50, 674],
    ])
    expect(c.y).toBe(661)
  })

  it('a line without <br> renders once and parses **bold**', () => {
    const c = makeCursor(700)
    renderParagraphWithBreaks(pdfGen, doc, c, 'x **y**', base)
    expect(drawn.map((d) => [d.text, d.font])).toEqual([
      ['x', 'regular'],
      [' ', 'regular'],
      ['y', 'bold'],
    ])
    expect(c.y).toBe(687)
  })
})

describe('renderTableBlock', () => {
  const opts = { regularFont, boldFont, textColor: TEXT, mutedColor: MUTED }
  const run = (rows: string[], y = 700) => {
    const c = makeCursor(y)
    renderTableBlock(pdfGen, doc, c, rows, opts)
    return c
  }

  it('bold header, skipped separator, regular data row at both column x', () => {
    const c = run(['| Українська | English |', '| --- | :---: |', '| ab | cd |'])
    expect(drawn.map((d) => [d.text, d.x, d.y, d.font])).toEqual([
      ['Українська', LEFT_X, 700, 'bold'],
      ['English', RIGHT_X, 700, 'bold'],
      ['ab', LEFT_X, expect.closeTo(700 - LH, 6), 'regular'],
      ['cd', RIGHT_X, expect.closeTo(700 - LH, 6), 'regular'],
    ])
    expect(c.y).toBeCloseTo(700 - 2 * LH, 6)
  })

  it('unescapes \\| inside cells and ignores outer empty cells', () => {
    run(['| a\\|b | c |'])
    expect(texts()).toEqual(['a|b', 'c'])
  })

  it('does not treat non-separator dashes as separators', () => {
    run(['| H | H |', '| -- | x |', '| --- | x |', '| x--- | x--- |', '| ---x | ---x |'])
    expect(texts()).toEqual(['H', 'H', '--', 'x', '---', 'x', 'x---', 'x---', '---x', '---x'])
  })

  it('an empty row is a (blank) paragraph, not a separator, and consumes the header slot', () => {
    const c = run(['| |', '| a | b |'])
    expect(drawn.map((d) => [d.text, d.font])).toEqual([
      ['a', 'regular'],
      ['b', 'regular'],
    ])
    expect(c.y).toBeCloseTo(700 - 2 * LH, 6)
  })

  it('restores every escaped pipe and keeps interior empty cells (3 cells -> fallback)', () => {
    run(['| H | H |', '| a\\|b\\|c | d |', '| a | | b |'])
    expect(texts()).toEqual(['H', 'H', 'a|b|c', 'd', 'a', ' ', '|', '  ', '|', ' ', 'b'])
  })

  it('rows without outer pipes keep their edge cells', () => {
    run(['H | H', 'a | b'])
    expect(drawn.map((d) => [d.text, d.x])).toEqual([
      ['H', LEFT_X],
      ['H', RIGHT_X],
      ['a', LEFT_X],
      ['b', RIGHT_X],
    ])
  })

  it('non-2-column first row is a bold paragraph; later ones are not, and header is consumed', () => {
    const c = run(['| solo |', '| a | b |', '| one | two | three |'])
    expect(drawn.map((d) => [d.text, d.x, d.font])).toEqual([
      ['solo', 50, 'bold'],
      ['a', LEFT_X, 'regular'],
      ['b', RIGHT_X, 'regular'],
      ['one', 50, 'regular'],
      [' ', 50 + 16.5, 'regular'],
      ['|', 50 + 16.5 + 5.5, 'regular'],
      [' ', 50 + 16.5 + 5.5 + 5.5, 'regular'],
      ['two', 50 + 16.5 + 5.5 + 5.5 + 5.5, 'regular'],
      [' ', 50 + 16.5 + 5.5 + 5.5 + 5.5 + 16.5, 'regular'],
      ['|', 50 + 16.5 + 5.5 + 5.5 + 5.5 + 16.5 + 5.5, 'regular'],
      [' ', 50 + 16.5 + 5.5 + 5.5 + 5.5 + 16.5 + 5.5 + 5.5, 'regular'],
      ['three', 50 + 16.5 + 5.5 + 5.5 + 5.5 + 16.5 + 5.5 + 5.5 + 5.5, 'regular'],
    ])
    expect(c.y).toBeCloseTo(700 - 3 * LH, 6)
  })

  it('a single-column row wider than the page width wraps within the content width', () => {
    // 'x' * 120 is one token: 120 * 5.5 = 660 > content width 495.28, drawn at 50 (no infinite wrap)
    run(['| ' + 'x'.repeat(120) + ' |'])
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.x).toBe(50)
  })

  it('row height is the taller of the two cells', () => {
    // header row first (bold); the data row's right cell is 44 chars -> 2 regular lines (43/line)
    const c = run(['| H | H |', '| a | ' + 'y'.repeat(44) + ' |'])
    expect(c.y).toBeCloseTo(700 - 3 * LH, 6)
    expect(drawn.filter((d) => d.x === LEFT_X).map((d) => d.text)).toEqual(['H', 'a'])
    expect(drawn.filter((d) => d.x === RIGHT_X).map((d) => d.text)).toEqual([
      'H',
      'y'.repeat(43),
      'y',
    ])
  })

  it('fitting row (plenty of room) stays on the page', () => {
    const c = makeCursor(135)
    const page = c.page
    renderTableBlock(pdfGen, doc, c, ['| a | b |'], opts)
    expect(c.page).toBe(page)
    expect(drawn.map((d) => d.y)).toEqual([135, 135])
    expect(addPageArgs).toHaveLength(0)
  })

  it('a row that exactly fits the remaining space stays on the page', () => {
    // header cell of 73 bold chars = 3 lines (36/line) = 42.9; 162.9 - 120 === 42.9
    const c = run(['| ' + 'H'.repeat(73) + ' | H |'], 162.9)
    expect(addPageArgs).toHaveLength(0)
    expect(drawn[0]!.y).toBe(162.9)
    expect(c.y).toBeCloseTo(162.9 - 3 * LH, 6)
  })

  it('a multi-line row that does not fit moves wholly to a new page', () => {
    // 2 lines = 28.6 > 140 - 120; the first line alone would fit, but the row must not split
    const c = run(['| ' + 'H'.repeat(37) + ' | H |'], 140)
    expect(addPageArgs).toHaveLength(1)
    expect(drawn.every((d) => d.page === pageId(c))).toBe(true)
    expect(drawn.map((d) => d.y)).toEqual([
      expect.closeTo(TOP_Y, 6),
      expect.closeTo(TOP_Y - LH, 6),
      expect.closeTo(TOP_Y, 6),
    ])
  })

  it('moves a non-fitting row to a new page and draws it at the top', () => {
    const c = makeCursor(130)
    renderTableBlock(pdfGen, doc, c, ['| a | b |'], opts)
    expect(addPageArgs).toEqual([[PAGE_W, PAGE_H]])
    expect(drawn.map((d) => [d.text, d.page, d.y])).toEqual([
      ['a', pageId(c), expect.closeTo(TOP_Y, 6)],
      ['b', pageId(c), expect.closeTo(TOP_Y, 6)],
    ])
    expect(c.y).toBeCloseTo(TOP_Y - LH, 6)
  })

  it('a row taller than a full page is drawn line-by-line across pages', () => {
    // 47 lines * 14.3 = 672.1 > 671.89 (page content height) -> line-by-line path.
    const c = makeCursor(700)
    renderTableBlock(pdfGen, doc, c, ['| H | H |', '| ' + 'z'.repeat(43 * 47) + ' | r |'], opts)
    const left = drawn.filter((d) => d.x === LEFT_X && d.text !== 'H')
    const right = drawn.filter((d) => d.x === RIGHT_X && d.text !== 'H')
    const y0 = 700 - LH
    expect(left).toHaveLength(47)
    expect(right.map((d) => [d.text, d.y])).toEqual([['r', expect.closeTo(y0, 6)]])
    expect(left.filter((d) => d.page === left[0]!.page)).toHaveLength(39)
    expect(left[0]!.y).toBeCloseTo(y0, 6)
    expect(left[1]!.y).toBeCloseTo(y0 - LH, 6)
    expect(left[39]!.y).toBeCloseTo(TOP_Y, 6)
    expect(left[39]!.page).not.toBe(left[0]!.page)
    expect(addPageArgs).toHaveLength(1)
    expect(c.y).toBeCloseTo(TOP_Y - 8 * LH, 6)
    expect(pageId(c)).toBe(left[46]!.page)
  })

  it('tall row with a short left cell draws only the existing left lines', () => {
    const c = makeCursor(700)
    renderTableBlock(pdfGen, doc, c, ['| H | H |', '| a | ' + 'z'.repeat(43 * 47) + ' |'], opts)
    expect(drawn.filter((d) => d.x === LEFT_X).map((d) => d.text)).toEqual(['H', 'a'])
    expect(drawn.filter((d) => d.x === RIGHT_X)).toHaveLength(48)
  })

  it('exposes BODY_SIZE 11', () => {
    expect(BODY_SIZE).toBe(11)
  })
})
