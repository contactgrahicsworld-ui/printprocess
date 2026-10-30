# Mansa Print Agent — Installation (Windows 10 / 11)

The print agent runs on the shop PC that is connected to the printers. It signs every request to the web
app (HMAC, see `CONTRACT.md`), claims approved print jobs, downloads the file, checks the SHA-256, prints
it through the Windows spooler with SumatraPDF, and reports the spooler result back to the dashboard.

> **The agent never marks a job "printed".** It reports `COMPLETED_SPOOLER` when Windows says the job
> left the queue without errors. A staff member must still check the paper and click **Verify printed**
> in the dashboard.

> **Hardware status:** everything below was written and checked against the code. It has **not** been run
> on a real shop PC with a real printer yet, because the build sandbox has no Windows machine and no
> printer. Do the steps in `PRINT_AGENT_VERIFY.md` on the shop PC before you rely on it.

---

## 0. What you need

| Item | Notes |
|---|---|
| Windows 10 (21H2+) or Windows 11, 64-bit | Administrator account needed for installation |
| Printer(s) installed with the **manufacturer's driver** | Not the generic "Microsoft IPP Class Driver" if you need duplex or colour control |
| Agent ID and secret | Dashboard → Settings → Print agents → **Add agent**. The secret is shown **once**: copy it straight into setup (step 3) |
| Internet access to the web app over HTTPS (port 443, outgoing) | No incoming ports are needed |
| Release bundle `MansaPrintAgent-win-x64` | GitHub Actions artifact from workflow `print-agent`: `MansaPrintAgent.exe`, `.sha256`, `SumatraPDF.exe`, `MansaPrintAgentService.exe` (WinSW), `*.ps1` scripts |

## 1. Copy the files

1. Open **PowerShell as Administrator** (Start → type *PowerShell* → right-click → *Run as administrator*).
2. Create the folder and copy the bundle into it:
   ```powershell
   New-Item -ItemType Directory -Force "C:\Program Files\MansaPrintAgent"
   Copy-Item "$HOME\Downloads\MansaPrintAgent-win-x64\*" "C:\Program Files\MansaPrintAgent\"
   cd "C:\Program Files\MansaPrintAgent"
   ```
3. Check the executable's hash against the `.sha256` file:
   ```powershell
   (Get-FileHash .\MansaPrintAgent.exe -Algorithm SHA256).Hash.ToLower()
   Get-Content .\MansaPrintAgent.exe.sha256
   ```
   The two values must match. If they don't, stop and download the bundle again.
4. Windows SmartScreen may warn about an unsigned app the first time. Choose *More info → Run anyway*.
   The exe is a Node.js single-executable app. Its embedded Node signature is no longer valid after
   packaging, which is expected. Code-signing it with the shop's own certificate is optional.

## 2. SumatraPDF (the PDF printing engine)

The bundle already includes `SumatraPDF.exe` 3.5.2 (portable), checked by hash in CI. To download it yourself:

```powershell
powershell -ExecutionPolicy Bypass -File .\download-tools.ps1
```

The script downloads `SumatraPDF-3.5.2-64.zip` from sumatrapdfreader.org and WinSW 2.12.0 from GitHub. It
checks these SHA-256 values and refuses any file that doesn't match:

| File | SHA-256 |
|---|---|
| SumatraPDF-3.5.2-64.zip | `66ccb395c9184dce6822dfbb9970c877383b3ead6d9417b5106a844aac512989` |
| SumatraPDF-3.5.2-64.exe (→ `SumatraPDF.exe`) | `290e4aa7ed64c728138711c011e89aab7aa48dbc1ae430371dc2be4100b92bf0` |
| WinSW-x64.exe 2.12.0 (→ `MansaPrintAgentService.exe`) | `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da` |

Do **not** install SumatraPDF as the default PDF viewer. The agent only calls it from the command line:
`SumatraPDF.exe -print-to "<printer>" -print-settings "<pages>,<n>x,duplexlong|simplex,color|monochrome,paper=A4" -silent -exit-when-done <file>`

## 3. Run setup

```powershell
cd "C:\Program Files\MansaPrintAgent"
.\MansaPrintAgent.exe setup
```

Setup asks for:
- **Server URL**: for example `https://print.mansaprinter.in`. Only `https://` is accepted.
- **Agent ID**: from the dashboard.
- **Agent secret**: typing is hidden. Paste it and press Enter.
- **Default printer**: used for jobs that don't name a printer. Pick a number from the list.

Setup then:
- encrypts the secret with **Windows DPAPI (LocalMachine scope + entropy)** and stores only the encrypted
  value (`secretProtected`) in `C:\ProgramData\MansaPrintAgent\config.json`. The plain secret is never written.
- sets the ACL of `C:\ProgramData\MansaPrintAgent` and `config.json` to **SYSTEM + Administrators only**.
- sends one signed heartbeat to prove the URL, agent ID, secret and clock are right.

