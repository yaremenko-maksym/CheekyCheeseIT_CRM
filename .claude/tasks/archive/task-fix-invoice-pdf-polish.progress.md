# task-fix-invoice-pdf-polish — progress

current_milestone: 5/5 (done — round 2 user-feedback fixes)
last_commit: (pending — final round 2)
last_push: (pending)
files_done:

- apps/api/src/invoices/invoice-pdf.service.ts
  - round 1: drawBrandMark flat (drawRectangle approx) + drop addr + amount 22pt→18pt
  - round 2: drawBrandMark exact (drawSvgPath wedge path + arc circles + rounded pill) +
    symmetric СУММА К ОПЛАТЕ block (4pt top-padding added / 22pt → 20pt advance below
    amount / 4pt → 6pt before separator → both visual gaps now equal 20pt)
- apps/api/src/assets/brand/wedge-logo.svg (round 1 — sync to flat geometry, unchanged in round 2)
- verify-invoice-pdf-round2.png (full PDF render after round 2 fixes)
- verify-brandmark-side-by-side-round2.png (PDF icon vs frontend BrandMark — visual match)
- verify-amount-before-after-round2.png (round 1 vs round 2 amount block comparison)

milestones:

1. [x] drawBrandMark — flat variant (round 1: drawRectangle approx — flagged by user)
2. [x] ИСПОЛНИТЕЛЬ — only brand name, no address
3. [x] СУММА К ОПЛАТЕ — fit layout (round 1: 18pt + tighter — flagged for asymmetry)
4. [x] Verify locally — PDF generated, pdftoppm rendered, screenshot attached (round 1)
5. [x] **Round 2 fixes**:
   - drawBrandMark — EXACT BrandMark flat via pdf-lib `drawSvgPath` (wedge path + arc-
     based circles + rounded pill path), no more rectangle approx
   - СУММА К ОПЛАТЕ — symmetric padding (~20pt above + ~20pt below the amount glyph)
   - Visual verification: side-by-side montage of PDF icon vs frontend BrandMark flat
     confirms identical silhouette + chevron pattern

verification:

- typecheck: green (api+web+shared) — pnpm typecheck
- lint: 0 errors (2 pre-existing warnings in teams.drop.spec.ts + users.controller.ts)
  - eslint MCP on invoice-pdf.service.ts: 0 errors, 0 warnings
- test (unit, all workspaces): 417/417 API + 129/129 web + 127/127 shared = 673/673 ✓
  - invoice-pdf.service.spec.ts: 17/17 ✓ (hash determinism + cyrillic glyphs + signatures)
- web build: green (2.3 MB bundle, no new warnings)
- e2e: pre-existing failures noted in round 1 still apply (no overlap with PDF render path —
  E2E does NOT introspect PDF bytes, verified via ast-grep find on `drawBrandMark` /
  `pdfBuffer` in apps/e2e/ → 0 matches)
- visual: /tmp/invoice-round2.pdf rendered via pdftoppm @ 144 dpi:
  - PDF icon vs frontend BrandMark flat: visually identical (side-by-side montage)
  - СУММА К ОПЛАТЕ block: top & bottom optical padding equal — amount glyph centred
  - No regressions: header + Исполнитель + signatures + QR + footer all intact
