# Mansa Print Agent (Windows)

Node 20+/TypeScript agent that claims print jobs from the Mansa Printer web app (contract:
`../CONTRACT.md`), verifies files, prints them through the Windows spooler with SumatraPDF, and reports
spooler states. It is shipped as `MansaPrintAgent.exe` (Node single-executable app, win-x64) and runs as a
Windows service (WinSW or NSSM).

- Install: `../docs/PRINT_AGENT_INSTALL.md`
- Hardware verification (must be done on the shop PC): `../docs/PRINT_AGENT_VERIFY.md`

## Layout
```
src/
  main.ts / cli.ts      CLI: run | setup | list-printers | test-print <printer> | doctor | version
  agent.ts              claim/heartbeat loops, job pipeline, duplicate prevention, reconciliation, temp cleanup
  monitor.ts            spooler polling → SPOOLED/PRINTING/PAPER_OUT/…/COMPLETED_SPOOLER decision rules
  apiClient.ts hmac.ts  HMAC-SHA256 signed HTTPS client (CONTRACT), clock-offset correction
  outbox.ts             durable ordered status queue (replayed after network loss)
  jobLog.ts jsonl.ts    fsync'd JSON-lines job log keyed by jobId+attempt (SUBMITTING marker before spooler)
  download.ts           streaming download, sha256, magic bytes, mime consistency
  pdf.ts                image→PDF (fit, centred), page count, test page
  sumatra.ts            -print-settings builder / argv
  pageRanges.ts         range parsing/merging + CONTRACT sheet calculation
  capability.ts         colour/duplex/paper checks (no silent downgrade), printer overrides
  config.ts lock.ts logger.ts
  printer/backend.ts    PrinterBackend interface (all Windows calls behind it)
  printer/windows.ts    REAL backend: PowerShell (Win32_Printer, Get-Printer, .NET PrinterSettings,
                        Win32_PrintJob, Get-WinEvent 307, DPAPI, icacls) + SumatraPDF
  printer/psParse.ts    ConvertTo-Json parsers (single-object/array/{value,Count}/enum/date quirks)
test/                   Vitest; FakeBackend + MockServer (HMAC-verifying CONTRACT server) used ONLY here
scripts/                bundle.mjs, build-sea.mjs, download-tools.ps1, install-service.ps1, uninstall-service.ps1
```

## Develop
```
npm ci
npm run typecheck
npm test             # Linux: fake spooler; Windows: also runs test/windows.integration.test.ts
npm run build:exe    # → build/MansaPrintAgent.exe (cross-builds from Linux too)
```
