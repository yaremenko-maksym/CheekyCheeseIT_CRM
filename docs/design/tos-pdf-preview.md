# Design spec: ToS PDF Preview (Tier 2)

**Slug:** `tos-pdf-preview`  
**Date:** 2026-07-11  
**Design tier:** 2 (правка существующего экрана — ToS admin editor right pane)  
**Routes affected:** `/admin/tos`, `/admin/tos/new`

---

## Brief

The ToS admin page previously showed a `<ReactMarkdown>` HTML render in the right split-view pane and in the "Предпросмотр" modal. This is replaced with a **live PDF preview** — the exact document a user would receive — rendered via `POST /api/tos/preview-pdf`.

The design mirrors the existing `ContractPdfPreview` pattern: same toolbar style, same loading overlay, same error state, same iframe+object fallback. No new visual language is introduced — this is a conformance task (Tier 2), not a new design direction.

---

## Reference: existing ContractPdfPreview pattern

`apps/web/app/components/user-profile/contract/ContractPdfPreview.tsx` — used as the direct design model. The same toolbar (label + Refresh button), PDF viewer container with loading overlay, iframe with object fallback, and error state with Retry button.

---

## Token map (from `globals.css`)

| Purpose            | Token                   |
| ------------------ | ----------------------- |
| Toolbar background | `bg-muted/30`           |
| Container border   | `border-border/60`      |
| Muted text         | `text-muted-foreground` |
| Error icon         | `text-destructive/60`   |
| Viewer background  | `bg-muted/20`           |

All tokens are from the project design system. No raw hex values.

---

## Component structure

### `TosPdfPreview` (`apps/web/app/components/admin/TosPdfPreview.tsx`)

```
<div data-testid="tos-pdf-preview">          ← root, flex-col
  <div>                                       ← toolbar: label + Refresh button
    <span>PDF предпросмотр</span>
    <Button data-testid="tos-pdf-refresh-btn">Обновить</Button>
  </div>
  <div data-testid="tos-pdf-viewer">          ← PDF container, relative, min-h-[480px]
    <!-- loading overlay (absolute, z-10) — shows spinner + "Загрузка PDF…" -->
    <!-- iframe src={blobUrl} (hidden while iframeLoading) -->
    <!--   <object> fallback inside iframe for iOS Safari -->
    <!-- empty placeholder (FileText icon) when no content yet -->
    <!-- error state data-testid="tos-pdf-error" — AlertTriangle + Retry button -->
  </div>
</div>
```

### Integration points

| Location                    | Change                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tos.index.tsx` right pane  | `<ReactMarkdown>` → `<TosPdfPreview bodyMarkdown={displayedVersion.bodyMarkdown} />`                              |
| `tos.new.tsx` preview modal | `<ReactMarkdown remarkPlugins={[remarkGfm]}>` → `<TosPdfPreview bodyMarkdown={currentBody} className="h-full" />` |

---

## Behaviour spec

| State                                     | Visual                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `bodyMarkdown` empty                      | FileText icon placeholder (no API call)                                 |
| Debouncing (< 600ms after last keystroke) | Previous state shown (no spinner yet)                                   |
| Loading (API in-flight)                   | Spinner overlay + "Загрузка PDF…"                                       |
| Success                                   | iframe with PDF; loading overlay hidden                                 |
| Error (non-429)                           | AlertTriangle + "Не удалось загрузить PDF." + Retry button; toast shown |
| Error (429)                               | Same error state + toast "Слишком часто. Подождите минуту."             |

Debounce: **600 ms** after last `bodyMarkdown` change.  
Abort: in-flight requests cancelled on unmount and on new debounce fire.  
Memory: previous blob URL revoked before creating new one.

---

## Responsive behaviour

| Breakpoint    | Layout                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile (<640) | Single-column; `tos.index.tsx` split-view collapses (parent CSS `grid-cols-2` becomes single col via parent responsive classes — tracked separately in responsive pass) |
| Tablet+       | Split-view as designed: left = read-only CodeMirror, right = `TosPdfPreview`                                                                                            |
| All           | `min-h: 480px` on PDF viewer ensures usable height                                                                                                                      |

---

## A11y

- `<iframe>` has `title` and `aria-label` = "Предпросмотр Terms of Service"
- `<iframe>` has `tabIndex={0}` for keyboard reach
- Refresh button: `type="button"`, standard Button variant ghost — keyboard/focus accessible
- Error state: AlertTriangle icon is decorative (screen reader reads "Не удалось загрузить PDF.")

---

## Edge cases

| Case                       | Handling                                                 |
| -------------------------- | -------------------------------------------------------- |
| Empty markdown             | Skips API call; shows FileText placeholder               |
| Rapid keystrokes           | Debounce 600ms; previous in-flight request aborted       |
| 429 rate-limit             | Toast "Слишком часто. Подождите минуту." + error state   |
| Blob URL memory            | Previous URL revoked on each new load                    |
| iOS Safari (no PDF iframe) | `<object>` fallback with download link inside `<iframe>` |
| Very long ToS body         | Server-side pagination in `TosPdfService.ensureSpace()`  |

---

## Fidelity reference

No Claude Design generation was done (Tier 2 conformance — existing visual language reused verbatim from `ContractPdfPreview`). Fidelity-diff: compare `ContractPdfPreview` appearance at `/crm/team/<userId>` (contract tab) against `TosPdfPreview` at `/admin/tos` — toolbar style, container borders, loading overlay, error state must match visually.

`design-gate: tier-2-conformance` — no `design.png` artifact generated; fidelity assessed by conformance to existing `ContractPdfPreview` pattern.
