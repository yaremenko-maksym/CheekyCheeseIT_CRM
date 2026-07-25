/**
 * title-morph.ts — shared-element title morph capture/consume state machine
 * (docs/design/landing-redesign.md §M v3.2), `/careers ↔ /careers/:slug`
 * only. `framer-motion`'s `animate()` is mocked (same technique as the
 * removed `scrim-transition.spec.ts`) so `playTitleMorphOverlay` can be
 * asserted deterministically. `getBoundingClientRect`/`getComputedStyle` are
 * stubbed per-element since happy-dom has no real layout engine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeControls {
  then: Promise<void>['then']
  resolve: () => void
}

function makeFakeControls(): FakeControls {
  let resolveFn!: () => void
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve
  })
  return { then: promise.then.bind(promise), resolve: () => resolveFn() }
}

let controlsQueue: FakeControls[] = []
let animateCalls: unknown[][] = []
const animateMock = vi.fn((...args: unknown[]) => {
  animateCalls.push(args)
  const controls = makeFakeControls()
  controlsQueue.push(controls)
  return controls
})
vi.mock('framer-motion', () => ({
  animate: (...args: unknown[]) => animateMock(...args),
}))

async function freshModule() {
  vi.resetModules()
  controlsQueue = []
  animateCalls = []
  animateMock.mockClear()
  return import('@/lib/title-morph')
}

/** Stubs `getBoundingClientRect` + `getComputedStyle` for `el` (single-line by default: rect.height <= lineHeightPx*1.3). */
function stubMeasurements(
  el: HTMLElement,
  {
    height = 20,
    left = 10,
    top = 20,
    fontSize = '16px',
    lineHeight = '24px',
  }: { height?: number; left?: number; top?: number; fontSize?: string; lineHeight?: string } = {},
) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    height,
    left,
    top,
    width: 100,
    right: left + 100,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect)
  const originalGetComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((target: Element) => {
    if (target === el) {
      return { fontSize, lineHeight } as CSSStyleDeclaration
    }
    return originalGetComputedStyle(target)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('isMorphRoutePair', () => {
  it('list -> detail is eligible', async () => {
    const { isMorphRoutePair } = await freshModule()
    expect(isMorphRoutePair('/careers', '/careers/senior-ml-engineer')).toBe(true)
    expect(isMorphRoutePair('/careers/', '/careers/senior-ml-engineer/')).toBe(true)
  })

  it('detail -> list is eligible', async () => {
    const { isMorphRoutePair } = await freshModule()
    expect(isMorphRoutePair('/careers/senior-ml-engineer', '/careers')).toBe(true)
    expect(isMorphRoutePair('/careers/senior-ml-engineer/', '/careers/')).toBe(true)
  })

  it('list -> list is NOT eligible', async () => {
    const { isMorphRoutePair } = await freshModule()
    expect(isMorphRoutePair('/careers', '/careers/')).toBe(false)
  })

  it('detail -> detail (different slugs) is NOT eligible', async () => {
    const { isMorphRoutePair } = await freshModule()
    expect(isMorphRoutePair('/careers/a', '/careers/b')).toBe(false)
  })

  it('Home teaser -> detail is NOT eligible', async () => {
    const { isMorphRoutePair } = await freshModule()
    expect(isMorphRoutePair('/', '/careers/senior-ml-engineer')).toBe(false)
  })

  it('detail -> nav-logo home is NOT eligible', async () => {
    const { isMorphRoutePair } = await freshModule()
    expect(isMorphRoutePair('/careers/senior-ml-engineer', '/')).toBe(false)
  })
})

describe('captureMorphSource + readPendingMorph', () => {
  it('no capture ever happened -> readPendingMorph returns null', async () => {
    const { readPendingMorph, setPendingRoutePair } = await freshModule()
    setPendingRoutePair('/careers', '/careers/senior-ml-engineer')
    expect(readPendingMorph()).toBeNull()
  })

  it('captured but no route pair was ever cached -> readPendingMorph returns null', async () => {
    const { captureMorphSource, readPendingMorph } = await freshModule()
    const el = document.createElement('h3')
    el.textContent = 'Senior ML Engineer'
    stubMeasurements(el)
    captureMorphSource(el, 'senior-ml-engineer')
    expect(readPendingMorph()).toBeNull()
  })

  it('captured + an INELIGIBLE route pair was cached -> readPendingMorph returns null', async () => {
    const { captureMorphSource, readPendingMorph, setPendingRoutePair } = await freshModule()
    const el = document.createElement('h3')
    el.textContent = 'Senior ML Engineer'
    stubMeasurements(el)
    captureMorphSource(el, 'senior-ml-engineer')
    setPendingRoutePair('/', '/careers/senior-ml-engineer')
    expect(readPendingMorph()).toBeNull()
  })

  it('captured + an eligible route pair -> readPendingMorph returns the captured morph, one-shot', async () => {
    const { captureMorphSource, readPendingMorph, setPendingRoutePair } = await freshModule()
    const el = document.createElement('h3')
    el.textContent = 'Senior ML Engineer'
    stubMeasurements(el, {
      height: 20,
      left: 12,
      top: 34,
      fontSize: '19.52px',
      lineHeight: '29.28px',
    })
    captureMorphSource(el, 'senior-ml-engineer')
    setPendingRoutePair('/careers', '/careers/senior-ml-engineer')

    const morph = readPendingMorph()
    expect(morph).not.toBeNull()
    expect(morph?.slug).toBe('senior-ml-engineer')
    expect(morph?.text).toBe('Senior ML Engineer')
    expect(morph?.fontSizePx).toBeCloseTo(19.52)
    expect(morph?.rect.left).toBe(12)
    expect(morph?.rect.top).toBe(34)

    // One-shot — a second read (as if a second, unrelated consumer ran) gets nothing.
    expect(readPendingMorph()).toBeNull()
  })

  it('reduced-motion -> capture is skipped entirely (fallback table row 3)', async () => {
    const { captureMorphSource, readPendingMorph, setPendingRoutePair } = await freshModule()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    const el = document.createElement('h3')
    el.textContent = 'Senior ML Engineer'
    stubMeasurements(el)
    captureMorphSource(el, 'senior-ml-engineer')
    setPendingRoutePair('/careers', '/careers/senior-ml-engineer')
    expect(readPendingMorph()).toBeNull()
  })

  it('a 2+ line source title -> capture is skipped (fallback table row 4)', async () => {
    const { captureMorphSource, readPendingMorph, setPendingRoutePair } = await freshModule()
    const el = document.createElement('h3')
    el.textContent = 'A Very Long Wrapping Vacancy Title'
    // height (48px) > lineHeightPx (24px) * 1.3 (31.2px) -> wrapped to 2 lines.
    stubMeasurements(el, { height: 48, lineHeight: '24px' })
    captureMorphSource(el, 'a-very-long-wrapping-vacancy-title')
    setPendingRoutePair('/careers', '/careers/a-very-long-wrapping-vacancy-title')
    expect(readPendingMorph()).toBeNull()
  })
})

describe('validateMorphDestination', () => {
  async function capturedMorph() {
    const { captureMorphSource, readPendingMorph, setPendingRoutePair } = await freshModule()
    const source = document.createElement('h3')
    source.textContent = 'Senior ML Engineer'
    stubMeasurements(source)
    captureMorphSource(source, 'senior-ml-engineer')
    setPendingRoutePair('/careers', '/careers/senior-ml-engineer')
    const morph = readPendingMorph()
    if (!morph) throw new Error('expected a captured morph')
    return {
      morph,
      validateMorphDestination: (await import('@/lib/title-morph')).validateMorphDestination,
    }
  }

  it('slug mismatch -> false', async () => {
    const { morph, validateMorphDestination } = await capturedMorph()
    const dest = document.createElement('h1')
    dest.textContent = 'Senior ML Engineer'
    stubMeasurements(dest)
    expect(validateMorphDestination(morph, 'backend-engineer', dest)).toBe(false)
  })

  it('staleness — destination text no longer matches captured text -> false', async () => {
    const { morph, validateMorphDestination } = await capturedMorph()
    const dest = document.createElement('h1')
    dest.textContent = 'Senior ML Engineer (Updated)'
    stubMeasurements(dest)
    expect(validateMorphDestination(morph, 'senior-ml-engineer', dest)).toBe(false)
  })

  it('destination wrapped to 2+ lines -> false', async () => {
    const { morph, validateMorphDestination } = await capturedMorph()
    const dest = document.createElement('h1')
    dest.textContent = 'Senior ML Engineer'
    stubMeasurements(dest, { height: 80, lineHeight: '24px' })
    expect(validateMorphDestination(morph, 'senior-ml-engineer', dest)).toBe(false)
  })

  it('slug + text match, single line -> true', async () => {
    const { morph, validateMorphDestination } = await capturedMorph()
    const dest = document.createElement('h1')
    dest.textContent = 'Senior ML Engineer'
    stubMeasurements(dest)
    expect(validateMorphDestination(morph, 'senior-ml-engineer', dest)).toBe(true)
  })
})

describe('findMorphTargetElement', () => {
  it('finds the element whose data-vacancy-morph-slug matches', async () => {
    const { findMorphTargetElement } = await freshModule()
    const cardA = document.createElement('h3')
    cardA.dataset['vacancyMorphSlug'] = 'role-a'
    const cardB = document.createElement('h3')
    cardB.dataset['vacancyMorphSlug'] = 'role-b'
    document.body.append(cardA, cardB)

    expect(findMorphTargetElement('role-b')).toBe(cardB)
  })

  it('returns null when no element matches (vacancy disappeared from the list)', async () => {
    const { findMorphTargetElement } = await freshModule()
    const cardA = document.createElement('h3')
    cardA.dataset['vacancyMorphSlug'] = 'role-a'
    document.body.append(cardA)

    expect(findMorphTargetElement('role-missing')).toBeNull()
  })
})

describe('playTitleMorphOverlay', () => {
  it('hides the destination, appends an overlay at the source position, animates to the destination, then cleans up', async () => {
    const { playTitleMorphOverlay } = await freshModule()
    const { DUR_TITLE_MORPH, EASE_SOFT } = await import('@/lib/motion')

    const dest = document.createElement('h1')
    dest.textContent = 'Senior ML Engineer'
    document.body.append(dest)
    stubMeasurements(dest, { left: 40, top: 60, fontSize: '32px' })

    const morph = {
      slug: 'senior-ml-engineer',
      text: 'Senior ML Engineer',
      rect: { left: 10, top: 20 } as DOMRect,
      fontSizePx: 16,
      lineHeightPx: 24,
    }

    playTitleMorphOverlay(morph, dest)

    // Destination hidden but still in the layout flow (visibility, not display:none).
    expect(dest.style.visibility).toBe('hidden')

    // Overlay appended to <body>, positioned/scaled to match the source exactly (no animation yet).
    const overlay = document.body.querySelector('div[aria-hidden="true"]')
    expect(overlay).toBeTruthy()
    expect(overlay?.textContent).toBe('Senior ML Engineer')
    expect((overlay as HTMLElement).style.pointerEvents).toBe('none')

    expect(animateMock).toHaveBeenCalledTimes(1)
    const [target, keyframes, options] = animateMock.mock.calls[0] as [
      HTMLElement,
      { transform: string[] },
      { duration: number; ease: unknown },
    ]
    expect(target).toBe(overlay)
    expect(keyframes.transform[0]).toBe('translate(10px, 20px) scale(1)')
    // destFontSizePx (32) / morph.fontSizePx (16) = scale(2).
    expect(keyframes.transform[1]).toBe('translate(40px, 60px) scale(2)')
    expect(options.duration).toBe(DUR_TITLE_MORPH)
    expect(options.ease).toBe(EASE_SOFT)

    // Completion — overlay removed, destination visible again.
    controlsQueue[0]!.resolve()
    await controlsQueue[0]!.then(() => undefined)

    expect(document.body.querySelector('div[aria-hidden="true"]')).toBeNull()
    expect(dest.style.visibility).toBe('')
  })
})
