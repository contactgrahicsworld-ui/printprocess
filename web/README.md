# Mansa Printer — QR-to-Print web app

Next.js 16 (App Router, TypeScript strict) + Supabase (Postgres, Auth, private Storage, Realtime).
Customers scan the shop QR, upload PDF/JPG/PNG, choose print settings, see a live server-side estimate and submit;
staff review, send jobs to the Windows Print Agent (see `../CONTRACT.md`), verify, take payment and issue receipts.

- Run locally without any cloud account: `cp .env.development.local.example .env.development.local && npm install && npm run dev:local`
  → portal `http://localhost:3000/s/dev-qr-token-mansa-0001`, admin `http://localhost:3000/admin/login`.
- Tests: `npm test` (unit + integration on PGlite with the real migrations), `npm run test:e2e` (Playwright/Firefox).
- Docs: `../docs/DEPLOYMENT.md`, `../docs/ARCHITECTURE.md`, `../docs/SECURITY.md`, `../docs/PRICING.md`, `../docs/TEST_RESULTS.md`.
