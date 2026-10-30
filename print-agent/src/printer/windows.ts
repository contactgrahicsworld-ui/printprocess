/**
 * Real Windows backend: PowerShell (CIM/WMI + PrintManagement + .NET) and SumatraPDF.
 * This file is only exercised on Windows (CI windows-latest smoke tests + shop PC).
 */
import { spawn } from 'node:child_process';
import type { PrinterInfo } from '../types.js';
import type { PrintedEvent, PrinterBackend, SpoolerJob, SubmitRequest, SubmitResult } from './backend.js';
import { parsePrinters, parsePrintedEvents, parseSpoolerJobs } from './psParse.js';
import { buildSumatraArgs } from '../sumatra.js';

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
`;

/** One record per printer. Parameters arrive via environment variables (never interpolated). */
export const WINDOWS_LIST_PRINTERS_SCRIPT = `${PS_PRELUDE}
$filter = $env:MPA_PRINTER
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
$msft = @{}
try { Get-Printer -ErrorAction Stop | ForEach-Object { $msft[$_.Name] = $_ } } catch { }
$out = New-Object System.Collections.ArrayList
foreach ($p in @(Get-CimInstance -ClassName Win32_Printer)) {
  if ($filter -and $p.Name -ne $filter) { continue }
  $m = $msft[$p.Name]
  $netColor = $null; $netDuplex = $null; $netPapers = @()
  try {
    $ps = New-Object System.Drawing.Printing.PrinterSettings
    $ps.PrinterName = $p.Name
    if ($ps.IsValid) {
      $netColor = [bool]$ps.SupportsColor
      $netDuplex = [bool]$ps.CanDuplex
      $netPapers = @($ps.PaperSizes | ForEach-Object { [string]$_.PaperName })
    }
  } catch { }
  $rec = [ordered]@{
    Name = [string]$p.Name
    Default = [bool]$p.Default
    WorkOffline = [bool]$p.WorkOffline
    PrinterStatus = [int]$p.PrinterStatus
    DetectedErrorState = [int]$p.DetectedErrorState
    ExtendedPrinterStatus = [int]$p.ExtendedPrinterStatus
    MsftPrinterStatus = $(if ($m) { [int]$m.PrinterStatus } else { $null })
    Capabilities = @($p.Capabilities | ForEach-Object { [int]$_ })
    CapabilityDescriptions = @($p.CapabilityDescriptions | ForEach-Object { [string]$_ })
    PrinterPaperNames = @($p.PrinterPaperNames | ForEach-Object { [string]$_ })
    PaperSizesSupported = @($p.PaperSizesSupported | ForEach-Object { [int]$_ })
    NetSupportsColor = $netColor
    NetCanDuplex = $netDuplex
    NetPaperNames = $netPapers
    DriverName = [string]$p.DriverName
    PortName = [string]$p.PortName
  }
  [void]$out.Add([pscustomobject]$rec)
}
ConvertTo-Json -InputObject @($out) -Depth 5 -Compress
`;

export const WINDOWS_LIST_JOBS_SCRIPT = `${PS_PRELUDE}
$printer = $env:MPA_PRINTER
$out = New-Object System.Collections.ArrayList
foreach ($j in @(Get-CimInstance -ClassName Win32_PrintJob)) {
  $n = [string]$j.Name
  $idx = $n.LastIndexOf(',')
  if ($idx -lt 0) { continue }
  if ($n.Substring(0, $idx).Trim() -ne $printer) { continue }
  $sub = $null
  if ($j.TimeSubmitted) { $sub = ([DateTimeOffset]$j.TimeSubmitted).ToUnixTimeMilliseconds() }
  [void]$out.Add([pscustomobject][ordered]@{
    JobId = [int]$j.JobId
    Name = $n
    PrinterName = $printer
    Document = [string]$j.Document
    StatusMask = [int]$j.StatusMask
    JobStatus = [string]$j.JobStatus
    Status = [string]$j.Status
    TotalPages = [int]$j.TotalPages
    PagesPrinted = [int]$j.PagesPrinted
    Submitted = $sub
  })
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`;

export const WINDOWS_EVENT_307_SCRIPT = `${PS_PRELUDE}
$since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:MPA_SINCE).LocalDateTime
$out = New-Object System.Collections.ArrayList
try {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PrintService/Operational'; Id = 307; StartTime = $since } -ErrorAction Stop)
} catch { $events = @() }
foreach ($e in $events) {
  $p = $e.Properties
  [void]$out.Add([pscustomobject][ordered]@{
    JobId = $(if ($p.Count -gt 0) { [int]$p[0].Value } else { $null })
    Document = $(if ($p.Count -gt 1) { [string]$p[1].Value } else { '' })
    Printer = $(if ($p.Count -gt 4) { [string]$p[4].Value } else { '' })
    Pages = $(if ($p.Count -gt 7) { [int]$p[7].Value } else { $null })
    TimeCreated = ([DateTimeOffset]$e.TimeCreated).ToUnixTimeMilliseconds()
  })
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`;

/** DPAPI LocalMachine scope: setup may run as an admin user while the service runs as LocalSystem. */
export const WINDOWS_PROTECT_SCRIPT = `${PS_PRELUDE}
Add-Type -AssemblyName System.Security
$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:MPA_SECRET)
$entropy = [System.Text.Encoding]::UTF8.GetBytes('MansaPrintAgent/v1')
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;

