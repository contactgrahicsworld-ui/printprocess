# Mansa Print Agent — Hardware Verification Procedure

> ## ⚠️ STATUS: BLOCKED IN THE BUILD SANDBOX — MUST BE RUN ON THE SHOP PC
> The agent was built and tested in a Linux sandbox with **no Windows, no Print Spooler and no printer**.
> What *has* been verified: 75 automated tests (fake spooler + a mock server that checks HMAC), TypeScript
> typecheck, and a cross-built `MansaPrintAgent.exe` (Node SEA, win-x64). The CI workflow also runs the real
> PowerShell scripts on a GitHub `windows-latest` runner, which has no physical printer.
> **No page has ever been printed by this agent yet.** Do every test below on the shop PC with the real
> printers. Record the results in the table at the end before going live.

Do the tests in order. For each one, keep three windows open:
1. **Agent log:** `Get-Content C:\ProgramData\MansaPrintAgent\logs\agent.log -Tail 20 -Wait`
2. **Windows queue:** `Get-PrintJob -PrinterName "<printer>"` (or Settings → Printers → *Open print queue*)
3. **Dashboard:** the order's print job timeline (statuses + detail text)

Useful one-liners:
```powershell
$P = "HP LaserJet M1136 MFP"      # your printer name exactly as list-printers shows it
Get-PrintJob -PrinterName $P | Format-Table Id, DocumentName, JobStatus, PagesPrinted, TotalPages
Get-CimInstance Win32_PrintJob | Format-Table Name, Document, JobStatus, StatusMask, PagesPrinted, TotalPages
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-PrintService/Operational'; Id=307} -MaxEvents 5 | Format-List TimeCreated, Message
```

---

## Test 0: Preconditions
```powershell
cd "C:\Program Files\MansaPrintAgent"
.\MansaPrintAgent.exe doctor
.\MansaPrintAgent.exe list-printers
```
**Expected:** every line `[OK]` (a `[WARN]` for the event log is fine unless `eventLog307=require`).
`list-printers` shows each printer with `status: Normal` and the right `color`, `duplex` and `paper` values.
If duplex is `false` on a duplex printer, fix the driver's *Device Settings* (install guide §6.2) first.

## Test 1: Test page (spooler path only, no server)
```powershell
.\MansaPrintAgent.exe test-print $P
.\MansaPrintAgent.exe test-print $P --duplex          # duplex printers only
.\MansaPrintAgent.exe test-print "EPSON L3150 Series" --color
```
**Expected console output:** `SUBMITTED`, then `SPOOLED spoolerJobId=N`, `PRINTING`, then
`RESULT: COMPLETED_SPOOLER`. Exit code 0. The physical page shows the timestamp, a complete border and
grey swatches (colour swatches in colour on the colour printer).
If you get `RESULT: ERROR … not observed in spooler` but the page printed, the job left the queue in under
2 s. Enable **Keep printed documents** or `eventLog307: "confirm"` (install guide §6.3) and repeat.

## Test 2: Full order flow (happy path)
1. Install the service (install guide §5). Confirm in the dashboard that the agent shows a recent heartbeat and its printers.
2. On a phone, scan the shop QR, upload a **3-page PDF**, choose BW / SINGLE / A4 / 2 copies, and place the order.
3. In the dashboard, approve it and click **Send to printer** (choose `$P`).
4. Watch the timeline and the queue.

**Expected:** dashboard statuses in this order: `CLAIMED → DOWNLOADED → SUBMITTED → SPOOLED → PRINTING →
COMPLETED_SPOOLER`. The `DOWNLOADED` detail says `sha256 verified … selected=3; sheets=6; sides=6`.
`Get-PrintJob` briefly shows a document named `…MP_<orderNumber>_<jobId>.pdf`. 6 sheets come out. The order
does **not** become READY by itself. Click **Verify printed** after checking the pages, and only then is
the job `VERIFIED`. `C:\ProgramData\MansaPrintAgent\tmp\` is empty afterwards.

Repeat with: an image (JPG/PNG, A4, colour printer) → one page, image centred and scaled to fit; a
**page range** `1-2` on a 5-page PDF → 2 pages; **DOUBLE** on the duplex printer → printed on both sides
(long-edge binding); **A3** if you have an A3 printer.

## Test 3: Printer offline BEFORE submit
1. Switch the printer **off** (or unplug USB), or right-click it → *Use Printer Offline*.
   Run `list-printers` and confirm `status: Offline`. If it still says `Normal`, turn on SNMP status on the port (install guide §6.2).
2. Send a job from the dashboard.

**Expected:** `CLAIMED → DOWNLOADED` and then the job **waits**. The agent log shows
`printer_not_ready_waiting`. The dashboard's agent/printer panel shows the printer as `Offline` (sent by an
immediate heartbeat). Nothing appears in the Windows queue.
3a. Turn the printer back on within 15 minutes (`maxPrinterWaitMs`). The job prints with no extra action
    and goes `SUBMITTED → … → COMPLETED_SPOOLER`.
3b. Or keep it off for more than 15 minutes. The job goes to `PRINTER_OFFLINE` with the detail
    *"Job was NOT sent to the printer — safe to re-queue"*. The queue stays empty. Re-queue from the
    dashboard after fixing the printer → it prints **once**.

## Test 4: Paper out
**4a. Before submit:** remove all paper. Most drivers report `PaperOut` only after a failed attempt, so
first print anything to make the printer notice. When `list-printers` shows `PaperOut`, send a job.
**Expected:** same as Test 3 (waits, then final `PAPER_OUT` "NOT sent" after max wait, or prints once paper is loaded).

**4b. During the job:** send a 10-page job with only 2–3 sheets in the tray.
**Expected:** `SPOOLED → PRINTING → PAPER_OUT` (detail: *"Job is STILL in the Windows queue and may resume
when fixed — check … before re-queueing"*). Load paper; the remaining pages print. The final event is
`ERROR "… after spooler error state(s) [PaperOut] … completion NOT claimed — staff must check physical
output"`. It is **never** `COMPLETED_SPOOLER`. The staff member counts the pages and verifies or re-queues.