Non-interactive setup (for scripted installs), with the secret passed in an environment variable:
```powershell
$env:MPA_SECRET = '<secret>'
.\MansaPrintAgent.exe setup --server-url https://print.mansaprinter.in --agent-id <uuid> --secret-env MPA_SECRET --printer "HP LaserJet M1136 MFP" --allow "HP LaserJet M1136 MFP" --allow "EPSON L3150 Series"
Remove-Item Env:\MPA_SECRET
```

### Config reference (`C:\ProgramData\MansaPrintAgent\config.json`)

| Key | Default | Meaning |
|---|---|---|
| `serverUrl`, `agentId`, `secretProtected` | (from setup) | Server connection. `secret` (plain) is only for development and is never written by setup |
| `printerAllowlist` | `[]` (all) | Only these printers are advertised and used |
| `defaultPrinter` | `null` | Used when a job has `printerName: null`. If unset, the Windows default printer is used |
| `printerOverrides` | `{}` | Fix a driver that misreports, e.g. `{"EPSON L3150 Series":{"paperSizes":["A4","Legal"]}}` |
| `sumatraPath` | `C:\Program Files\MansaPrintAgent\SumatraPDF.exe` | |
| `sumatraSha256` | `null` | Recommended: pin `290e4aa7…92bf0` so a swapped binary is refused |
| `sumatraScaling` | `"shrink"` | `noscale` / `shrink` / `fit` |
| `logDir`, `dataDir`, `tempDir` | under `C:\ProgramData\MansaPrintAgent\` | |
| `keepTempHours` | `0` | Hours to keep downloaded files after the final status (for reprint debugging) |
| `heartbeatIntervalMs` / `claimIntervalMs` / `spoolerPollMs` | 30000 / 5000 / 2000 | |
| `notObservedTimeoutMs` | 60000 | If a job is never seen in the queue within this time → `ERROR "not observed in spooler"` |
| `maxPrinterWaitMs` | 900000 (15 min) | How long a job waits for an offline or paper-out printer **before** submit. After that, a final `PRINTER_OFFLINE` / `PAPER_OUT` / `ERROR` is sent and the job is not printed |
| `monitorTimeoutMs` | 4 h | A job stuck in the queue longer than this → `ERROR` |
| `eventLog307` | `"off"` | `confirm` / `require`: use Event 307 as evidence that the job printed (see 6.3) |
| `allowInsecureLocalhost` | `false` | Development only: allows `http://localhost` |

Edit the file in an **elevated** Notepad, then restart the service: `Restart-Service MansaPrintAgent`.

## 4. Check before installing the service

```powershell
.\MansaPrintAgent.exe doctor
.\MansaPrintAgent.exe list-printers
.\MansaPrintAgent.exe test-print "HP LaserJet M1136 MFP"
```
- `doctor` checks Windows, PowerShell, that the Print Spooler service is running, SumatraPDF (path and
  hash), the config, that the secret decrypts, the printers, the PrintService event log, server
  connectivity, the HMAC signature, and clock skew.
- `test-print` prints **one real page** (with a timestamp) and follows it through the spooler:
  `SUBMITTED → SPOOLED → PRINTING → COMPLETED_SPOOLER`. Options: `--color`, `--duplex`, `--paper A3`.

Fix every `[FAIL]` before going on.

## 5. Install as a Windows service (auto-start)

```powershell
powershell -ExecutionPolicy Bypass -File .\install-service.ps1
```
- Uses **WinSW** (`MansaPrintAgentService.exe` + generated `MansaPrintAgentService.xml`) to run
  `MansaPrintAgent.exe run` as service **MansaPrintAgent**.