export const WINDOWS_UNPROTECT_SCRIPT = `${PS_PRELUDE}
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String($env:MPA_SECRET)
$entropy = [System.Text.Encoding]::UTF8.GetBytes('MansaPrintAgent/v1')
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $entropy, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
`;

export const WINDOWS_SPOOLER_SCRIPT = `${PS_PRELUDE}
$s = Get-Service -Name Spooler -ErrorAction SilentlyContinue
if ($s) { [Console]::Out.Write([string]$s.Status) } else { [Console]::Out.Write('Missing') }
`;

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runProcess(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string }): Promise<ProcResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, windowsHide: true, shell: false });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on('error', (e) => {
      stderr += String(e);
      done(null);
    });
    child.on('close', (code) => done(code));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export function encodePsCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export class PowerShellError extends Error {}

export interface WindowsBackendOptions {
  sumatraPath: string;
  powershellPath?: string;
  psTimeoutMs?: number;
}

export class WindowsPrinterBackend implements PrinterBackend {
  readonly kind = 'windows';
  private readonly ps: string;
  private readonly psTimeout: number;

  constructor(private readonly opts: WindowsBackendOptions) {
    this.ps = opts.powershellPath ?? 'powershell.exe';
    this.psTimeout = opts.psTimeoutMs ?? 30000;
  }

  async runPs(script: string, env: Record<string, string> = {}): Promise<string> {
    const r = await runProcess(this.ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePsCommand(script)], {
      env,
      timeoutMs: this.psTimeout,
    });
    if (r.timedOut) throw new PowerShellError(`PowerShell timed out after ${this.psTimeout}ms`);
    if (r.code !== 0) throw new PowerShellError(`PowerShell exited ${String(r.code)}: ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  }

  async listPrinters(): Promise<PrinterInfo[]> {
    return parsePrinters(await this.runPs(WINDOWS_LIST_PRINTERS_SCRIPT, { MPA_PRINTER: '' }));
  }

  async getPrinter(name: string): Promise<PrinterInfo | null> {
    const list = parsePrinters(await this.runPs(WINDOWS_LIST_PRINTERS_SCRIPT, { MPA_PRINTER: name }));
    return list.find((p) => p.name === name) ?? null;
  }

  async listSpoolerJobs(printerName: string): Promise<SpoolerJob[]> {
    return parseSpoolerJobs(await this.runPs(WINDOWS_LIST_JOBS_SCRIPT, { MPA_PRINTER: printerName }), printerName);
  }

  async submitPdf(req: SubmitRequest): Promise<SubmitResult> {
    const args = buildSumatraArgs(req.printerName, req.printSettings, req.filePath);
    const r = await runProcess(this.opts.sumatraPath, args, { timeoutMs: req.timeoutMs });
    return { exitCode: r.code, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr };
  }

  async readPrintedEvents(sinceMs: number): Promise<PrintedEvent[]> {
    try {
      return parsePrintedEvents(await this.runPs(WINDOWS_EVENT_307_SCRIPT, { MPA_SINCE: String(Math.floor(sinceMs)) }));
    } catch {
      return [];
    }
  }

  async protectSecret(plain: string): Promise<string> {
    return (await this.runPs(WINDOWS_PROTECT_SCRIPT, { MPA_SECRET: plain })).trim();
  }

  async unprotectSecret(blob: string): Promise<string> {
    return await this.runPs(WINDOWS_UNPROTECT_SCRIPT, { MPA_SECRET: blob });
  }

  async restrictPath(path: string, isDir: boolean): Promise<void> {
    // Remove inherited ACEs, grant Full Control to SYSTEM and Administrators only (SIDs: locale independent).
    const grant = isDir ? ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'] : ['*S-1-5-18:F', '*S-1-5-32-544:F'];
    const r = await runProcess('icacls.exe', [path, '/inheritance:r', '/grant:r', ...grant], { timeoutMs: 15000 });
    if (r.code !== 0) throw new Error(`icacls failed (${String(r.code)}): ${r.stdout} ${r.stderr}`);
  }

  async isSpoolerRunning(): Promise<boolean | null> {
    try {
      const s = (await this.runPs(WINDOWS_SPOOLER_SCRIPT)).trim();
      if (s === 'Missing') return null;
      return s === 'Running';
    } catch {
      return null;
    }
  }

  async powershellVersion(): Promise<string | null> {
    try {
      return (await this.runPs(`${PS_PRELUDE}\n[Console]::Out.Write($PSVersionTable.PSVersion.ToString())`)).trim();
    } catch {
      return null;
    }
  }
}