## Test 5: Duplicate prevention
1. Send a job. While it is `PRINTING`, run `Restart-Service MansaPrintAgent` (the server will hand the same job back on the next claim).
2. Separately: send a job and watch the log. Every 5 s the server returns the active job again, and the
   log shows `claim_duplicate_active` / `claim_duplicate_final`.

**Expected:** exactly **one** copy set comes out in both cases. `Get-PrintJob` never shows two documents
with the same `<jobId>`. `C:\ProgramData\MansaPrintAgent\data\jobs.jsonl` has exactly one
`"state":"SUBMITTING"` line for that job and attempt.
3. Try to start a second agent while the service is running: `.\MansaPrintAgent.exe run` →
   `ERROR: another agent instance is running (pid N)`.

## Test 6: Restart / crash mid-job (reconciliation)
1. Pause the printer (queue window → *Printer → Pause Printing*). Send a job and wait until it is `SPOOLED`.
2. `Stop-Process -Name MansaPrintAgent -Force` (simulated crash). The service restarts it within about 10 s.
3. The log shows `reconcile_in_flight`. Resume the printer.

**Expected:** the job is **not** submitted again. The agent finds it in the queue by document name /
spooler job ID and follows it to the end.
- If it is still in the queue: `PRINTING → COMPLETED_SPOOLER` (with Keep printed documents / Printed flag)
  or `ERROR "agent restarted … outcome during the gap is unknown — staff must verify physically"`.
  Without positive evidence the agent does not claim completion.
- If the agent crashed after writing `SUBMITTING` but the job never reached the queue:
  `ERROR "job not observed in spooler after agent restart … NOT resubmitted"`.

## Test 7: Network drop
1. Send a 10-page job. When it reaches `SUBMITTED`, **unplug the network cable** (or turn Wi-Fi off).
2. Let it finish printing. Wait 1 minute. Plug the network back in.

**Expected:** printing carries on offline. The log shows `network_offline` and `status_send_failed …
pending: N`, and `data\outbox.jsonl` grows. After reconnecting (within about 60 s, the maximum backoff)
the dashboard receives, **in order**, `SPOOLED → PRINTING → COMPLETED_SPOOLER` with the original event
times (`at`). Nothing prints twice. The log shows `network_online`.
3. Repeat with the network unplugged **before** sending: the job stays QUEUED on the server until the agent
   is back, then flows normally.

## Test 8: Integrity
In a staging setup, change a stored file's bytes (or its `sha256` in the DB) for a queued job.
**Expected:** `FAILED "file integrity check failed: sha256 mismatch …"`, nothing in the queue, temp file deleted.

## Test 9: Capability mismatch
Send `DOUBLE` to a simplex printer, `COLOR` to the mono laser, and `A3` to an A4-only printer.
**Expected:** `ERROR "capability mismatch: … Not printed (no silent downgrade)"` and nothing in the queue.

## Test 10: Cancel in the Windows queue
While a job is `SPOOLED`, delete it in the queue window. **Expected:** `FAILED "job was deleted/cancelled
from the Windows print queue"`.

---

## Expected results (fill in on the shop PC)

| # | Test | Expected final status (dashboard) | Pages out | Pass/Fail | Notes / date / tester |
|---|---|---|---|---|---|
| 0 | doctor / list-printers | all `[OK]` | 0 | | |
| 1 | test-print (mono / duplex / colour) | `RESULT: COMPLETED_SPOOLER` | 1 each | | |
| 2a | PDF 3 pages × 2 copies BW A4 | `COMPLETED_SPOOLER` → staff `VERIFIED` | 6 | | |
| 2b | Image on colour printer | `COMPLETED_SPOOLER` | 1 | | |
| 2c | Page range 1-2 of 5 | `COMPLETED_SPOOLER` | 2 | | |
| 2d | DOUBLE on duplex printer | `COMPLETED_SPOOLER` | sheets = ceil(pages/2)×copies | | |
| 3a | Offline then back < 15 min | `COMPLETED_SPOOLER` | 1× | | |
| 3b | Offline > 15 min | `PRINTER_OFFLINE` ("NOT sent") | 0 | | |
| 4a | Paper out before submit (> max wait) | `PAPER_OUT` ("NOT sent") | 0 | | |
| 4b | Paper out mid-job | `PAPER_OUT`, then event `ERROR` (never COMPLETED_SPOOLER) | partial → rest after refill | | |
| 5 | Restart during print / repeated claims | single set printed | 1× | | |
| 5c | Second instance | refused by lock | 0 | | |
| 6 | Crash while SPOOLED | not resubmitted; `COMPLETED_SPOOLER` or `ERROR (verify physically)` | 1× | | |
| 7 | Network drop during print | all statuses delivered in order after reconnect | 1× | | |
| 8 | SHA-256 mismatch | `FAILED` | 0 | | |
| 9 | Capability mismatch (duplex / colour / paper) | `ERROR` capability mismatch | 0 | | |
| 10 | Deleted from queue | `FAILED` | 0–partial | | |

Go live only when every row passes. Keep this filled-in table with the shop records.