- Start type is **Automatic**. Add `-DelayedStart` for *Automatic (Delayed Start)*.
- Depends on the **Spooler** service. Restarts on failure after 10 s, 30 s and 60 s (set in WinSW and in `sc.exe failure`).
- Logs go to `C:\ProgramData\MansaPrintAgent\logs\`: `agent.log` (JSON lines, rotates at 5 MB, keeps 10 files) and the WinSW wrapper logs.
- To use NSSM instead: `.\install-service.ps1 -Wrapper NSSM -NssmPath C:\tools\nssm.exe` (get NSSM 2.24 from nssm.cc yourself and check its hash).

**Service account.** The service runs as **LocalSystem** by default. LocalSystem sees printers that were
installed **for all users**: local USB printers and TCP/IP-port printers added via *Add a printer*. It
does **not** see per-user network connections such as `\\server\printer`. If `list-printers` run as the
service doesn't show your printer, either reinstall the printer as a local TCP/IP printer, or run the
service as the shop user:
`.\install-service.ps1 -ServiceUser ".\ShopUser"` (asks for that user's password).

Manage the service:
```powershell
Get-Service MansaPrintAgent
Restart-Service MansaPrintAgent
Get-Content C:\ProgramData\MansaPrintAgent\logs\agent.log -Tail 50 -Wait
```
To uninstall: `.\uninstall-service.ps1` (add `-RemoveData` to also delete config, job log and logs).

## 6. Windows and printer settings

### 6.1 Firewall / network
- No inbound rules are needed. The agent only makes **outgoing HTTPS (TCP 443)** connections to the web
  app and to the storage host in the signed download URLs (Supabase Storage).
- If Windows Defender Firewall has outbound filtering on, or a third-party firewall prompts, allow
  `C:\Program Files\MansaPrintAgent\MansaPrintAgent.exe`:
  ```powershell
  New-NetFirewallRule -DisplayName "Mansa Print Agent (HTTPS out)" -Direction Outbound -Program "C:\Program Files\MansaPrintAgent\MansaPrintAgent.exe" -Protocol TCP -RemotePort 443 -Action Allow
  ```
- Keep Windows time sync on, because the server rejects requests more than 5 minutes off: `w32tm /resync`.
  The agent also corrects small skews using the server time from each heartbeat.
- If the internet drops, the agent keeps printing jobs it already has. Status updates are queued on disk
  (`data\outbox.jsonl`) and sent in order when the connection is back.

### 6.2 Printer driver: duplex, colour and paper
The agent reads each printer's real capabilities from the driver (`System.Drawing.Printing.PrinterSettings`
+ `Win32_Printer`). It **refuses** a job the printer can't do exactly (it never silently downgrades):
- **Duplex:** Control Panel → Devices and Printers → right-click the printer → *Printer properties* →
  *Device Settings* (or *Configuration*) → set **Duplex Unit / Automatic duplexing: Installed**. If this
  is "Not installed", `DOUBLE` jobs fail with `ERROR capability mismatch … no duplex`.
- **Colour:** a monochrome laser printer (e.g. HP M1136) reports no colour support, so `COLOR` jobs to
  it fail. Send colour jobs to the colour printer (e.g. Epson L3150).
- **Paper:** make sure A4 / A3 / Legal appear in *Printing preferences → Paper size* for printers that
  should take them. `list-printers` shows what the agent sees.
- If a driver misreports, set `printerOverrides` in the config instead of changing job settings.
- Network printers: turn on **SNMP status** on the printer's port (*Printer properties → Ports → Configure
  Port → SNMP Status Enabled*). Without it, Windows may report "Normal" for a printer that is switched off.

### 6.3 Optional: printed confirmation from the Windows event log (Event 307)
```powershell
wevtutil sl Microsoft-Windows-PrintService/Operational /e:true
```
Then set `"eventLog307": "confirm"` (or `"require"`) in the config. Windows 10/11 hide document names in
event 307 by default, so the agent matches on spooler job ID + printer. To show names as well, enable the
group policy *Computer Configuration → Administrative Templates → Printers → Allow job name in event logs*.

**Also recommended:** printer properties → *Advanced* → tick **Keep printed documents**. Finished jobs then
stay in the queue marked *Printed*, so the agent can see them complete even when a short job finishes
between two 2-second polls.

## 7. Files and folders

| Path | Contents |
|---|---|
| `C:\Program Files\MansaPrintAgent\` | `MansaPrintAgent.exe`, `SumatraPDF.exe`, WinSW wrapper + xml, scripts |
| `C:\ProgramData\MansaPrintAgent\config.json` | Config (DPAPI-protected secret, ACL SYSTEM+Administrators) |
| `C:\ProgramData\MansaPrintAgent\data\jobs.jsonl` | Durable job log keyed by jobId+attempt (written with fsync, used for duplicate prevention) |
| `C:\ProgramData\MansaPrintAgent\data\outbox.jsonl` | Status updates waiting to be sent |
| `C:\ProgramData\MansaPrintAgent\data\agent.lock` | Single-instance lock |
| `C:\ProgramData\MansaPrintAgent\tmp\` | Downloaded files (ACL-restricted). Deleted after the final status unless `keepTempHours` > 0 |
| `C:\ProgramData\MansaPrintAgent\logs\agent.log` | Rotating JSON-lines log of every job event |

## 8. Updating

```powershell
Stop-Service MansaPrintAgent
Copy-Item .\new\MansaPrintAgent.exe "C:\Program Files\MansaPrintAgent\MansaPrintAgent.exe" -Force
Start-Service MansaPrintAgent
```
Jobs that were in the spooler when the service stopped are looked up again on start and are never
resubmitted (see `PRINT_AGENT_VERIFY.md`, test 6).

## 9. Building from source

- CI: `.github/workflows/print-agent.yml` runs on `ubuntu-latest` (unit + flow tests) and `windows-latest`
  (tests including the real-PowerShell integration test, PowerShell script parsing, the
  `MansaPrintAgent.exe` build, exe smoke test, hash-checked SumatraPDF/WinSW download). It uploads
  the artifact `MansaPrintAgent-win-x64`.
- Locally: `cd print-agent && npm ci && npm test && npm run build:exe` → `build/MansaPrintAgent.exe`.
  This works on Linux too: it downloads the matching official `node.exe`, checks it against nodejs.org
  `SHASUMS256.txt`, and injects the bundle with postject.
