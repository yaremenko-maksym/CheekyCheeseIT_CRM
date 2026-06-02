# task-fix-invoice-pdf-polish — progress

current_milestone: 4/4 (done)
last_commit: aa6e5ae fix(invoices): polish PDF
last_push: (pending)
files_done:

- apps/api/src/invoices/invoice-pdf.service.ts (drawBrandMark flat + drop addr + amount layout)
- apps/api/src/assets/brand/wedge-logo.svg (sync to flat geometry)
  files_pending: []

milestones:

1. [x] drawBrandMark — flat variant (filled wedge, punched holes)
2. [x] ИСПОЛНИТЕЛЬ — only brand name, no address
3. [x] СУММА К ОПЛАТЕ — fit layout (18pt + tighter spacing)
4. [x] Verify locally — PDF generated, pdftoppm rendered, screenshot attached

verification:

- typecheck: green (api+web+shared)
- lint: 0 errors (2 pre-existing warnings in unrelated files)
- test (unit): 17/17 invoice-pdf, 12/12 invoices.service
- web build: green (2.3 MB bundle)
- e2e: 554 passed, 10 failed (all pre-existing on origin/main —
  drop-archive-real, drop-archive-user-real, etc. — no overlap
  with invoice PDF code paths)
- visual: /tmp/test-invoice-fixed.pdf rendered, pdftoppm screenshot
  confirms (a) header icon matches BrandMark flat variant,
  (b) Исполнитель shows only "CheekyCheeseIT", (c) "1 000.00 USDT"
  @ 18pt fits with full signatures + QR + footer visible
